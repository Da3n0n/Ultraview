import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import {
    S3Client,
    ListObjectsV2Command,
    GetObjectCommand,
    PutObjectCommand,
    HeadBucketCommand,
} from '@aws-sdk/client-s3';

// ── Config types ──────────────────────────────────────────────────────────

export interface BucketConfig {
    id: string;
    name: string;
    endpoint: string;
    accessKeyId: string;
    secretAccessKey: string;
    bucket: string;
}

export interface BucketProfile {
    id: string;
    name: string;
    endpoint: string;
    accessKeyId: string;
    bucket: string;
}

export interface BucketItem {
    key: string;        // full S3 key
    name: string;       // display name (last segment)
    type: 'folder' | 'file';
    size?: number;
    lastModified?: string;
}

export interface ListResult {
    prefix: string;
    folders: BucketItem[];
    files: BucketItem[];
}

// ── Storage ───────────────────────────────────────────────────────────────

const BUCKETS_SECRET_KEY = 'ultraview.buckets.v1';

function newId(): string {
    return Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
}

export async function getBuckets(ctx: vscode.ExtensionContext): Promise<BucketConfig[]> {
    const raw = await ctx.secrets.get(BUCKETS_SECRET_KEY);
    if (!raw) return [];
    try { return JSON.parse(raw) as BucketConfig[]; } catch { return []; }
}

export async function saveBuckets(ctx: vscode.ExtensionContext, buckets: BucketConfig[]): Promise<void> {
    await ctx.secrets.store(BUCKETS_SECRET_KEY, JSON.stringify(buckets));
}

export async function addOrUpdateBucket(
    ctx: vscode.ExtensionContext,
    payload: Omit<BucketConfig, 'id'> & { id?: string }
): Promise<BucketConfig> {
    const buckets = await getBuckets(ctx);
    const id = payload.id ?? newId();
    const existing = buckets.findIndex((b) => b.id === id);
    const config: BucketConfig = { ...payload, id };
    if (existing >= 0) {
        buckets[existing] = config;
    } else {
        buckets.push(config);
    }
    await saveBuckets(ctx, buckets);
    return config;
}

export async function removeBucket(ctx: vscode.ExtensionContext, id: string): Promise<void> {
    const buckets = (await getBuckets(ctx)).filter((b) => b.id !== id);
    await saveBuckets(ctx, buckets);
}

export function toProfile(config: BucketConfig): BucketProfile {
    return { id: config.id, name: config.name, endpoint: config.endpoint, accessKeyId: config.accessKeyId, bucket: config.bucket };
}

// ── S3 helpers ────────────────────────────────────────────────────────────

function makeClient(config: BucketConfig): S3Client {
    return new S3Client({
        endpoint: config.endpoint,
        region: 'us-east-1',
        credentials: { accessKeyId: config.accessKeyId, secretAccessKey: config.secretAccessKey },
        forcePathStyle: true,
    });
}

export async function testBucketConnection(config: BucketConfig): Promise<void> {
    const client = makeClient(config);
    await client.send(new HeadBucketCommand({ Bucket: config.bucket }));
}

export async function listContents(config: BucketConfig, prefix: string): Promise<ListResult> {
    const client = makeClient(config);
    const folders: BucketItem[] = [];
    const files: BucketItem[] = [];
    let continuationToken: string | undefined;

    do {
        const response = await client.send(new ListObjectsV2Command({
            Bucket: config.bucket,
            Prefix: prefix,
            Delimiter: '/',
            ContinuationToken: continuationToken,
            MaxKeys: 1000,
        }));

        for (const cp of response.CommonPrefixes ?? []) {
            if (cp.Prefix && cp.Prefix !== prefix) {
                const name = cp.Prefix.slice(prefix.length).replace(/\/$/, '');
                folders.push({ key: cp.Prefix, name, type: 'folder' });
            }
        }

        for (const obj of response.Contents ?? []) {
            if (obj.Key && obj.Key !== prefix) {
                const name = obj.Key.slice(prefix.length);
                if (name) {
                    files.push({
                        key: obj.Key,
                        name,
                        type: 'file',
                        size: obj.Size,
                        lastModified: obj.LastModified?.toISOString(),
                    });
                }
            }
        }

        continuationToken = response.NextContinuationToken;
    } while (continuationToken);

    return { prefix, folders, files };
}

export async function downloadObject(config: BucketConfig, key: string): Promise<string> {
    const client = makeClient(config);
    const response = await client.send(new GetObjectCommand({ Bucket: config.bucket, Key: key }));
    // AWS SDK v3 Body has transformToByteArray() in both browser and node contexts
    const bytes = await (response.Body as any)?.transformToByteArray();
    if (!bytes) throw new Error('Empty response body');
    const tmpFile = path.join(os.tmpdir(), `uv-bucket-${Date.now()}-${path.basename(key)}`);
    fs.writeFileSync(tmpFile, Buffer.from(bytes));
    return tmpFile;
}

export async function downloadFolder(
    config: BucketConfig,
    prefix: string,
    destDir: string,
    onProgress?: (msg: string) => void
): Promise<{ fileCount: number; totalSize: number }> {
    const client = makeClient(config);
    let continuationToken: string | undefined;
    const keys: string[] = [];

    // List all objects under prefix (no Delimiter — full recursive list)
    do {
        const response = await client.send(new ListObjectsV2Command({
            Bucket: config.bucket,
            Prefix: prefix,
            ContinuationToken: continuationToken,
        }));
        for (const obj of response.Contents ?? []) {
            if (obj.Key) keys.push(obj.Key);
        }
        continuationToken = response.NextContinuationToken;
    } while (continuationToken);

    if (keys.length === 0) throw new Error('No files found under this folder prefix.');

    let fileCount = 0;
    let totalSize = 0;

    for (let i = 0; i < keys.length; i++) {
        const key = keys[i];
        const relativePath = key.startsWith(prefix) ? key.slice(prefix.length) : key;
        const localPath = path.join(destDir, ...relativePath.split('/'));
        fs.mkdirSync(path.dirname(localPath), { recursive: true });

        onProgress?.(`(${i + 1}/${keys.length}) ${relativePath}`);

        const response = await client.send(new GetObjectCommand({ Bucket: config.bucket, Key: key }));
        const bytes = await (response.Body as any)?.transformToByteArray();
        if (!bytes) continue;
        fs.writeFileSync(localPath, Buffer.from(bytes));
        totalSize += bytes.length;
        fileCount++;
    }

    return { fileCount, totalSize };
}

export async function uploadObject(
    config: BucketConfig,
    key: string,
    localPath: string,
    onProgress?: (msg: string) => void
): Promise<void> {
    const client = makeClient(config);
    const stats = fs.statSync(localPath);
    onProgress?.(`Uploading ${path.basename(localPath)} (${(stats.size / 1024 / 1024).toFixed(1)} MB)…`);
    const body = fs.readFileSync(localPath);
    await client.send(new PutObjectCommand({
        Bucket: config.bucket,
        Key: key,
        Body: body,
        ContentLength: stats.size,
    }));
}
