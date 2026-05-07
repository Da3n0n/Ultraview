import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { buildReactWebviewPage } from '../webview/shared/buildReactWebviewPage';
import {
    getBuckets,
    addOrUpdateBucket,
    removeBucket,
    testBucketConnection,
    listContents,
    downloadObject,
    uploadObject,
    toProfile,
} from '../bucketManager';
import type { BucketManagerOutboundMessage } from '../webview/bucketManagerTypes';

export class BucketManagerProvider implements vscode.WebviewViewProvider {
    public static readonly viewId = 'ultraview.bucketManager';
    private view?: vscode.WebviewView;

    constructor(private readonly context: vscode.ExtensionContext) {}

    static openAsPanel(context: vscode.ExtensionContext): void {
        const panel = vscode.window.createWebviewPanel(
            'ultraview.bucketManagerPanel',
            'Bucket Manager',
            vscode.ViewColumn.One,
            {
                enableScripts: true,
                retainContextWhenHidden: true,
                localResourceRoots: [vscode.Uri.file(path.join(context.extensionPath, 'dist'))],
            }
        );
        panel.webview.html = BucketManagerProvider.buildHtml(context.extensionPath, panel.webview);
        BucketManagerProvider.attachHandler(panel.webview, context);
    }

    resolveWebviewView(webviewView: vscode.WebviewView): void {
        this.view = webviewView;
        webviewView.webview.options = {
            enableScripts: true,
            localResourceRoots: [vscode.Uri.file(path.join(this.context.extensionPath, 'dist'))],
        };
        webviewView.webview.html = BucketManagerProvider.buildHtml(this.context.extensionPath, webviewView.webview);
        BucketManagerProvider.attachHandler(webviewView.webview, this.context);
    }

    private static buildHtml(extensionPath: string, webview: vscode.Webview): string {
        return buildReactWebviewPage({
            extensionPath,
            webview,
            bundleName: 'bucketManager',
            title: 'Bucket Manager',
            initialState: {},
            loadingLabel: 'Loading Bucket Manager…',
        });
    }

    private static attachHandler(webview: vscode.Webview, context: vscode.ExtensionContext): void {
        const sendState = async () => {
            const buckets = await getBuckets(context);
            webview.postMessage({ type: 'state', buckets: buckets.map(toProfile) });
        };

        webview.onDidReceiveMessage(async (msg: BucketManagerOutboundMessage) => {
            switch (msg.type) {
                case 'ready':
                case 'refresh':
                    await sendState();
                    break;

                case 'addBucket': {
                    const { config } = msg;
                    // If editing and secret is blank, preserve existing secret
                    if (config.id && !config.secretAccessKey.trim()) {
                        const existing = (await getBuckets(context)).find((b) => b.id === config.id);
                        if (existing) config.secretAccessKey = existing.secretAccessKey;
                    }
                    if (!config.secretAccessKey.trim()) {
                        vscode.window.showErrorMessage('Secret key is required.');
                        return;
                    }
                    await addOrUpdateBucket(context, config as any);
                    await sendState();
                    break;
                }

                case 'removeBucket': {
                    await removeBucket(context, msg.id);
                    await sendState();
                    break;
                }

                case 'testBucket': {
                    const buckets = await getBuckets(context);
                    const config = buckets.find((b) => b.id === msg.id);
                    if (!config) return;
                    try {
                        await testBucketConnection(config);
                        webview.postMessage({ type: 'testResult', bucketId: msg.id, ok: true });
                    } catch (e: any) {
                        webview.postMessage({ type: 'testResult', bucketId: msg.id, ok: false, error: e?.message ?? 'Failed' });
                    }
                    break;
                }

                case 'listBucket': {
                    const buckets = await getBuckets(context);
                    const config = buckets.find((b) => b.id === msg.id);
                    if (!config) return;
                    try {
                        const result = await listContents(config, msg.prefix);
                        webview.postMessage({
                            type: 'listResult',
                            bucketId: msg.id,
                            prefix: msg.prefix,
                            folders: result.folders,
                            files: result.files,
                        });
                    } catch (e: any) {
                        webview.postMessage({ type: 'listError', bucketId: msg.id, error: e?.message ?? 'Failed to list bucket' });
                    }
                    break;
                }

                case 'downloadFile': {
                    const buckets = await getBuckets(context);
                    const config = buckets.find((b) => b.id === msg.id);
                    if (!config) return;

                    const filename = path.basename(msg.key);
                    const saveUri = await vscode.window.showSaveDialog({
                        defaultUri: vscode.Uri.file(path.join(require('os').homedir(), 'Downloads', filename)),
                        saveLabel: 'Download',
                        filters: { 'All Files': ['*'] },
                    });
                    if (!saveUri) return;

                    await vscode.window.withProgress(
                        { location: vscode.ProgressLocation.Notification, title: `Downloading ${filename}`, cancellable: false },
                        async (progress) => {
                            try {
                                progress.report({ message: 'Fetching from bucket…' });
                                const tmpFile = await downloadObject(config, msg.key);
                                fs.copyFileSync(tmpFile, saveUri.fsPath);
                                try { fs.unlinkSync(tmpFile); } catch { /* ignore */ }
                                const open = await vscode.window.showInformationMessage(
                                    `Downloaded ${filename}`,
                                    'Open'
                                );
                                if (open === 'Open') {
                                    vscode.commands.executeCommand('vscode.open', saveUri);
                                }
                            } catch (e: any) {
                                vscode.window.showErrorMessage(`Download failed: ${e?.message ?? e}`);
                            }
                        }
                    );
                    break;
                }

                case 'uploadFiles': {
                    const buckets = await getBuckets(context);
                    const config = buckets.find((b) => b.id === msg.id);
                    if (!config) return;

                    const uris = await vscode.window.showOpenDialog({
                        canSelectFiles: true,
                        canSelectFolders: false,
                        canSelectMany: true,
                        openLabel: 'Upload',
                    });
                    if (!uris?.length) return;

                    await vscode.window.withProgress(
                        { location: vscode.ProgressLocation.Notification, title: 'Uploading to bucket', cancellable: false },
                        async (progress) => {
                            let done = 0;
                            for (const uri of uris) {
                                const filename = path.basename(uri.fsPath);
                                const key = msg.prefix ? `${msg.prefix}${filename}` : filename;
                                progress.report({ message: `(${done + 1}/${uris.length}) ${filename}` });
                                try {
                                    await uploadObject(config, key, uri.fsPath, (m) => progress.report({ message: m }));
                                    webview.postMessage({ type: 'uploadDone', bucketId: msg.id, key });
                                } catch (e: any) {
                                    webview.postMessage({ type: 'uploadError', bucketId: msg.id, filename, error: e?.message ?? 'Failed' });
                                    vscode.window.showErrorMessage(`Upload failed for ${filename}: ${e?.message ?? e}`);
                                }
                                done++;
                            }
                            if (done > 0) {
                                vscode.window.showInformationMessage(`Uploaded ${done} file(s) to ${config.bucket}/${msg.prefix || ''}`);
                            }
                        }
                    );
                    break;
                }
            }
        });
    }
}
