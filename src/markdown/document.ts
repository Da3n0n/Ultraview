import * as vscode from 'vscode';

export class MarkdownDocument implements vscode.CustomDocument {
  private _content = '';
  private readonly _onDidChange = new vscode.EventEmitter<vscode.CustomDocumentEditEvent<MarkdownDocument>>();

  readonly onDidChange = this._onDidChange.event;

  constructor(public readonly uri: vscode.Uri) {}

  get content(): string {
    return this._content;
  }

  setContent(content: string): void {
    this._content = content;
    this._onDidChange.fire({
      document: this,
      undo: () => {},
      redo: () => {},
    });
  }

  dispose(): void {}
}
