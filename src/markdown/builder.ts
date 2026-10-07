import * as vscode from 'vscode';
import { getMarkdownSettings } from '../settings/markdownSettings';
import { buildReactWebviewPage } from '../webview/shared/buildReactWebviewPage';
import type { MarkdownViewMode } from '../webview/markdown/types';

export function buildEditorPage(
  extensionPath: string,
  webview: vscode.Webview,
  initialContent = '',
  viewMode?: MarkdownViewMode
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
      viewMode,
    },
  });
}
