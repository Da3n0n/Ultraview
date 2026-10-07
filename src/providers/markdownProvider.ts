import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { MarkdownDocument, buildEditorPage } from '../markdown';
import type { MarkdownToExtensionMessage, MarkdownViewMode } from '../webview/markdown/types';

const MARKDOWN_VIEW_MODE_KEY = 'markdown.viewMode';

export class MarkdownProvider implements vscode.CustomEditorProvider<MarkdownDocument> {
  private readonly panels = new Set<vscode.WebviewPanel>();
  private viewMode?: MarkdownViewMode;
  private readonly _onDidChangeCustomDocument = new vscode.EventEmitter<vscode.CustomDocumentEditEvent<MarkdownDocument>>();
  onDidChangeCustomDocument = this._onDidChangeCustomDocument.event;

  constructor(private readonly ctx: vscode.ExtensionContext) {
    const savedMode = ctx.globalState.get<MarkdownViewMode>(MARKDOWN_VIEW_MODE_KEY);
    if (savedMode === 'rich' || savedMode === 'raw' || savedMode === 'split') {
      this.viewMode = savedMode;
    }
  }

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

    const updateContent = () => {
      const raw = fs.readFileSync(filePath, 'utf8');
      document.setContent(raw);
      void panel.webview.postMessage({ type: 'setContent', content: raw });
    };

    this.panels.add(panel);
    panel.webview.onDidReceiveMessage((msg: MarkdownToExtensionMessage) => {
      switch (msg.type) {
        case 'ready':
          if (this.viewMode) {
            void panel.webview.postMessage({ type: 'setViewMode', viewMode: this.viewMode });
          }
          break;
        case 'setViewMode':
          if (msg.viewMode === 'rich' || msg.viewMode === 'raw' || msg.viewMode === 'split') {
            this.viewMode = msg.viewMode;
            void this.ctx.globalState.update(MARKDOWN_VIEW_MODE_KEY, this.viewMode);
            for (const editor of this.panels) {
              void editor.webview.postMessage({ type: 'setViewMode', viewMode: this.viewMode });
            }
          }
          break;
        case 'save':
          if (msg.content !== undefined) {
            lastSelfWriteTime = Date.now();
            fs.writeFileSync(filePath, msg.content, 'utf8');
            document.setContent(msg.content);
          }
          break;
      }
    });

    const initialContent = fs.readFileSync(filePath, 'utf8');
    document.setContent(initialContent);
    panel.webview.html = buildEditorPage(this.ctx.extensionPath, panel.webview, initialContent, this.viewMode);

    const watcher = fs.watch(filePath, () => {
      if (Date.now() - lastSelfWriteTime < 500) return;
      updateContent();
    });
    panel.onDidDispose(() => {
      this.panels.delete(panel);
      watcher.close();
    });
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
