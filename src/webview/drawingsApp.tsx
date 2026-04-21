import * as React from 'react';
import * as ReactDOM from 'react-dom/client';
import { Tldraw, createTLStore, getSnapshot, loadSnapshot } from 'tldraw';

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
const SAVE_DEBOUNCE_MS = 300;

let currentDrawingId: string | null = null;
let lastSavedContent: string | null = null;
let currentStore: ReturnType<typeof createTLStore> | null = null;
let reactRoot: ReturnType<typeof ReactDOM.createRoot> | null = null;

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

function scheduleAutoSave(drawingId: string, store: ReturnType<typeof createTLStore>): void {
  flushSave(drawingId, store);
}

function flushSave(drawingId: string, store: ReturnType<typeof createTLStore>): void {
  if (!store) return;
  try {
    const content = JSON.stringify(getSnapshot(store));
    if (content !== lastSavedContent) {
      lastSavedContent = content;
      getVscode().postMessage({ type: 'saveDrawing', id: drawingId, content });
    }
  } catch { /* ignore */ }
}

function createStore(initialContent?: string) {
  const store = createTLStore();
  if (initialContent) {
    try {
      const parsed = JSON.parse(initialContent);
      loadSnapshot(store, parsed);
    } catch { /* ignore */ }
  }
  return store;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function mountTldraw(container: HTMLElement, store: any): void {
  if (reactRoot) {
    try { reactRoot.unmount(); } catch { /* ignore */ }
    reactRoot = null;
  }
  reactRoot = ReactDOM.createRoot(container);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  reactRoot.render(React.createElement(Tldraw, {
    store: store as any,
    inferDarkMode: isDarkMode(),
    cameraOptions: { wheelBehavior: 'zoom' },
    onMount: (editor: any) => {
      editor.user.updateUserPreferences({ animationSpeed: 0 });
    },
  }));
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
        --surface: var(--vscode-editor-background, rgba(30,30,30,.55));
        --surface2: var(--vscode-list-hoverBackground, rgba(255,255,255,.05));
        --border: var(--vscode-panel-border, rgba(128,128,128,.24));
        --text: var(--vscode-editor-foreground);
        --muted: var(--vscode-descriptionForeground);
        --accent: var(--vscode-textLink-foreground, #6ee7b7);
        --scrollbar: var(--vscode-scrollbarSlider-background, rgba(100,100,100,.4));
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
      /* tldraw - solid VS Code themed backgrounds, no blur */
      .tl-container { background: var(--vscode-editor-background) !important; }
      .tl-background { background: var(--vscode-editor-background) !important; }
      .tl-grid-dot { fill: var(--border) !important; }
      /* Top toolbar / header - solid background */
      .tl-header { background: var(--bg) !important; border-bottom: 1px solid var(--border) !important; }
      .tl-app-bar { background: var(--bg) !important; border-bottom: 1px solid var(--border) !important; }
      /* Bottom toolbar - solid background */
      .tl-bottombar { background: var(--bg) !important; border-top: 1px solid var(--border) !important; }
      /* Left toolbar */
      .tlui-layout__left { background: var(--bg) !important; }
      /* All panels - solid, no glass blur */
      .tl-panel, .tl-style-panel, .tl-layers { background: var(--bg) !important; border-color: var(--border) !important; backdrop-filter: none !important; }
      /* Context bar */
      .tl-context-bar { background: var(--bg) !important; backdrop-filter: none !important; }
      /* Remove blob/glass effects */
      .tl-blob { display: none !important; }
      .tl-overlay { background: var(--bg) !important; backdrop-filter: none !important; }
      /* Note containers - solid, no glass */
      .tl-note__container { background: var(--surface2) !important; opacity: 1 !important; }
      .tl-note__container::before { display: none !important; }
      /* Popovers / menus - solid, no blur */
      .tl-popover, .tl-menu { background: var(--bg) !important; border: 1px solid var(--border) !important; backdrop-filter: none !important; }
      /* Scrollbars */
      ::-webkit-scrollbar { width: 8px; height: 8px; }
      ::-webkit-scrollbar-track { background: transparent; }
      ::-webkit-scrollbar-thumb { background: var(--scrollbar); border-radius: 4px; }
      ::-webkit-scrollbar-thumb:hover { background: var(--vscode-scrollbarSlider-hoverBackground, rgba(120,120,120,.5)); }
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
    const newStore = createStore(drawing?.tldrawContent);
    currentStore = newStore;
    lastSavedContent = drawing?.tldrawContent ?? null;
    mountTldraw(container, newStore);

    const drawingId = state.activeDrawingId;
    newStore.listen(() => {
      scheduleAutoSave(drawingId, newStore);
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
      if (currentStore && currentDrawingId) {
        flushSave(currentDrawingId, currentStore);
      }
      const id = item.getAttribute('data-id');
      if (id) {
        currentDrawingId = id;
        saveEditorState({ activeDrawingId: id });
        setState({ activeDrawingId: id, filter: 'all' });
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
