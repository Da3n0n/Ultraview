export interface S3BackupCredentials {
    endpoint: string;
    accessKeyId: string;
    secretAccessKey: string;
    bucket: string;
}

export type ProjectBackupStatus = 'idle' | 'backing-up' | 'success' | 'error';

export interface ProjectBackupState {
    projectId: string;
    projectName: string;
    projectPath: string;
    status: ProjectBackupStatus;
    lastBackupKey?: string;     // e.g. "my-project/2026-05-07_12-30-00.zip"
    lastBackupSize?: number;    // bytes
    error?: string;
}

export interface S3BackupPanelStateMessage {
    type: 'state';
    hasCredentials: boolean;
    credentials?: Omit<S3BackupCredentials, 'secretAccessKey'>; // endpoint + accessKeyId + bucket (no secret)
    projects: ProjectBackupState[];
    connectionOk?: boolean;     // undefined = not tested, true = ok, false = failed
    connectionError?: string;
}

export interface S3BackupProgressMessage {
    type: 'progress';
    projectId: string;
    status: ProjectBackupStatus;
    message?: string;
    lastBackupKey?: string;
    lastBackupSize?: number;
    error?: string;
}

export interface S3BackupConnectionResultMessage {
    type: 'connectionResult';
    ok: boolean;
    error?: string;
}

export type S3BackupInboundMessage =
    | S3BackupPanelStateMessage
    | S3BackupProgressMessage
    | S3BackupConnectionResultMessage;

export type S3BackupOutboundMessage =
    | { type: 'ready' | 'refresh' | 'backupAll' | 'testConnection' | 'clearCredentials' }
    | { type: 'saveCredentials'; credentials: S3BackupCredentials }
    | { type: 'backupProject'; projectId: string };
