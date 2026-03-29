import * as vscode from 'vscode';
import * as fs from 'fs';
import { MarkdownDocument, buildEditorPage } from '../editor';
import { getMarkdownScrollLine } from './markdownScrollState';

export class MarkdownProvider implements vscode.CustomEditorProvider<MarkdownDocument> {
  private readonly _onDidChangeCustomDocument = new vscode.EventEmitter<vscode.CustomDocumentEditEvent<MarkdownDocument>>();
  onDidChangeCustomDocument = this._onDidChangeCustomDocument.event;

  constructor(_ctx: vscode.ExtensionContext) { }

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
    const uri = document.uri;

    // Yield one tick so VS Code can finish registering tabs before we inspect them.
    // Without this the diff tab isn't in tabGroups yet when resolveCustomEditor is called.
    await new Promise<void>(resolve => setTimeout(resolve, 0));

    const isInDiff = vscode.window.tabGroups.all.some(group =>
      group.tabs.some(tab => {
        // Case 1: VS Code created a proper TextDiff tab and our file is the modified side
        if (tab.input instanceof vscode.TabInputTextDiff) {
          return (tab.input as vscode.TabInputTextDiff).modified.toString() === uri.toString();
        }
        // Case 2: VS Code opened our custom editor as the working-tree side of a diff
        // (detectable via the "(Working Tree)" suffix VS Code adds to the tab label)
        if (tab.input instanceof vscode.TabInputCustom) {
          const c = tab.input as vscode.TabInputCustom;
          return c.uri.toString() === uri.toString() && tab.label.includes('Working Tree');
        }
        return false;
      })
    );

    if (isInDiff) {
      panel.dispose();
      return;
    }

    panel.webview.options = { enableScripts: true };
    const filePath = document.uri.fsPath;
    let lastSelfWriteTime = 0;

    const updateContent = () => {
      const raw = fs.readFileSync(filePath, 'utf8');
      panel.webview.postMessage({ type: 'setContent', content: raw });
    };

    panel.webview.html = buildEditorPage(panel.webview);

    panel.webview.onDidReceiveMessage((msg: { type: string; content?: string }) => {
      switch (msg.type) {
        case 'ready':
          updateContent();
          const pendingLine = getMarkdownScrollLine(filePath);
          if (pendingLine) {
            panel.webview.postMessage({ type: 'scrollToLine', line: pendingLine });
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
