import * as vscode from 'vscode';
import { getMarkdownSettings } from '../settings/markdownSettings';
import { buildReactWebviewPage } from '../webview/shared/buildReactWebviewPage';

export function buildEditorPage(
  extensionPath: string,
  webview: vscode.Webview,
  initialContent = ''
): string {
  const settings = getMarkdownSettings();
  return buildReactWebviewPage({
    extensionPath,
    webview,
    bundleName: 'markdown',
    title: 'Ultraview Markdown',
    loadingLabel: 'Loading markdown editor...',
    initialState: {
      settings,
      initialContent,
    },
  });
}
