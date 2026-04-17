import * as React from 'react';
import tldraw from 'tldraw';

import 'tldraw/tldraw.css';

interface SyncDrawing {
  id: string;
  name: string;
  projectId?: string;
  createdAt: number;
  updatedAt: number;
  tldrawContent?: string;
}

interface AppState {
  drawings: SyncDrawing[];
  activeWorkspace: string;
  activeDrawingId: string | null;
  sidebarView: 'list' | 'editor';
  filter: 'all' | 'global' | 'project';
}

declare const acquireVsCodeApi: () => { postMessage: (msg: Record<string, unknown>) => void };
declare const __ultraviewWebviewState: {
  drawings: SyncDrawing[];
  activeWorkspace: string;
  projects: { id: string; path: string; name: string }[];
};

function getVscode(): { postMessage: (msg: Record<string, unknown>) => void } {
  return (window as unknown as { __vscodeApi?: { postMessage: (msg: Record<string, unknown>) => void } }).__vscodeApi
    ?? acquireVsCodeApi();
}

const STORAGE_KEY = 'ultraview.drawings.editorState';
const SAVE_DEBOUNCE_MS = 1200;

let currentDrawingId: string | null = null;
let saveTimer: ReturnType<typeof setTimeout> | null = null;
let lastSavedContent: string | null = null;
let currentStore: ReturnType<typeof tldraw.createTLStore> | null = null;
let reactRoot: { render: (el: unknown) => void; destroy: () => void } | null = null;

function getSavedState(): Partial<AppState> {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

function saveEditorState(state: Partial<AppState>): void {
  try {
    const current = getSavedState();
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ ...current, ...state }));
  } catch { /* ignore */ }
}

function buildSidebarList(
  drawings: SyncDrawing[],
  activeId: string | null,
  filter: 'all' | 'global' | 'project'
): string {
  const filtered = drawings.filter(d => {
    if (filter === 'global') return !d.projectId;
    if (filter === 'project') return !!d.projectId;
    return true;
  });

  const sorted = [...filtered].sort((a, b) => {
    if (!a.projectId && b.projectId) return -1;
    if (a.projectId && !b.projectId) return 1;
    return b.updatedAt - a.updatedAt;
  });

  const items = sorted.map(d => {
    const isGlobal = !d.projectId;
    const label = escapeHtml(d.name);
    const date = new Date(d.updatedAt).toLocaleDateString();
    const active = d.id === activeId;
    return `<div class="drawing-item${active ? ' active' : ''}" data-id="${d.id}">
      <div class="drawing-info">
        <div class="drawing-name">${label}</div>
        <div class="drawing-meta">${isGlobal ? '🌐 Global' : '📁 Project'} · ${date}</div>
      </div>
      <button class="drawing-action delete-btn" data-id="${d.id}" title="Delete drawing">×</button>
    </div>`;
  }).join('');

  return items || '<div class="empty-hint">No drawings yet. Click + to create one.</div>';
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function isDarkMode(): boolean {
  const bg = getComputedStyle(document.body).backgroundColor;
  if (!bg || bg === 'transparent') return true;
  const match = bg.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/);
  if (!match) return true;
  const luminance = (0.299 * Number(match[1]) + 0.587 * Number(match[2]) + 0.114 * Number(match[3])) / 255;
  return luminance < 0.5;
}

function scheduleAutoSave(drawingId: string): void {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try {
      if (!currentStore) return;
      const content = JSON.stringify(currentStore.getSnapshot());
      if (content !== lastSavedContent) {
        lastSavedContent = content;
        getVscode().postMessage({ type: 'saveDrawing', id: drawingId, content });
      }
    } catch { /* ignore */ }
  }, SAVE_DEBOUNCE_MS);
}

function createStore(initialContent?: string) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let initialData: any = undefined;
  if (initialContent) {
    try {
      initialData = JSON.parse(initialContent);
    } catch { /* ignore */ }
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (tldraw.createTLStore as any)({
    initialData,
    shapes: tldraw.defaultShapeUtils,
    bindings: tldraw.defaultBindingUtils,
  });
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function mountTldraw(container: HTMLElement, store: any): void {
  // Destroy previous root
  if (reactRoot) {
    try { reactRoot.destroy(); } catch { /* ignore */ }
    reactRoot = null;
  }

  // React 18 createRoot
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const ReactDOM = (window as any).ReactDOM as { createRoot?: (el: HTMLElement) => { render: (el: unknown) => void; destroy: () => void } } | undefined;
  if (ReactDOM?.createRoot) {
    reactRoot = ReactDOM.createRoot(container);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    reactRoot.render(React.createElement(tldraw.Tldraw, {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      store: store as any,
      inferDarkMode: isDarkMode(),
    }));
    (window as unknown as { __tldrawRoot?: typeof reactRoot }).__tldrawRoot = reactRoot;
  } else {
    // Fallback: use tldraw as a web component-like mount
    const tdEl = document.createElement('div');
    tdEl.style.width = '100%';
    tdEl.style.height = '100%';
    container.appendChild(tdEl);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    new (tldraw.Tldraw as any)({ container: tdEl, store, inferDarkMode: isDarkMode() });
  }
}

function renderApp(state: AppState, setState: (s: Partial<AppState>) => void): void {
  const app = document.getElementById('app')!;

  app.innerHTML = `
    <div class="drawings-root">
      <div class="drawings-sidebar">
        <div class="sidebar-header">
          <span class="sidebar-title">Drawings</span>
          <div class="sidebar-actions">
            <button class="icon-btn" id="btn-open-panel" title="Open as panel">⧉</button>
            <button class="icon-btn primary" id="btn-new" title="New drawing">+</button>
          </div>
        </div>
        <div class="sidebar-filters">
          <button class="filter-btn${state.filter === 'all' ? ' active' : ''}" data-filter="all">All</button>
          <button class="filter-btn${state.filter === 'global' ? ' active' : ''}" data-filter="global">Global</button>
          <button class="filter-btn${state.filter === 'project' ? ' active' : ''}" data-filter="project">Project</button>
        </div>
        <div class="drawing-list" id="drawing-list">
          ${buildSidebarList(state.drawings, state.activeDrawingId, state.filter)}
        </div>
      </div>
      <div class="drawings-editor" id="editor-area">
        ${state.sidebarView === 'editor' && state.activeDrawingId ? '' : `
          <div class="editor-placeholder">
            <div class="placeholder-inner">
              <div style="font-size:32px;margin-bottom:12px">✏️</div>
              <div style="font-size:13px;opacity:.7">Select a drawing or create a new one</div>
            </div>
          </div>
        `}
      </div>
    </div>
  `;

  if (!document.getElementById('drawings-styles')) {
    const style = document.createElement('style');
    style.id = 'drawings-styles';
    style.textContent = `
      .drawings-root { display:flex; width:100%; height:100%; overflow:hidden; }
      .drawings-sidebar { width:220px; min-width:180px; max-width:300px; display:flex; flex-direction:column;
        border-right:1px solid var(--vscode-panel-border,rgba(128,128,128,.25));
        background:var(--vscode-sideBar-background,var(--vscode-editor-background)); overflow:hidden; }
      .sidebar-header { display:flex; align-items:center; justify-content:space-between;
        padding:8px 10px; border-bottom:1px solid var(--vscode-panel-border,rgba(128,128,128,.2)); flex-shrink:0; }
      .sidebar-title { font-weight:600; font-size:12px; }
      .sidebar-actions { display:flex; gap:4px; }
      .icon-btn { width:22px; height:22px; border:none; border-radius:4px; cursor:pointer; font-size:14px;
        display:flex; align-items:center; justify-content:center;
        background:var(--vscode-button-secondaryBackground,rgba(128,128,128,.15));
        color:var(--vscode-editor-foreground); }
      .icon-btn.primary { background:var(--vscode-button-background,rgba(0,120,212,.9)); color:#fff; }
      .icon-btn:hover { opacity:.8; }
      .sidebar-filters { display:flex; gap:2px; padding:6px 8px;
        border-bottom:1px solid var(--vscode-panel-border,rgba(128,128,128,.15)); flex-shrink:0; }
      .filter-btn { flex:1; padding:3px 0; border:none; border-radius:4px; cursor:pointer; font-size:10px;
        background:transparent; color:var(--vscode-descriptionForeground); border:1px solid transparent; }
      .filter-btn.active { background:var(--vscode-button-background,rgba(0,120,212,.9)); color:#fff; }
      .filter-btn:hover:not(.active) { background:var(--vscode-list-hoverBackground,rgba(255,255,255,.05)); }
      .drawing-list { flex:1; overflow-y:auto; padding:4px 0; }
      .drawing-item { display:flex; align-items:center; gap:4px; padding:6px 10px; cursor:pointer; transition:background .1s; }
      .drawing-item:hover { background:var(--vscode-list-hoverBackground,rgba(255,255,255,.05)); }
      .drawing-item.active { background:var(--vscode-focusBackground,rgba(0,120,212,.2)); }
      .drawing-info { flex:1; min-width:0; }
      .drawing-name { font-size:11px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
      .drawing-meta { font-size:9px; opacity:.55; margin-top:2px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
      .drawing-action { border:none; background:transparent; cursor:pointer; font-size:12px; opacity:0;
        padding:2px 4px; border-radius:3px; color:var(--vscode-editor-foreground); }
      .drawing-item:hover .drawing-action { opacity:.6; }
      .drawing-action:hover { opacity:1; background:rgba(255,80,80,.15); }
      .empty-hint { padding:16px 10px; font-size:11px; color:var(--vscode-descriptionForeground);
        text-align:center; line-height:1.5; }
      .drawings-editor { flex:1; position:relative; overflow:hidden;
        background:var(--vscode-editor-background); }
      .editor-placeholder { width:100%; height:100%; display:flex; align-items:center; justify-content:center; }
      .placeholder-inner { text-align:center; color:var(--vscode-descriptionForeground); }
    `;
    document.head.appendChild(style);
  }

  if (state.sidebarView === 'editor' && state.activeDrawingId) {
    const editorArea = document.getElementById('editor-area')!;
    editorArea.innerHTML = '<div id="tldraw-container"></div>';
    const container = document.getElementById('tldraw-container')!;
    container.style.width = '100%';
    container.style.height = '100%';

    const drawing = state.drawings.find(d => d.id === state.activeDrawingId);
    currentStore = createStore(drawing?.tldrawContent);
    lastSavedContent = drawing?.tldrawContent ?? null;

    mountTldraw(container, currentStore);

    currentStore?.listen(() => {
      if (state.activeDrawingId) scheduleAutoSave(state.activeDrawingId);
    });
  }

  document.getElementById('btn-new')?.addEventListener('click', () => {
    const name = prompt('Drawing name:', 'Untitled');
    if (name) {
      const isProject = state.filter === 'project';
      getVscode().postMessage({ type: 'createDrawing', name, isProject });
    }
  });

  document.getElementById('btn-open-panel')?.addEventListener('click', () => {
    getVscode().postMessage({ type: 'openDrawingPanel' });
  });

  document.querySelectorAll('.filter-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      setState({ filter: btn.getAttribute('data-filter') as 'all' | 'global' | 'project' });
    });
  });

  document.querySelectorAll('.drawing-item').forEach(item => {
    item.addEventListener('click', (e) => {
      const target = e.target as HTMLElement;
      if (target.classList.contains('delete-btn')) {
        e.stopPropagation();
        const id = target.getAttribute('data-id');
        if (id && confirm('Delete this drawing?')) {
          getVscode().postMessage({ type: 'deleteDrawing', id });
        }
        return;
      }
      const id = item.getAttribute('data-id');
      if (id) {
        currentDrawingId = id;
        saveEditorState({ activeDrawingId: id, sidebarView: 'editor' });
        setState({ activeDrawingId: id, sidebarView: 'editor' });
        getVscode().postMessage({ type: 'switchDrawing', id });
      }
    });
  });
}

// ─── Boot ─────────────────────────────────────────────────────────────────────

const initState = getSavedState();
const webviewState = typeof __ultraviewWebviewState !== 'undefined'
  ? __ultraviewWebviewState
  : { drawings: [] as SyncDrawing[], activeWorkspace: '' };

let appState: AppState = {
  drawings: (webviewState.drawings ?? []) as SyncDrawing[],
  activeWorkspace: webviewState.activeWorkspace ?? '',
  activeDrawingId: initState.activeDrawingId ?? null,
  sidebarView: (initState.sidebarView ?? 'list') as 'list' | 'editor',
  filter: (initState.filter ?? 'all') as 'all' | 'global' | 'project',
};

function setState(patch: Partial<AppState>): void {
  appState = { ...appState, ...patch };
  renderApp(appState, setState);
}

const root = document.getElementById('app')!;
renderApp(appState, setState);

getVscode().postMessage({ type: 'listDrawings' });

window.addEventListener('message', (event: MessageEvent) => {
  const msg = event.data as Record<string, unknown>;

  if (msg.type === 'drawings') {
    appState = {
      ...appState,
      drawings: (msg.drawings as SyncDrawing[]) ?? [],
      activeWorkspace: typeof msg.activeWorkspace === 'string' ? msg.activeWorkspace : appState.activeWorkspace,
    };
    renderApp(appState, setState);
  }

  if (msg.type === 'currentDrawing' && msg.drawing) {
    const drawing = msg.drawing as SyncDrawing;
    currentDrawingId = drawing.id;
    appState = { ...appState, activeDrawingId: drawing.id, sidebarView: 'editor' };
    saveEditorState({ activeDrawingId: drawing.id, sidebarView: 'editor' });
    renderApp(appState, setState);
  }

  if (msg.type === 'drawingCreated') {
    const drawing = msg.drawing as SyncDrawing;
    currentDrawingId = drawing.id;
    appState = { ...appState, activeDrawingId: drawing.id, sidebarView: 'editor' };
    saveEditorState({ activeDrawingId: drawing.id, sidebarView: 'editor' });
    renderApp(appState, setState);
    getVscode().postMessage({ type: 'switchDrawing', id: drawing.id });
  }
});

const loadingEl = document.getElementById('loading');
if (loadingEl) loadingEl.style.display = 'none';
