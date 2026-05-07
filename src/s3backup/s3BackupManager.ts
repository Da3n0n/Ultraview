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

function makeS3Client(creds: S3BackupCredentials, systemClockOffset = 0): S3Client {
    return new S3Client({
        endpoint: creds.endpoint,
        region: 'us-east-1',
        credentials: {
            accessKeyId: creds.accessKeyId,
            secretAccessKey: creds.secretAccessKey,
        },
        forcePathStyle: true,
        systemClockOffset,
    });
}

/** Parse ISO date strings out of an XML-like error body. */
function parseServerTimeFromError(e: unknown): number | null {
    try {
        const body: string =
            (e as any)?.$response?.body ||
            (e as any)?.message ||
            (e as any)?.Code ||
            '';
        // Look for <ServerTime>2026-05-07T12:34:56Z</ServerTime>
        const match = String(body).match(/<ServerTime>([^<]+)<\/ServerTime>/);
        if (match) return new Date(match[1]).getTime();
    } catch { /* ignore */ }
    return null;
}

function isTimeSkewError(e: unknown): boolean {
    const code = (e as any)?.Code ?? (e as any)?.name ?? (e as any)?.code ?? '';
    const msg  = (e as any)?.message ?? '';
    return (
        code === 'RequestTimeTooSkewed' ||
        msg.toLowerCase().includes('time') && msg.toLowerCase().includes('skew') ||
        msg.toLowerCase().includes('request time') ||
        msg.toLowerCase().includes('too large')
    );
}

/**
 * Run `fn(client)`. If it fails with RequestTimeTooSkewed, compute the clock
 * offset from the error or via a fresh Date header on HEAD, then retry once.
 */
async function withClockSkewRetry<T>(
    creds: S3BackupCredentials,
    fn: (client: S3Client) => Promise<T>
): Promise<T> {
    const client = makeS3Client(creds);
    try {
        return await fn(client);
    } catch (e: unknown) {
        if (!isTimeSkewError(e)) throw e;

        // Try to get server time from the error body
        let serverTime = parseServerTimeFromError(e);

        if (!serverTime) {
            // Fallback: fetch server time via a lightweight HTTP HEAD to the endpoint
            try {
                const res = await fetch(creds.endpoint, { method: 'HEAD' });
                const dateHeader = res.headers.get('date');
                if (dateHeader) serverTime = new Date(dateHeader).getTime();
            } catch { /* ignore */ }
        }

        if (!serverTime) throw e; // Can't determine offset, rethrow original

        const offset = serverTime - Date.now();
        const correctedClient = makeS3Client(creds, offset);
        return await fn(correctedClient);
    }
}

export async function testS3Connection(creds: S3BackupCredentials): Promise<void> {
    await withClockSkewRetry(creds, (client) =>
        client.send(new HeadBucketCommand({ Bucket: creds.bucket }))
    );
}

export async function listProjectBackups(
    projectName: string,
    creds: S3BackupCredentials
): Promise<BackupEntry[]> {
    const prefix = `${sanitizeFolderName(projectName)}/`;
    const result = await withClockSkewRetry(creds, (client) =>
        client.send(new ListObjectsV2Command({ Bucket: creds.bucket, Prefix: prefix }))
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
        archive.on('progress', (p) => {
            const mb = (p.fs.processedBytes / 1024 / 1024).toFixed(1);
            onProgress?.(`Zipping… ${mb} MB`);
        });
        archive.pipe(output);
        archive.directory(projectPath, false);
        archive.finalize();
    });

    const stats = fs.statSync(tmpFile);
    onProgress?.(`Uploading ${(stats.size / 1024 / 1024).toFixed(1)} MB…`);

    const fileStream = fs.createReadStream(tmpFile);
    try {
        await withClockSkewRetry(creds, (client) =>
            client.send(
                new PutObjectCommand({
                    Bucket: creds.bucket,
                    Key: s3Key,
                    Body: fileStream,
                    ContentLength: stats.size,
                    ContentType: 'application/zip',
                })
            )
        );
    } finally {
        fileStream.destroy();
        try { fs.unlinkSync(tmpFile); } catch { /* ignore */ }
    }

    return { key: s3Key, size: stats.size };
}
