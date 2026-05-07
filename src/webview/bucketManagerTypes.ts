export interface BucketProfile {
    id: string;
    name: string;
    endpoint: string;
    accessKeyId: string; // partial only — never the full key
    bucket: string;
}

export interface BucketItem {
    key: string;         // full S3 key
    name: string;        // display name (last segment)
    type: 'folder' | 'file';
    size?: number;
    lastModified?: string;
}

export interface BucketConfigPayload {
    id?: string;         // undefined = new bucket
    name: string;
    endpoint: string;
    accessKeyId: string;
    secretAccessKey: string;
    bucket: string;
}

// Extension → Webview
export type BucketManagerInboundMessage =
    | { type: 'state'; buckets: BucketProfile[] }
    | { type: 'listResult'; bucketId: string; prefix: string; folders: BucketItem[]; files: BucketItem[] }
    | { type: 'listError'; bucketId: string; error: string }
    | { type: 'testResult'; bucketId: string; ok: boolean; error?: string }
    | { type: 'uploadDone'; bucketId: string; key: string }
    | { type: 'uploadError'; bucketId: string; filename: string; error: string };

// Webview → Extension
export type BucketManagerOutboundMessage =
    | { type: 'ready' | 'refresh' }
    | { type: 'addBucket'; config: BucketConfigPayload }
    | { type: 'removeBucket'; id: string }
    | { type: 'testBucket'; id: string }
    | { type: 'listBucket'; id: string; prefix: string }
    | { type: 'downloadFile'; id: string; key: string }
    | { type: 'downloadFolder'; id: string; prefix: string }
    | { type: 'uploadFiles'; id: string; prefix: string };
