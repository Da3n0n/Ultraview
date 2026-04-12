import * as vscode from 'vscode';
import { buildReactWebviewPage } from '../webview/shared/buildReactWebviewPage';

export function buildSvgEditorPage(
    extensionPath: string,
    webview: vscode.Webview,
    initialContent: string
): string {
    const cfg = vscode.workspace.getConfiguration('ultraview.svg');
    const defaultView = cfg.get<string>('defaultView', 'preview');

    return buildReactWebviewPage({
        extensionPath,
        webview,
        bundleName: 'svg',
        title: 'Ultraview SVG',
        loadingLabel: 'Loading SVG editor...',
        initialState: {
            defaultView,
            initialContent,
        },
    });
}
