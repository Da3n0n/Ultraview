import * as vscode from 'vscode';
import { buildReactWebviewPage } from '../webview/shared/buildReactWebviewPage';

export function buildCommandsHtml(extensionPath: string, webview: vscode.Webview): string {
  return buildReactWebviewPage({
    extensionPath,
    webview,
    bundleName: 'commandsPanel',
    title: 'Ultraview Commands',
    loadingLabel: 'Loading commands...',
    initialState: {},
  });
}
