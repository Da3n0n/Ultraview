import * as vscode from 'vscode';
import * as path from 'path';
import { buildReactWebviewPage } from '../webview/shared/buildReactWebviewPage';
import { GitProjects } from '../git/gitProjects';
import { SharedStore } from '../sync/sharedStore';
import {
    getS3Credentials,
    saveS3Credentials,
    clearS3Credentials,
    testS3Connection,
    backupProject,
    listProjectBackups,
} from '../s3backup';
import type {
    S3BackupOutboundMessage,
    ProjectBackupState,
    S3BackupPanelStateMessage,
} from '../webview/s3BackupTypes';

export class S3BackupProvider implements vscode.WebviewViewProvider {
    public static readonly viewId = 'ultraview.s3backup';
    private view?: vscode.WebviewView;

    constructor(
        private readonly context: vscode.ExtensionContext,
        private readonly store: SharedStore
    ) {}

    static openAsPanel(context: vscode.ExtensionContext, store: SharedStore): void {
        const panel = vscode.window.createWebviewPanel(
            'ultraview.s3backupPanel',
            'S3 Backup',
            vscode.ViewColumn.One,
            {
                enableScripts: true,
                retainContextWhenHidden: true,
                localResourceRoots: [vscode.Uri.file(path.join(context.extensionPath, 'dist'))],
            }
        );
        panel.webview.html = buildReactWebviewPage({
            extensionPath: context.extensionPath,
            webview: panel.webview,
            bundleName: 's3Backup',
            title: 'S3 Backup',
            initialState: {},
            loadingLabel: 'Loading S3 Backup…',
        });
        S3BackupProvider.attachMessageHandler(panel.webview, context, store);
    }

    resolveWebviewView(webviewView: vscode.WebviewView): void {
        this.view = webviewView;
        webviewView.webview.options = {
            enableScripts: true,
            localResourceRoots: [vscode.Uri.file(path.join(this.context.extensionPath, 'dist'))],
        };
        webviewView.webview.html = buildReactWebviewPage({
            extensionPath: this.context.extensionPath,
            webview: webviewView.webview,
            bundleName: 's3Backup',
            title: 'S3 Backup',
            initialState: {},
            loadingLabel: 'Loading S3 Backup…',
        });
        S3BackupProvider.attachMessageHandler(webviewView.webview, this.context, this.store);
    }

    private static async buildState(
        context: vscode.ExtensionContext,
        store: SharedStore,
        projectStatuses: Map<string, ProjectBackupState>
    ): Promise<S3BackupPanelStateMessage> {
        const creds = await getS3Credentials(context);
        const gitProjects = new GitProjects(context, store);
        const projects = gitProjects.listProjects();

        const projectStates: ProjectBackupState[] = projects.map((p) => {
            const existing = projectStatuses.get(p.id);
            return (
                existing ?? {
                    projectId: p.id,
                    projectName: p.name,
                    projectPath: p.path,
                    status: 'idle' as const,
                }
            );
        });

        return {
            type: 'state',
            hasCredentials: !!creds,
            credentials: creds
                ? { endpoint: creds.endpoint, accessKeyId: creds.accessKeyId, bucket: creds.bucket }
                : undefined,
            projects: projectStates,
        };
    }

    static attachMessageHandler(
        webview: vscode.Webview,
        context: vscode.ExtensionContext,
        store: SharedStore
    ): void {
        const projectStatuses = new Map<string, ProjectBackupState>();

        const sendState = async () => {
            const state = await S3BackupProvider.buildState(context, store, projectStatuses);
            webview.postMessage(state);
        };

        webview.onDidReceiveMessage(async (msg: S3BackupOutboundMessage) => {
            switch (msg.type) {
                case 'ready':
                case 'refresh':
                    await sendState();
                    break;

                case 'saveCredentials': {
                    await saveS3Credentials(context, msg.credentials);
                    await sendState();
                    vscode.window.showInformationMessage('S3 backup credentials saved.');
                    break;
                }

                case 'clearCredentials': {
                    await clearS3Credentials(context);
                    projectStatuses.clear();
                    await sendState();
                    vscode.window.showInformationMessage('S3 backup credentials cleared.');
                    break;
                }

                case 'testConnection': {
                    const creds = await getS3Credentials(context);
                    if (!creds) {
                        webview.postMessage({ type: 'connectionResult', ok: false, error: 'No credentials configured.' });
                        return;
                    }
                    try {
                        await testS3Connection(creds);
                        webview.postMessage({ type: 'connectionResult', ok: true });
                    } catch (e: any) {
                        webview.postMessage({ type: 'connectionResult', ok: false, error: e?.message ?? 'Connection failed' });
                    }
                    break;
                }

                case 'backupProject': {
                    const creds = await getS3Credentials(context);
                    if (!creds) {
                        vscode.window.showErrorMessage('Configure S3 credentials before backing up.');
                        return;
                    }
                    const gitProjects = new GitProjects(context, store);
                    const project = gitProjects.listProjects().find((p) => p.id === msg.projectId);
                    if (!project) return;

                    const statusEntry: ProjectBackupState = {
                        projectId: project.id,
                        projectName: project.name,
                        projectPath: project.path,
                        status: 'backing-up',
                    };
                    projectStatuses.set(project.id, statusEntry);
                    webview.postMessage({ type: 'progress', projectId: project.id, status: 'backing-up', message: 'Starting backup…' });

                    await vscode.window.withProgress(
                        { location: vscode.ProgressLocation.Notification, title: `S3 Backup: ${project.name}`, cancellable: false },
                        async (progress) => {
                            try {
                                const result = await backupProject(
                                    project.name,
                                    project.path,
                                    creds,
                                    (msg) => progress.report({ message: msg })
                                );
                                const updated: ProjectBackupState = {
                                    ...statusEntry,
                                    status: 'success',
                                    lastBackupKey: result.key,
                                    lastBackupSize: result.totalSize,
                                };
                                projectStatuses.set(project.id, updated);
                                webview.postMessage({ type: 'progress', projectId: project.id, status: 'success', lastBackupKey: result.key, lastBackupSize: result.totalSize });
                                vscode.window.showInformationMessage(`✓ Backed up ${project.name} to ${creds.bucket}/${result.key}`);
                            } catch (e: any) {
                                const errMsg = e?.message ?? 'Backup failed';
                                const updated: ProjectBackupState = { ...statusEntry, status: 'error', error: errMsg };
                                projectStatuses.set(project.id, updated);
                                webview.postMessage({ type: 'progress', projectId: project.id, status: 'error', error: errMsg });
                                vscode.window.showErrorMessage(`S3 backup failed for ${project.name}: ${errMsg}`);
                            }
                        }
                    );
                    break;
                }

                case 'backupAll': {
                    const creds = await getS3Credentials(context);
                    if (!creds) {
                        vscode.window.showErrorMessage('Configure S3 credentials before backing up.');
                        return;
                    }
                    const gitProjects = new GitProjects(context, store);
                    const allProjects = gitProjects.listProjects();
                    if (!allProjects.length) {
                        vscode.window.showInformationMessage('No projects to back up.');
                        return;
                    }

                    await vscode.window.withProgress(
                        { location: vscode.ProgressLocation.Notification, title: 'S3 Backup: All Projects', cancellable: false },
                        async (progress) => {
                            let done = 0;
                            for (const project of allProjects) {
                                const statusEntry: ProjectBackupState = {
                                    projectId: project.id,
                                    projectName: project.name,
                                    projectPath: project.path,
                                    status: 'backing-up',
                                };
                                projectStatuses.set(project.id, statusEntry);
                                webview.postMessage({ type: 'progress', projectId: project.id, status: 'backing-up' });
                                progress.report({ message: `(${done + 1}/${allProjects.length}) ${project.name}` });
                                try {
                                    const result = await backupProject(project.name, project.path, creds, (m) => progress.report({ message: m }));
                                    const updated: ProjectBackupState = { ...statusEntry, status: 'success', lastBackupKey: result.key, lastBackupSize: result.totalSize };
                                    projectStatuses.set(project.id, updated);
                                    webview.postMessage({ type: 'progress', projectId: project.id, status: 'success', lastBackupKey: result.key, lastBackupSize: result.totalSize });
                                } catch (e: any) {
                                    const errMsg = e?.message ?? 'Backup failed';
                                    const updated: ProjectBackupState = { ...statusEntry, status: 'error', error: errMsg };
                                    projectStatuses.set(project.id, updated);
                                    webview.postMessage({ type: 'progress', projectId: project.id, status: 'error', error: errMsg });
                                }
                                done++;
                            }
                            progress.report({ message: `Done — ${done} project(s) backed up.` });
                            vscode.window.showInformationMessage(`S3 Backup complete: ${done} project(s) backed up to ${creds.bucket}`);
                        }
                    );
                    break;
                }
            }
        });
    }
}

/** Quick commands callable from the command palette */
export async function configureS3BackupCredentials(context: vscode.ExtensionContext): Promise<void> {
    const existing = await getS3Credentials(context);

    const endpoint = await vscode.window.showInputBox({
        prompt: 'S3 endpoint URL',
        placeHolder: 'https://gateway.storjshare.io',
        value: existing?.endpoint ?? 'https://gateway.storjshare.io',
        ignoreFocusOut: true,
    });
    if (endpoint === undefined) return;

    const accessKeyId = await vscode.window.showInputBox({
        prompt: 'Access Key ID',
        value: existing?.accessKeyId ?? '',
        ignoreFocusOut: true,
    });
    if (!accessKeyId) return;

    const secretAccessKey = await vscode.window.showInputBox({
        prompt: 'Secret Access Key',
        password: true,
        ignoreFocusOut: true,
    });
    if (!secretAccessKey) return;

    const bucket = await vscode.window.showInputBox({
        prompt: 'Bucket name',
        value: existing?.bucket ?? '',
        ignoreFocusOut: true,
    });
    if (!bucket) return;

    await saveS3Credentials(context, { endpoint, accessKeyId, secretAccessKey, bucket });
    vscode.window.showInformationMessage('S3 backup credentials saved.');
}
