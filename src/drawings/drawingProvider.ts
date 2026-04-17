import * as vscode from 'vscode';
import * as path from 'path';
import { DrawingManager } from './drawingManager';
import { SharedStore } from '../sync/sharedStore';

// ─── HTML ────────────────────────────────────────────────────────────────────

function buildDrawingHtml(
  extensionPath: string,
  webview: vscode.Webview,
  initialState: Record<string, unknown>
): string {
  const scriptUri = webview.asWebviewUri(
    vscode.Uri.file(path.join(extensionPath, 'dist', 'drawings.next.js'))
  );
  const serializedState = JSON.stringify(initialState).replace(/</g, '\\u003c');

  return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>Drawings</title>
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
  <div id="loading">Loading drawings…</div>
</div>
<script>
window.__vscodeApi = acquireVsCodeApi();
window.__ultraviewWebviewState = ${serializedState};
</script>
<script src="${scriptUri}"></script>
</body>
</html>`;
}

// ─── Provider ───────────────────────────────────────────────────────────────────────

export class DrawingProvider implements vscode.WebviewViewProvider {
  public static readonly viewId = 'ultraview.drawings';
  private _view?: vscode.WebviewView;

  constructor(
    private readonly ctx: vscode.ExtensionContext,
    private readonly drawingManager: DrawingManager
  ) {}

  resolveWebviewView(
    webviewView: vscode.WebviewView,
    _context: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken
  ): void {
    this._view = webviewView;
    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.file(path.join(this.ctx.extensionPath, 'dist'))],
    };

    const state = this._buildInitialState();
    webviewView.webview.html = buildDrawingHtml(this.ctx.extensionPath, webviewView.webview, state);

    webviewView.webview.onDidReceiveMessage(msg => this._handleMessage(msg, webviewView.webview));
  }

  private _buildInitialState() {
    const drawings = this.drawingManager.listSidebarDrawings();
    const wsPath = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? '';
    const projects = this.ctx.globalState.get<{ id: string; path: string; name: string }[]>(
      'ultraview.drawings.projects', []
    );
    return {
      drawings,
      activeWorkspace: wsPath,
      projects,
    };
  }

  private _handleMessage(msg: Record<string, unknown>, webview: vscode.Webview): void {
    switch (msg.type) {
      case 'ready':
        void this._sendDrawings(webview);
        break;
      case 'listDrawings':
        void this._sendDrawings(webview);
        break;
      case 'createDrawing':
        this._handleCreateDrawing(msg, webview);
        break;
      case 'deleteDrawing':
        this._handleDeleteDrawing(msg, webview);
        break;
      case 'renameDrawing':
        this._handleRenameDrawing(msg, webview);
        break;
      case 'saveDrawing':
        this._handleSaveDrawing(msg);
        break;
      case 'switchDrawing':
        this._handleSwitchDrawing(msg, webview);
        break;
      case 'moveDrawing':
        this._handleMoveDrawing(msg, webview);
        break;
      case 'getActiveWorkspace':
        void webview.postMessage({
          type: 'activeWorkspace',
          path: vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? '',
        });
        break;
      case 'openDrawingPanel':
        DrawingProvider.openDrawingPanel(this.ctx, this.drawingManager);
        break;
    }
  }

  private async _sendDrawings(webview: vscode.Webview): Promise<void> {
    const drawings = this.drawingManager.listSidebarDrawings();
    const wsPath = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? '';
    await webview.postMessage({ type: 'drawings', drawings, activeWorkspace: wsPath });
  }

  private _handleCreateDrawing(msg: Record<string, unknown>, webview: vscode.Webview): void {
    const name = String(msg.name ?? 'Untitled');
    const isProject = Boolean(msg.isProject);
    const projectId = isProject ? this.drawingManager.getOrCreateProjectId() : undefined;
    const drawing = this.drawingManager.createDrawing(name, projectId);
    void this._sendDrawings(webview);
    void webview.postMessage({ type: 'drawingCreated', drawing });
  }

  private _handleDeleteDrawing(msg: Record<string, unknown>, webview: vscode.Webview): void {
    this.drawingManager.deleteDrawing(String(msg.id));
    void this._sendDrawings(webview);
  }

  private _handleRenameDrawing(msg: Record<string, unknown>, webview: vscode.Webview): void {
    this.drawingManager.renameDrawing(String(msg.id), String(msg.name));
    void this._sendDrawings(webview);
  }

  private _handleSaveDrawing(msg: Record<string, unknown>): void {
    const id = String(msg.id);
    const content = String(msg.content ?? '');
    this.drawingManager.saveDrawingContent(id, content);
  }

  private _handleSwitchDrawing(msg: Record<string, unknown>, webview: vscode.Webview): void {
    const drawing = this.drawingManager.getDrawing(String(msg.id));
    void webview.postMessage({ type: 'currentDrawing', drawing });
  }

  private _handleMoveDrawing(msg: Record<string, unknown>, webview: vscode.Webview): void {
    const id = String(msg.id);
    const target = msg.target as string | null;
    const projectId = target === 'global' ? undefined : (target ?? this.drawingManager.getOrCreateProjectId());
    this.drawingManager.moveDrawingToProject(id, projectId);
    void this._sendDrawings(webview);
  }

  // ── Open as editor panel ───────────────────────────────────────────────────

  static openDrawingPanel(
    ctx: vscode.ExtensionContext,
    drawingManager: DrawingManager
  ): void {
    const panel = vscode.window.createWebviewPanel(
      'ultraview.drawingsPanel',
      'Drawings',
      vscode.ViewColumn.One,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [vscode.Uri.file(path.join(ctx.extensionPath, 'dist'))],
      }
    );

    const drawings = drawingManager.listSidebarDrawings();
    const wsPath = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? '';
    panel.webview.html = buildDrawingHtml(ctx.extensionPath, panel.webview, {
      drawings,
      activeWorkspace: wsPath,
    });

    panel.webview.onDidReceiveMessage(msg => {
      switch (msg.type) {
        case 'listDrawings':
        case 'ready':
          void panel.webview.postMessage({
            type: 'drawings',
            drawings: drawingManager.listSidebarDrawings(),
            activeWorkspace: vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? '',
          });
          break;
        case 'createDrawing': {
          const name = String(msg.name ?? 'Untitled');
          const isProject = Boolean(msg.isProject);
          const projectId = isProject ? drawingManager.getOrCreateProjectId() : undefined;
          const drawing = drawingManager.createDrawing(name, projectId);
          void panel.webview.postMessage({ type: 'drawings', drawings: drawingManager.listSidebarDrawings() });
          void panel.webview.postMessage({ type: 'drawingCreated', drawing });
          break;
        }
        case 'deleteDrawing':
          drawingManager.deleteDrawing(String(msg.id));
          void panel.webview.postMessage({ type: 'drawings', drawings: drawingManager.listSidebarDrawings() });
          break;
        case 'renameDrawing':
          drawingManager.renameDrawing(String(msg.id), String(msg.name));
          void panel.webview.postMessage({ type: 'drawings', drawings: drawingManager.listSidebarDrawings() });
          break;
        case 'saveDrawing':
          drawingManager.saveDrawingContent(String(msg.id), String(msg.content ?? ''));
          break;
        case 'switchDrawing':
          void panel.webview.postMessage({ type: 'currentDrawing', drawing: drawingManager.getDrawing(String(msg.id)) });
          break;
        case 'moveDrawing': {
          const id = String(msg.id);
          const target = msg.target as string | null;
          const projectId = target === 'global' ? undefined : (target ?? drawingManager.getOrCreateProjectId());
          drawingManager.moveDrawingToProject(id, projectId);
          void panel.webview.postMessage({ type: 'drawings', drawings: drawingManager.listSidebarDrawings() });
          break;
        }
      }
    });
  }

  static refreshAllDrawings(ctx: vscode.ExtensionContext, drawingManager: DrawingManager): void {
    // Trigger a re-send to all webviews by posting a drawings message
    // The view reference is not retained here; callers should use the panel approach
  }
}
