import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { S3Client, PutObjectCommand, ListObjectsV2Command, HeadBucketCommand } from '@aws-sdk/client-s3';
import archiver from 'archiver';
import { S3BackupCredentials } from './s3BackupSettings';

export interface BackupEntry {
    key: string;
    lastModified?: Date;
    size?: number;
}

export interface BackupResult {
    key: string;
    size: number;
}

function sanitizeFolderName(name: string): string {
    return name.replace(/[^a-zA-Z0-9_\-.]/g, '_').replace(/_{2,}/g, '_').replace(/^_|_$/g, '') || 'project';
}

function makeS3Client(creds: S3BackupCredentials): S3Client {
    return new S3Client({
        endpoint: creds.endpoint,
        region: 'us-east-1',
        credentials: {
            accessKeyId: creds.accessKeyId,
            secretAccessKey: creds.secretAccessKey,
        },
        forcePathStyle: true,
    });
}

export async function testS3Connection(creds: S3BackupCredentials): Promise<void> {
    const client = makeS3Client(creds);
    await client.send(new HeadBucketCommand({ Bucket: creds.bucket }));
}

export async function listProjectBackups(
    projectName: string,
    creds: S3BackupCredentials
): Promise<BackupEntry[]> {
    const client = makeS3Client(creds);
    const prefix = `${sanitizeFolderName(projectName)}/`;
    const result = await client.send(
        new ListObjectsV2Command({ Bucket: creds.bucket, Prefix: prefix })
    );
    return (result.Contents ?? [])
        .map((obj) => ({ key: obj.Key ?? '', lastModified: obj.LastModified, size: obj.Size }))
        .sort((a, b) => (b.lastModified?.getTime() ?? 0) - (a.lastModified?.getTime() ?? 0));
}

export async function backupProject(
    projectName: string,
    projectPath: string,
    creds: S3BackupCredentials,
    onProgress?: (message: string) => void
): Promise<BackupResult> {
    const sanitized = sanitizeFolderName(projectName);
    const stamp = new Date()
        .toISOString()
        .replace(/[:.]/g, '-')
        .replace('T', '_')
        .slice(0, 19);
    const s3Key = `${sanitized}/${stamp}.zip`;
    const tmpFile = path.join(os.tmpdir(), `uv-s3backup-${Date.now()}.zip`);

    onProgress?.(`Zipping ${projectName}…`);

    await new Promise<void>((resolve, reject) => {
        const output = fs.createWriteStream(tmpFile);
        const archive = archiver('zip', { zlib: { level: 6 } });
        output.on('close', resolve);
        archive.on('error', reject);
        archive.pipe(output);
        archive.directory(projectPath, false);
        archive.finalize();
    });

    const stats = fs.statSync(tmpFile);
    onProgress?.(`Uploading ${(stats.size / 1024 / 1024).toFixed(1)} MB to ${creds.bucket}…`);

    const client = makeS3Client(creds);
    const fileStream = fs.createReadStream(tmpFile);
    try {
        await client.send(
            new PutObjectCommand({
                Bucket: creds.bucket,
                Key: s3Key,
                Body: fileStream,
                ContentLength: stats.size,
                ContentType: 'application/zip',
            })
        );
    } finally {
        fileStream.destroy();
        try { fs.unlinkSync(tmpFile); } catch { /* ignore */ }
    }

    return { key: s3Key, size: stats.size };
}
