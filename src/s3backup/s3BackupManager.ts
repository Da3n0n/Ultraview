import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { S3Client, PutObjectCommand, ListObjectsV2Command, HeadBucketCommand } from '@aws-sdk/client-s3';
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

const SKIP_DIRS = new Set(['.git', 'node_modules', '.next', 'dist', 'build', '__pycache__', '.cache', 'coverage', '.turbo']);

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

function isTimeSkewError(e: unknown): boolean {
    const code = (e as any)?.Code ?? (e as any)?.name ?? (e as any)?.code ?? '';
    const msg  = (e as any)?.message ?? '';
    return (
        code === 'RequestTimeTooSkewed' ||
        (msg.toLowerCase().includes('time') && msg.toLowerCase().includes('skew')) ||
        msg.toLowerCase().includes('request time') ||
        msg.toLowerCase().includes('too large')
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
            if (dateHeader) serverTime = new Date(dateHeader).getTime();
        } catch { /* ignore */ }
        if (!serverTime) throw e;
        const correctedClient = makeS3Client(creds, serverTime - Date.now());
        return await fn(correctedClient);
    }
}

/** Walk a directory and yield all file paths, skipping common noise dirs. */
function* walkDir(dir: string, base: string): Generator<{ absPath: string; relPath: string }> {
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
        if (entry.isDirectory()) {
            if (SKIP_DIRS.has(entry.name)) continue;
            yield* walkDir(path.join(dir, entry.name), base);
        } else if (entry.isFile()) {
            const absPath = path.join(dir, entry.name);
            const relPath = path.relative(base, absPath).replace(/\\/g, '/');
            yield { absPath, relPath };
        }
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
    const prefix = `${sanitized}/${stamp}/`;

    const files = [...walkDir(projectPath, projectPath)];
    if (files.length === 0) throw new Error('No files found in project folder.');

    let done = 0;
    let totalSize = 0;

    for (const { absPath, relPath } of files) {
        const s3Key = `${prefix}${relPath}`;
        let fileBuffer: Buffer;
        try {
            fileBuffer = fs.readFileSync(absPath);
        } catch {
            done++;
            continue; // skip unreadable files (locked, etc.)
        }
        totalSize += fileBuffer.length;

        const ext = path.extname(relPath).toLowerCase();
        const contentType = ext === '.json' ? 'application/json'
            : ext === '.ts' || ext === '.tsx' ? 'application/typescript'
            : ext === '.js' || ext === '.jsx' ? 'application/javascript'
            : ext === '.html' ? 'text/html'
            : ext === '.css' ? 'text/css'
            : ext === '.md' ? 'text/markdown'
            : 'application/octet-stream';

        try {
            await withClockSkewRetry(creds, (client) =>
                client.send(new PutObjectCommand({
                    Bucket: creds.bucket,
                    Key: s3Key,
                    Body: fileBuffer,
                    ContentLength: fileBuffer.length,
                    ContentType: contentType,
                }))
            );
        } catch (e: any) {
            throw new Error(`Failed to upload ${relPath}: ${e?.message ?? e}`);
        }

        done++;
        if (done % 10 === 0 || done === files.length) {
            onProgress?.(`Uploading… ${done}/${files.length} files`);
        }
    }

    return { key: prefix, fileCount: done, totalSize };
}


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
