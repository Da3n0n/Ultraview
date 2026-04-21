import * as React from 'react';
import * as ReactDOM from 'react-dom/client';
import { Tldraw, createTLStore, getSnapshot } from 'tldraw';

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

function scheduleAutoSave(drawingId: string): void {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try {
      if (!currentStore) return;
        const content = JSON.stringify(getSnapshot(currentStore));
      if (content !== lastSavedContent) {
        lastSavedContent = content;
        getVscode().postMessage({ type: 'saveDrawing', id: drawingId, content });
      }
    } catch { /* ignore */ }
  }, SAVE_DEBOUNCE_MS);
}

function createStore(initialContent?: string) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let snapshot: any = undefined;
  if (initialContent) {
    try {
      snapshot = JSON.parse(initialContent);
    } catch { /* ignore */ }
  }
  return createTLStore(snapshot ? { snapshot } : {});
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
      /* tldraw CSS overrides using VS Code theme variables */
      @import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap');
      .tl-container { background: var(--vscode-editor-background) !important; color: var(--text) !important; font-family: 'Inter', var(--vscode-font-family, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif) !important; }
      .tl-container * { color: var(--text) !important; font-family: inherit !important; }
      .tl-theme__dark, .tl-theme__light {
        /* Legacy tldraw variables */
        --tl-color-background: var(--vscode-editor-background) !important;
        --tl-color-panel: var(--vscode-sideBar-background) !important;
        --tl-color-panel-overlay: var(--vscode-sideBar-background) !important;
        --tl-color-panel-contrast: var(--vscode-panel-border, rgba(128,128,128,.24)) !important;
        --tl-color-low: var(--vscode-list-hoverBackground, rgba(255,255,255,.05)) !important;
        --tl-color-low-border: var(--vscode-panel-border, rgba(128,128,128,.24)) !important;
        --tl-color-muted-0: var(--vscode-editor-background) !important;
        --tl-color-muted-1: var(--surface2) !important;
        --tl-color-muted-2: var(--surface) !important;
        --tl-color-divider: var(--vscode-panel-border, rgba(128,128,128,.24)) !important;
        --tl-color-text: var(--vscode-editor-foreground) !important;
        --tl-color-text-0: var(--vscode-editor-foreground) !important;
        --tl-color-text-1: var(--vscode-editor-foreground) !important;
        --tl-color-text-3: var(--vscode-descriptionForeground) !important;
        --tl-color-selected: var(--accent) !important;
        --tl-color-focus: var(--accent) !important;
        --tl-color-primary: var(--accent) !important;
        --tl-color-success: #6ee7b7 !important;
        --tl-color-danger: #f87171 !important;
        --tl-color-warning: #fbbf24 !important;
        --tl-color-info: #7dd3fc !important;
        --tl-color-grid: var(--vscode-panel-border, rgba(128,128,128,.24)) !important;
        --tl-color-brush-fill: rgba(255,255,255,0.1) !important;
        --tl-color-brush-stroke: var(--accent) !important;
        --tl-color-overlay: rgba(0,0,0,0.4) !important;
        --tl-color-selection-fill: var(--accent) !important;
        --tl-color-selection-stroke: var(--accent) !important;

        /* Modern tldraw v2.0+ variables */
        --color-background: var(--vscode-editor-background) !important;
        --color-panel: var(--vscode-sideBar-background) !important;
        --color-panel-overlay: var(--vscode-sideBar-background) !important;
        --color-panel-contrast: var(--vscode-panel-border, rgba(128,128,128,.24)) !important;
        --color-low: var(--vscode-list-hoverBackground, rgba(255,255,255,.05)) !important;
        --color-low-border: var(--vscode-panel-border, rgba(128,128,128,.24)) !important;
        --color-muted-0: var(--vscode-editor-background) !important;
        --color-muted-1: var(--surface2) !important;
        --color-muted-2: var(--surface) !important;
        --color-divider: var(--vscode-panel-border, rgba(128,128,128,.24)) !important;
        --color-text: var(--vscode-editor-foreground) !important;
        --color-text-0: var(--vscode-editor-foreground) !important;
        --color-text-1: var(--vscode-editor-foreground) !important;
        --color-text-3: var(--vscode-descriptionForeground) !important;
        --color-selected: var(--accent) !important;
        --color-focus: var(--accent) !important;
        --color-primary: var(--accent) !important;
        --color-success: #6ee7b7 !important;
        --color-danger: #f87171 !important;
        --color-warning: #fbbf24 !important;
        --color-info: #7dd3fc !important;
        --color-grid: var(--vscode-panel-border, rgba(128,128,128,.24)) !important;
        --color-brush-fill: rgba(255,255,255,0.1) !important;
        --color-brush-stroke: var(--accent) !important;
        --color-overlay: rgba(0,0,0,0.4) !important;
        --color-selection-fill: var(--accent) !important;
        --color-selection-stroke: var(--accent) !important;
      }
      .tl-theme__dark { background: var(--vscode-editor-background) !important; }
      .tl-theme__light { background: var(--vscode-editor-background) !important; }
      /* Toolbar / nav bars */
      .tl-header { background: var(--bg) !important; border-bottom: 1px solid var(--border) !important; }
      .tl-nav { background: var(--bg) !important; }
      .tl-nav__button { color: var(--text) !important; }
      .tl-nav__button:hover { background: var(--surface2) !important; }
      .tl-app-bar { background: var(--bg) !important; border-bottom: 1px solid var(--border) !important; }
      /* Bottom toolbar */
      .tl-bottombar { background: var(--bg) !important; border-top: 1px solid var(--border) !important; }
      .tl-tools { background: var(--bg) !important; }
      .tl-tool { background: transparent !important; color: var(--text) !important; }
      .tl-tool:hover { background: var(--surface2) !important; }
      .tl-tool[data-active="true"] { background: var(--accent) !important; color: #000 !important; }
      /* Panels */
      .tl-panel { background: var(--bg) !important; border-color: var(--border) !important; color: var(--text) !important; }
      .tl-style-panel { background: var(--bg) !important; border-left: 1px solid var(--border) !important; }
      .tl-style-panel__section { border-bottom: 1px solid var(--border) !important; }
      /* Inputs */
      .tl-input, input.tl-input { background: var(--surface) !important; border: 1px solid var(--border) !important; color: var(--text) !important; }
      .tl-input:focus, input.tl-input:focus { border-color: var(--accent) !important; outline: none !important; }
      /* Buttons */
      .tl-button, button.tl-button { background: var(--surface2) !important; border: 1px solid var(--border) !important; color: var(--text) !important; }
      .tl-button:hover, button.tl-button:hover { border-color: var(--accent) !important; }
      .tl-button[data-active="true"], button.tl-button[data-active="true"] { background: var(--accent) !important; color: #000 !important; border-color: var(--accent) !important; }
      /* Context bar */
      .tl-context-bar { background: var(--bg) !important; }
      /* Popovers / menus */
      .tl-popover { background: var(--bg) !important; border: 1px solid var(--border) !important; }
      .tl-menu { background: var(--bg) !important; border: 1px solid var(--border) !important; }
      .tl-menu-item { color: var(--text) !important; }
      .tl-menu-item:hover { background: var(--surface2) !important; }
      /* Color picker */
      .tl-color-picker { background: var(--surface) !important; border: 1px solid var(--border) !important; }
      .tl-color-swatch { border: 1px solid var(--border) !important; }
      .tl-color-swatch:hover { border-color: var(--accent) !important; }
      .tl-color-swatch[data-active="true"] { border-color: var(--accent) !important; box-shadow: 0 0 0 2px var(--accent) !important; }
      .tl-swatches { background: var(--bg) !important; }
      .tl-swatch { border: 1px solid var(--border) !important; }
      .tl-swatch:hover { border-color: var(--accent) !important; }
      /* Preferences / settings */
      .tl-preferences { background: var(--bg) !important; border-bottom: 1px solid var(--border) !important; }
      .tl-preference { color: var(--text) !important; }
      .tl-preference:hover { background: var(--surface2) !important; }
      .tl-settings { background: var(--bg) !important; border-bottom: 1px solid var(--border) !important; }
      .tl-settings__button { color: var(--text) !important; }
      .tl-settings__button:hover { background: var(--surface2) !important; }
      /* Text editor */
      .tl-text-edit { background: var(--surface) !important; color: var(--text) !important; border: 1px solid var(--border) !important; }
      /* Layers panel */
      .tl-layers { background: var(--bg) !important; }
      .tl-layers__item { color: var(--text) !important; }
      .tl-layers__item:hover { background: var(--surface2) !important; }
      .tl-layers__item[data-active="true"] { color: var(--accent) !important; }
      /* File menu / export */
      .tl-file-menu { background: var(--bg) !important; border: 1px solid var(--border) !important; }
      .tl-file-menu__button { color: var(--text) !important; }
      .tl-file-menu__button:hover { background: var(--surface2) !important; }
      /* Zoom controls */
      .tl-zoom-controls { background: var(--bg) !important; border: 1px solid var(--border) !important; }
      .tl-zoom-control { color: var(--text) !important; }
      .tl-zoom-control:hover { background: var(--surface2) !important; }
      /* Shortcuts */
      .tl-shortcut { color: var(--text) !important; background: var(--bg) !important; border: 1px solid var(--border) !important; }
      /* Spinner */
      .tl-spinner { border-color: var(--border) !important; border-top-color: var(--accent) !important; }
      /* Toast */
      .tl-toast { background: var(--bg) !important; border: 1px solid var(--border) !important; color: var(--text) !important; }
      /* Helpers / labels */
      .tl-helper { color: var(--muted) !important; }
      .tl-label { color: var(--text) !important; }
      /* Debug */
      .tl-debug { color: var(--muted) !important; }
      /* Selection */
      .tl-selection__bg { fill: var(--accent) !important; fill-opacity: 0.15 !important; stroke: var(--accent) !important; }
      .tl-selection__fg { stroke: var(--accent) !important; }
      /* Canvas background */
      .tl-background { background: var(--vscode-editor-background) !important; }
      .tl-grid-dot { fill: var(--border) !important; }
      /* Hyperlink button */
      .tl-hyperlink-button { color: var(--text) !important; }
      .tl-hyperlink-button:hover { color: var(--accent) !important; }
      /* Error boundary */
      .tl-error-boundary { background: var(--bg) !important; color: var(--text) !important; }
      /* Note container - solid background */
      .tl-note__container { background: var(--surface2) !important; opacity: 1 !important; }
      .tl-note__container::before { display: none !important; }
      /* Sticky note tool option - solid color */
      .tl-tool[data-testid="tool-StickyNote"], .tl-tool--note { background: var(--surface2) !important; }
      .tl-tool[data-testid="tool-StickyNote"]:hover, .tl-tool--note:hover { background: var(--accent) !important; }
      /* Left toolbar / tool panel */
      .tlui-layout__left { background: var(--bg) !important; }
      .tlui-button { background: var(--surface2) !important; color: var(--text) !important; border: 1px solid var(--border) !important; }
      .tlui-button:hover { border-color: var(--accent) !important; }
      .tlui-button[data-active="true"] { background: var(--accent) !important; color: #000 !important; border-color: var(--accent) !important; }
      /* Options panel header */
      .tlui-panel__header { background: var(--bg) !important; border-bottom: 1px solid var(--border) !important; color: var(--text) !important; }
      .tlui-panel__body { background: var(--bg) !important; }
      /* Tool button icon */
      .tlui-icon { color: var(--text) !important; }
      /* Helper text in tooltips */
      .tl-helper { color: var(--muted) !important; }
/* Debug */
      .tl-debug { color: var(--muted) !important; }
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
