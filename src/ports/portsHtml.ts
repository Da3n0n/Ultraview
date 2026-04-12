import * as vscode from 'vscode';
import { buildReactWebviewPage } from '../webview/shared/buildReactWebviewPage';

export function buildPortsHtml(extensionPath: string, webview: vscode.Webview): string {
  return buildReactWebviewPage({
    extensionPath,
    webview,
    bundleName: 'portsPanel',
    title: 'Ports & Processes',
    loadingLabel: 'Loading ports and processes...',
    initialState: {},
  });
}
