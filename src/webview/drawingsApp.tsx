import * as React from 'react';
import { Tldraw } from 'tldraw';
import { createTLStore } from '@tldraw/editor';

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
let currentStore: ReturnType<typeof createTLStore> | null = null;
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
  return createTLStore({ initialData });
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
    reactRoot.render(React.createElement(Tldraw, {
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
    new (Tldraw as any)({ container: tdEl, store, inferDarkMode: isDarkMode() });
  }
}

function renderApp(state: AppState, setState: (s: Partial<AppState>) => void): void {
  const app = document.getElementById('app')!;

  app.innerHTML = `
    <div class="drawings-root">
      <div class="drawings-sidebar">
        <div id="sidebar-header">
          <button class="btn primary" id="btn-new" title="New drawing">+ New</button>
          <div class="filter-group">
            <button class="filter-btn${state.filter === 'all' ? ' active' : ''}" data-filter="all" title="All">A</button>
            <button class="filter-btn${state.filter === 'global' ? ' active' : ''}" data-filter="global" title="Global">G</button>
            <button class="filter-btn${state.filter === 'project' ? ' active' : ''}" data-filter="project" title="Project">P</button>
          </div>
        </div>
        <div class="drawing-list" id="drawing-list">
          ${buildSidebarList(state.drawings, state.activeDrawingId, state.filter)}
        </div>
      </div>
      <div class="drawings-main" id="main-area">
        ${state.activeDrawingId ? `
          <div id="tldraw-container"></div>
        ` : `
          <div class="empty-hint">
            <div style="font-size:24px;margin-bottom:8px">✏️</div>
            <div>Select a drawing to edit</div>
          </div>
        `}
      </div>
    </div>
  `;

  if (!document.getElementById('drawings-styles')) {
    const style = document.createElement('style');
    style.id = 'drawings-styles';
    style.textContent = `
      :root {
        --bg: var(--vscode-sideBar-background, var(--vscode-editor-background));
        --surface2: var(--vscode-list-hoverBackground, rgba(255,255,255,.05));
        --border: var(--vscode-panel-border, rgba(128,128,128,.24));
        --text: var(--vscode-editor-foreground);
        --muted: var(--vscode-descriptionForeground);
        --accent: var(--vscode-textLink-foreground, #6ee7b7);
      }
      .drawings-root { display:flex; width:100%; height:100%; overflow:hidden; }
      .drawings-sidebar { width:140px; display:flex; flex-direction:column;
        border-right:1px solid var(--border); background:var(--bg); overflow:hidden; }
      #sidebar-header { display:flex; flex-direction:column; gap:8px;
        padding:10px 10px; border-bottom:1px solid var(--border); flex-shrink:0; }
      .btn {
        border:1px solid var(--border); background:var(--surface2); color:var(--text); border-radius:6px; cursor:pointer;
        transition: all .14s ease; padding:6px 8px; font:inherit; font-size:10px; font-weight:600; text-align:center;
      }
      .btn:hover { border-color: var(--accent); }
      .btn.primary { background:var(--accent); color:#000; border-color:var(--accent); }
      .btn.primary:hover { background: color-mix(in srgb, var(--accent) 85%, white 15%); }
      .filter-group { display:flex; gap:3px; }
      .filter-btn { flex:1; padding:4px; border:1px solid var(--border); border-radius:4px; cursor:pointer; font-size:9px;
        background:transparent; color:var(--muted); text-align:center; font-weight:600; }
      .filter-btn.active { background:var(--accent); color:#000; border-color:var(--accent); }
      .filter-btn:hover:not(.active) { background:var(--surface2); }
      .drawing-list { flex:1; overflow-y:auto; padding:6px; display:flex; flex-direction:column; gap:4px; }
      .drawing-item { display:flex; flex-direction:column; gap:3px; padding:8px; cursor:pointer;
        border-radius:8px; border:1px solid var(--border);
        background:linear-gradient(180deg, rgba(255,255,255,.03), rgba(255,255,255,.015));
        transition: all .16s ease; }
      .drawing-item:hover { border-color: var(--accent); background:linear-gradient(180deg, rgba(255,255,255,.045), rgba(255,255,255,.02)); }
      .drawing-item.active { border-color: var(--accent); box-shadow: 0 0 0 1px rgba(110,231,183,.16); }
      .drawing-name { font-size:11px; font-weight:600; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
      .drawing-meta { font-size:9px; color:var(--muted); white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
      .drawing-action { border:none; background:transparent; cursor:pointer; font-size:10px; opacity:0;
        padding:2px 4px; border-radius:3px; color:var(--muted); align-self:flex-start; }
      .drawing-item:hover .drawing-action { opacity:1; }
      .drawing-action:hover { background:rgba(255,80,80,.15); color:#ff5050; }
      .empty-hint { flex:1; display:flex; flex-direction:column; align-items:center; justify-content:center;
        color:var(--muted); font-size:12px; }
      .drawings-main { flex:1; position:relative; overflow:hidden; background:var(--vscode-editor-background); }
      #tldraw-container { width:100%; height:100%; }
    `;
    document.head.appendChild(style);
  }

  if (state.activeDrawingId) {
    const mainArea = document.getElementById('main-area')!;
    mainArea.innerHTML = '<div id="tldraw-container"></div>';
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
    getVscode().postMessage({ type: 'requestNewDrawingName', isProject: state.filter === 'project' });
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
        saveEditorState({ activeDrawingId: id });
        setState({ activeDrawingId: id });
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
    appState = { ...appState, activeDrawingId: drawing.id };
    saveEditorState({ activeDrawingId: drawing.id });
    renderApp(appState, setState);
  }

  if (msg.type === 'drawingCreated') {
    const drawing = msg.drawing as SyncDrawing;
    currentDrawingId = drawing.id;
    appState = { ...appState, activeDrawingId: drawing.id };
    saveEditorState({ activeDrawingId: drawing.id });
    renderApp(appState, setState);
    getVscode().postMessage({ type: 'switchDrawing', id: drawing.id });
  }
});

const loadingEl = document.getElementById('loading');
if (loadingEl) loadingEl.style.display = 'none';
