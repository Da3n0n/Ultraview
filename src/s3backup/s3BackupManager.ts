import * as fs from 'fs';
import * as path from 'path';
import {
    HeadBucketCommand,
    ListObjectsV2Command,
    PutObjectCommand,
    S3Client,
} from '@aws-sdk/client-s3';
import { S3BackupCredentials } from './s3BackupSettings';

export interface BackupEntry {
    key: string;
    lastModified?: Date;
    size?: number;
}

export interface BackupResult {
    key: string;
    fileCount: number;
    totalSize: number;
}

const SKIP_DIRS = new Set([
    '.git',
    'node_modules',
    '.next',
    'dist',
    'build',
    '__pycache__',
    '.cache',
    'coverage',
    '.turbo',
]);

function sanitizeFolderName(name: string): string {
    return (
        name
            .replace(/[^a-zA-Z0-9_\-.]/g, '_')
            .replace(/_{2,}/g, '_')
            .replace(/^_|_$/g, '') || 'project'
    );
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

function isTimeSkewError(e: unknown): boolean {
    const code = (e as any)?.Code ?? (e as any)?.name ?? (e as any)?.code ?? '';
    const msg = ((e as any)?.message ?? '').toLowerCase();
    return (
        code === 'RequestTimeTooSkewed' ||
        (msg.includes('time') && msg.includes('skew')) ||
        msg.includes('request time') ||
        msg.includes('too large')
    );
}

async function withClockSkewRetry<T>(
    creds: S3BackupCredentials,
    fn: (client: S3Client) => Promise<T>
): Promise<T> {
    const client = makeS3Client(creds);
    try {
        return await fn(client);
    } catch (e: unknown) {
        if (!isTimeSkewError(e)) throw e;

        let serverTime: number | null = null;
        try {
            const res = await fetch(creds.endpoint, { method: 'HEAD' });
            const dateHeader = res.headers.get('date');
            if (dateHeader) {
                serverTime = new Date(dateHeader).getTime();
            }
        } catch {
            // ignore and rethrow original error below if no server time available
        }

        if (!serverTime) throw e;

        const correctedClient = makeS3Client(creds, serverTime - Date.now());
        return await fn(correctedClient);
    }
}

function* walkDir(dir: string, base: string): Generator<{ absPath: string; relPath: string }> {
    let entries: fs.Dirent[];
    try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
        return;
    }

    for (const entry of entries) {
        if (entry.isDirectory()) {
            if (SKIP_DIRS.has(entry.name)) continue;
            yield* walkDir(path.join(dir, entry.name), base);
            continue;
        }

        if (entry.isFile()) {
            const absPath = path.join(dir, entry.name);
            const relPath = path.relative(base, absPath).replace(/\\/g, '/');
            yield { absPath, relPath };
        }
    }
}

function guessContentType(relPath: string): string {
    const ext = path.extname(relPath).toLowerCase();
    if (ext === '.json') return 'application/json';
    if (ext === '.ts' || ext === '.tsx') return 'application/typescript';
    if (ext === '.js' || ext === '.jsx') return 'application/javascript';
    if (ext === '.html') return 'text/html';
    if (ext === '.css') return 'text/css';
    if (ext === '.md') return 'text/markdown';
    return 'application/octet-stream';
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
        .map((obj) => ({
            key: obj.Key ?? '',
            lastModified: obj.LastModified,
            size: obj.Size,
        }))
        .sort((a, b) => (b.lastModified?.getTime() ?? 0) - (a.lastModified?.getTime() ?? 0));
}

export async function backupProject(
    projectName: string,
    projectPath: string,
    creds: S3BackupCredentials,
    onProgress?: (message: string) => void
): Promise<BackupResult> {
    const sanitized = sanitizeFolderName(projectName);
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').replace('T', '_').slice(0, 19);
    const prefix = `${sanitized}/${stamp}/`;

    const files = [...walkDir(projectPath, projectPath)];
    if (files.length === 0) {
        throw new Error('No files found in project folder.');
    }

    let done = 0;
    let totalSize = 0;

    for (const { absPath, relPath } of files) {
        let fileBuffer: Buffer;
        try {
            fileBuffer = fs.readFileSync(absPath);
        } catch {
            done++;
            continue;
        }

        totalSize += fileBuffer.length;

        try {
            await withClockSkewRetry(creds, (client) =>
                client.send(
                    new PutObjectCommand({
                        Bucket: creds.bucket,
                        Key: `${prefix}${relPath}`,
                        Body: fileBuffer,
                        ContentLength: fileBuffer.length,
                        ContentType: guessContentType(relPath),
                    })
                )
            );
        } catch (e: any) {
            throw new Error(`Failed to upload ${relPath}: ${e?.message ?? e}`);
        }

        done++;
        if (done % 10 === 0 || done === files.length) {
            onProgress?.(`Uploading... ${done}/${files.length} files`);
        }
    }

    return {
        key: prefix,
        fileCount: done,
        totalSize,
    };
}
