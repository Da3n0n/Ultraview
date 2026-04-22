import * as vscode from 'vscode';
import { buildReactWebviewPage } from './shared/buildReactWebviewPage';

export function buildDbHtml(
  extensionPath: string,
  webview: vscode.Webview,
  dbType: string,
  sourceLabel?: string
): string {
  return buildReactWebviewPage({
    extensionPath,
    webview,
    bundleName: 'db',
    title: `${dbType} Viewer`,
    loadingLabel: `Loading ${dbType} viewer...`,
    initialState: { dbType, sourceLabel },
  });
}
