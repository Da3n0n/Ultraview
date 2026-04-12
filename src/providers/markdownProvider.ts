import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { MarkdownDocument, buildEditorPage } from '../editor';

export class MarkdownProvider implements vscode.CustomEditorProvider<MarkdownDocument> {
  private readonly _onDidChangeCustomDocument = new vscode.EventEmitter<vscode.CustomDocumentEditEvent<MarkdownDocument>>();
  onDidChangeCustomDocument = this._onDidChangeCustomDocument.event;

  constructor(private readonly ctx: vscode.ExtensionContext) { }

  openCustomDocument(
    uri: vscode.Uri,
    _openContext: vscode.CustomDocumentOpenContext,
    _token: vscode.CancellationToken
  ): MarkdownDocument {
    return new MarkdownDocument(uri);
  }

  async resolveCustomEditor(
    document: MarkdownDocument,
    panel: vscode.WebviewPanel,
    _token: vscode.CancellationToken
  ): Promise<void> {
    panel.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.file(path.join(this.ctx.extensionPath, 'dist'))]
    };
    const filePath = document.uri.fsPath;
    let lastSelfWriteTime = 0;
    let webviewReady = false;
    let latestContent = '';

    const updateContent = () => {
      const raw = fs.readFileSync(filePath, 'utf8');
      latestContent = raw;
      document.setContent(raw);
      if (webviewReady) {
        panel.webview.postMessage({ type: 'setContent', content: raw });
      }
    };

    panel.webview.onDidReceiveMessage((msg: { type: string; content?: string }) => {
      switch (msg.type) {
        case 'ready':
          webviewReady = true;
          panel.webview.postMessage({ type: 'setContent', content: latestContent });
          break;
        case 'save':
          if (msg.content !== undefined) {
            lastSelfWriteTime = Date.now();
            fs.writeFileSync(filePath, msg.content, 'utf8');
            latestContent = msg.content;
            document.setContent(msg.content);
          }
          break;
      }
    });

    const initialContent = fs.readFileSync(filePath, 'utf8');
    latestContent = initialContent;
    document.setContent(initialContent);
    panel.webview.html = buildEditorPage(this.ctx.extensionPath, panel.webview, initialContent);

    const watcher = fs.watch(filePath, () => {
      if (Date.now() - lastSelfWriteTime < 500) return;
      updateContent();
    });
    panel.onDidDispose(() => watcher.close());
  }

  saveCustomDocument(_document: MarkdownDocument, _cancellation: vscode.CancellationToken): Thenable<void> {
    return Promise.resolve();
  }

  saveCustomDocumentAs(document: MarkdownDocument, _destination: vscode.Uri, cancellation: vscode.CancellationToken): Thenable<void> {
    return this.saveCustomDocument(document, cancellation);
  }

  revertCustomDocument(_document: MarkdownDocument, _cancellation: vscode.CancellationToken): Thenable<void> {
    return Promise.resolve();
  }

  backupCustomDocument(_document: MarkdownDocument, context: vscode.CustomDocumentBackupContext, _cancellation: vscode.CancellationToken): Thenable<vscode.CustomDocumentBackup> {
    return Promise.resolve({ id: context.destination.fsPath, delete: () => { } });
  }
}
