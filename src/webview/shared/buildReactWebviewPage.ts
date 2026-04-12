import * as path from 'path';
import * as vscode from 'vscode';

interface ReactWebviewPageOptions {
    extensionPath: string;
    webview: vscode.Webview;
    bundleName: string;
    title: string;
    initialState: Record<string, unknown>;
    loadingLabel?: string;
}

export function buildReactWebviewPage(options: ReactWebviewPageOptions): string {
    const {
        extensionPath,
        webview,
        bundleName,
        title,
        initialState,
        loadingLabel = 'Loading...',
    } = options;

    const scriptUri = webview.asWebviewUri(
        vscode.Uri.file(path.join(extensionPath, 'dist', `${bundleName}.next.js`))
    );
    const serializedState = JSON.stringify(initialState).replace(/</g, '\\u003c');

    return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>${title}</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  html, body { width: 100%; height: 100%; overflow: hidden; }
  body {
    background: var(--vscode-editor-background);
    color: var(--vscode-editor-foreground);
    font: 13px/1.5 -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
  }
  #app { width: 100%; height: 100%; }
  #loading {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 100%;
    height: 100%;
    color: var(--vscode-descriptionForeground);
  }
</style>
</head>
<body>
<div id="app">
  <div id="loading">${loadingLabel}</div>
</div>
<script>
window.__vscodeApi = acquireVsCodeApi();
window.__ultraviewWebviewState = ${serializedState};
</script>
<script src="${scriptUri}"></script>
</body>
</html>`;
}
