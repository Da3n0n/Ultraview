import * as vscode from 'vscode';

export interface S3BackupCredentials {
    endpoint: string;
    accessKeyId: string;
    secretAccessKey: string;
    bucket: string;
}

const CREDS_KEY = 'ultraview.s3backup.credentials';

export async function getS3Credentials(
    context: vscode.ExtensionContext
): Promise<S3BackupCredentials | null> {
    const raw = await context.secrets.get(CREDS_KEY);
    if (!raw) return null;
    try {
        return JSON.parse(raw) as S3BackupCredentials;
    } catch {
        return null;
    }
}

export async function saveS3Credentials(
    context: vscode.ExtensionContext,
    creds: S3BackupCredentials
): Promise<void> {
    await context.secrets.store(CREDS_KEY, JSON.stringify(creds));
}

export async function clearS3Credentials(context: vscode.ExtensionContext): Promise<void> {
    await context.secrets.delete(CREDS_KEY);
}
