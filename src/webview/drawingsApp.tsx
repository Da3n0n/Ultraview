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

let currentDrawingId: string | null = null;
let lastSavedContent: string | null = null;
let currentStore: ReturnType<typeof createTLStore> | null = null;
let reactRoot: ReturnType<typeof ReactDOM.createRoot> | null = null;

function upsertDrawing(drawings: SyncDrawing[], drawing: SyncDrawing): SyncDrawing[] {
  const index = drawings.findIndex(item => item.id === drawing.id);
  if (index === -1) return [...drawings, drawing];
  const next = [...drawings];
  next[index] = drawing;
  return next;
}

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

function getSortedDrawings(drawings: SyncDrawing[]): SyncDrawing[] {
  return [...drawings].sort((a, b) => {
    if (!a.projectId && b.projectId) return -1;
    if (a.projectId && !b.projectId) return 1;
    return b.updatedAt - a.updatedAt;
  });
}

function buildTabs(drawings: SyncDrawing[], activeId: string | null): string {
  const items = getSortedDrawings(drawings).map(d => {
    const active = d.id === activeId;
    const scope = d.projectId ? 'Project' : 'Global';
    return `<button class="drawing-tab${active ? ' active' : ''}" data-id="${d.id}" title="${escapeHtml(d.name)}">
      <span class="drawing-tab-label">${escapeHtml(d.name)}</span>
      <span class="drawing-tab-scope">${scope}</span>
      <span class="drawing-tab-delete delete-btn" data-id="${d.id}" title="Delete drawing">×</span>
    </button>`;
  }).join('');

  return items || '<div class="topbar-empty">No drawings yet</div>';
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
      appState = {
        ...appState,
        drawings: upsertDrawing(appState.drawings, {
          ...(appState.drawings.find(d => d.id === drawingId) ?? {
            id: drawingId,
            name: 'Untitled',
            createdAt: Date.now(),
            updatedAt: Date.now(),
          }),
          tldrawContent: content,
          updatedAt: Date.now(),
        }),
      };
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
      <div class="drawings-topbar">
        <div class="tabs-scroll" id="drawing-tabs">
          ${buildTabs(state.drawings, state.activeDrawingId)}
        </div>
        <div class="topbar-actions">
          <button class="icon-btn" id="btn-new" title="Add drawing">+</button>
          <div class="add-menu hidden" id="add-menu">
            <button class="add-menu-item" data-kind="global">New global drawing</button>
            <button class="add-menu-item" data-kind="project">New project drawing</button>
          </div>
        </div>
      </div>
      <div class="drawings-main${state.activeDrawingId ? '' : ' empty'}" id="main-area">
        ${state.activeDrawingId ? `
          <div id="tldraw-container"></div>
        ` : `
          <div class="empty-hint">
            <div style="font-size:24px;margin-bottom:8px">✏️</div>
            <div>Create a drawing from the + menu to get started</div>
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
        --bg: var(--vscode-editor-background);
        --surface: var(--vscode-sideBar-background, var(--vscode-editor-background));
        --surface2: var(--vscode-list-hoverBackground, rgba(255,255,255,.05));
        --border: var(--vscode-panel-border, rgba(128,128,128,.24));
        --text: var(--vscode-editor-foreground);
        --muted: var(--vscode-descriptionForeground);
        --accent: var(--vscode-button-background, var(--vscode-textLink-foreground, #6ee7b7));
        --accent-text: var(--vscode-button-foreground, #ffffff);
        --scrollbar: var(--vscode-scrollbarSlider-background, rgba(100,100,100,.4));
      }
      .drawings-root {
        display:flex;
        flex-direction:column;
        width:100%;
        height:100%;
        overflow:hidden;
        background:var(--bg);
      }
      .drawings-topbar {
        display:flex;
        align-items:center;
        gap:10px;
        min-height:56px;
        padding:10px 12px;
        border-bottom:1px solid var(--border);
        background:var(--surface);
        position:relative;
        z-index:1000;
      }
      .tabs-scroll {
        flex:1;
        min-width:0;
        display:flex;
        gap:8px;
        overflow-x:auto;
        overflow-y:hidden;
        padding-bottom:2px;
      }
      .topbar-empty {
        display:flex;
        align-items:center;
        color:var(--muted);
        font-size:12px;
        white-space:nowrap;
      }
      .drawing-tab {
        position:relative;
        display:flex;
        align-items:center;
        gap:8px;
        flex:0 0 auto;
        max-width:220px;
        padding:8px 12px;
        border:1px solid var(--accent);
        border-radius:999px;
        background:color-mix(in srgb, var(--accent) 18%, var(--surface) 82%);
        color:var(--text);
        cursor:pointer;
        transition:all .16s ease;
        font:inherit;
      }
      .drawing-tab:hover { filter:brightness(1.03); }
      .drawing-tab.active {
        border-color:var(--border);
        background:linear-gradient(180deg, rgba(255,255,255,.04), rgba(255,255,255,.015));
      }
      .drawing-tab-label {
        min-width:0;
        overflow:hidden;
        text-overflow:ellipsis;
        white-space:nowrap;
        font-size:12px;
        font-weight:600;
      }
      .drawing-tab-scope {
        flex:0 0 auto;
        padding:2px 7px;
        border-radius:999px;
        background:rgba(255,255,255,.08);
        color:var(--muted);
        font-size:10px;
        text-transform:uppercase;
        letter-spacing:.04em;
      }
      .drawing-tab-delete {
        flex:0 0 auto;
        display:inline-flex;
        align-items:center;
        justify-content:center;
        width:18px;
        height:18px;
        border-radius:999px;
        color:var(--muted);
        font-size:12px;
      }
      .drawing-tab-delete:hover { background:rgba(255,80,80,.15); color:#ff6b6b; }
      .topbar-actions {
        position:relative;
        flex:0 0 auto;
        z-index:1001;
      }
      .icon-btn {
        width:34px;
        height:34px;
        border-radius:10px;
        border:1px solid var(--accent);
        background:var(--accent);
        color:var(--accent-text);
        font:inherit;
        font-size:20px;
        line-height:1;
        cursor:pointer;
      }
      .icon-btn:hover { filter:brightness(1.05); }
      .add-menu {
        position:absolute;
        top:42px;
        right:0;
        display:flex;
        flex-direction:column;
        gap:4px;
        min-width:180px;
        padding:6px;
        border:1px solid var(--border);
        border-radius:12px;
        background:var(--surface);
        box-shadow:0 10px 30px rgba(0,0,0,.24);
        z-index:1002;
      }
      .add-menu.hidden { display:none; }
      .add-menu-item {
        border:none;
        border-radius:8px;
        background:transparent;
        color:var(--text);
        cursor:pointer;
        padding:9px 10px;
        text-align:left;
        font:inherit;
        font-size:12px;
      }
      .add-menu-item:hover { background:var(--surface2); }
      .empty-hint {
        flex:1;
        display:flex;
        flex-direction:column;
        align-items:center;
        justify-content:center;
        color:var(--muted);
        font-size:12px;
      }
      .drawings-main {
        flex:1;
        position:relative;
        overflow:hidden;
        background:var(--vscode-editor-background);
      }
      .drawings-main.empty {
        background:
          radial-gradient(circle at top left, rgba(255,255,255,.04), transparent 35%),
          var(--vscode-editor-background);
      }
      #tldraw-container { width:100%; height:100%; }
      .tl-container { background: var(--vscode-editor-background) !important; }
      .tl-background { background: var(--vscode-editor-background) !important; }
      .tl-grid-dot { fill: var(--border) !important; }
      .tlui-layout {
        --tl-color-panel: var(--surface) !important;
        --tl-color-low: var(--surface2) !important;
        --tl-color-muted-1: color-mix(in srgb, var(--surface) 88%, white 12%) !important;
        --tl-color-muted-2: color-mix(in srgb, var(--surface) 78%, white 22%) !important;
        --tl-color-overlay: rgba(0, 0, 0, 0.18) !important;
        --tl-color-text: var(--text) !important;
        --tl-color-text-3: var(--muted) !important;
        --tl-color-primary: var(--accent) !important;
        --tl-color-selected: color-mix(in srgb, var(--accent) 24%, transparent) !important;
        --tl-color-background: var(--vscode-editor-background) !important;
      }
      .tl-header {
        background: color-mix(in srgb, var(--surface) 94%, transparent) !important;
        border-bottom: 1px solid var(--border) !important;
        backdrop-filter: none !important;
      }
      .tl-app-bar {
        background: color-mix(in srgb, var(--surface) 94%, transparent) !important;
        border-bottom: 1px solid var(--border) !important;
      }
      .tl-bottombar {
        background: color-mix(in srgb, var(--surface) 94%, transparent) !important;
        border-top: 1px solid var(--border) !important;
      }
      .tlui-layout__left { background: color-mix(in srgb, var(--surface) 94%, transparent) !important; }
      .tlui-layout__top,
      .tlui-layout__bottom,
      .tlui-layout__left,
      .tlui-layout__right {
        backdrop-filter: none !important;
      }
      .tl-panel, .tl-style-panel, .tl-layers {
        background: color-mix(in srgb, var(--surface) 96%, transparent) !important;
        border-color: var(--border) !important;
        backdrop-filter: none !important;
        border-radius: 16px !important;
        box-shadow: 0 14px 40px rgba(0,0,0,.22) !important;
      }
      .tl-context-bar { background: var(--surface) !important; backdrop-filter: none !important; }
      .tl-blob { display: none !important; }
      .tl-overlay { background: var(--surface) !important; backdrop-filter: none !important; }
      .tl-note__container { background: var(--surface2) !important; opacity: 1 !important; }
      .tl-note__container::before { display: none !important; }
      .tl-popover, .tl-menu {
        background: color-mix(in srgb, var(--surface) 96%, transparent) !important;
        border: 1px solid var(--border) !important;
        backdrop-filter: none !important;
        border-radius: 14px !important;
        box-shadow: 0 16px 44px rgba(0,0,0,.26) !important;
      }
      .tlui-toolbar__tools__button,
      .tlui-kbd,
      .tlui-toolbar__extras__controls button {
        border-radius: 12px !important;
      }
      .tlui-toolbar__tools__button,
      .tlui-toolbar__extras__controls button {
        color: var(--text) !important;
      }
      .tlui-toolbar__tools__button:hover {
        background: color-mix(in srgb, var(--accent) 14%, var(--surface) 86%) !important;
      }
      .tlui-toolbar__tools__button[aria-checked='true'],
      .tlui-toolbar__tools__button[aria-selected='true'] {
        background: color-mix(in srgb, var(--accent) 22%, var(--surface) 78%) !important;
        color: var(--text) !important;
      }
      .tlui-toolbar__tools {
        padding: 6px !important;
        border-radius: 16px !important;
        border: 1px solid var(--border) !important;
        background: color-mix(in srgb, var(--surface) 96%, transparent) !important;
        box-shadow: 0 12px 30px rgba(0,0,0,.18) !important;
      }
      .tlui-toolbar__tools__button {
        color: var(--text) !important;
      }
      .tlui-style-panel__section,
      .tlui-help-menu,
      .tlui-navigation-panel,
      .tlui-actions-menu,
      .tlui-page-menu {
        border-radius: 14px !important;
      }
      .tlui-style-panel,
      .tlui-page-menu,
      .tlui-help-menu,
      .tlui-actions-menu,
      .tlui-navigation-panel {
        background: color-mix(in srgb, var(--surface) 96%, transparent) !important;
        border: 1px solid var(--border) !important;
        box-shadow: 0 12px 30px rgba(0,0,0,.18) !important;
      }
      .tlui-menu__group + .tlui-menu__group,
      .tlui-style-panel__section + .tlui-style-panel__section {
        border-top: 1px solid var(--border) !important;
      }
      .tlui-style-panel .tlui-button,
      .tlui-style-panel .tlui-menu__button,
      .tlui-style-panel .tlui-popover__button,
      .tlui-page-menu .tlui-button,
      .tlui-page-menu .tlui-menu__button,
      .tlui-page-menu .tlui-popover__button {
        color: var(--text) !important;
        background: transparent !important;
      }
      .tlui-style-panel .tlui-button:hover,
      .tlui-style-panel .tlui-menu__button:hover,
      .tlui-style-panel .tlui-popover__button:hover,
      .tlui-page-menu .tlui-button:hover,
      .tlui-page-menu .tlui-menu__button:hover,
      .tlui-page-menu .tlui-popover__button:hover {
        background: var(--surface2) !important;
      }
      .tlui-style-panel [data-state='open'],
      .tlui-style-panel [aria-checked='true'],
      .tlui-style-panel [aria-selected='true'],
      .tlui-page-menu [data-state='open'],
      .tlui-page-menu [aria-checked='true'],
      .tlui-page-menu [aria-selected='true'] {
        background: color-mix(in srgb, var(--surface2) 88%, transparent) !important;
      }
      .tlui-kbd {
        background: var(--surface2) !important;
        border: 1px solid var(--border) !important;
        color: var(--muted) !important;
        box-shadow: none !important;
      }
      .tlui-menu,
      .tlui-style-panel,
      .tlui-help-menu,
      .tlui-actions-menu {
        color: var(--text) !important;
      }
      .tlui-slider__track,
      .tlui-slider__thumb {
        color: var(--accent) !important;
      }
      .tlui-minimap {
        border-radius: 16px !important;
        overflow: hidden !important;
        border: 1px solid var(--border) !important;
        background: var(--surface) !important;
      }
      .tlui-navigation-panel {
        background: var(--surface) !important;
        border: 1px solid var(--border) !important;
        box-shadow: 0 12px 28px rgba(0,0,0,.18) !important;
      }
      ::-webkit-scrollbar { width: 8px; height: 8px; }
      ::-webkit-scrollbar-track { background: transparent; }
      ::-webkit-scrollbar-thumb { background: var(--scrollbar); border-radius: 4px; }
      ::-webkit-scrollbar-thumb:hover {
        background: var(--vscode-scrollbarSlider-hoverBackground, rgba(120,120,120,.5));
      }
      @media (max-width: 640px) {
        .drawings-topbar { padding:8px; gap:8px; }
        .drawing-tab { max-width:180px; padding:7px 10px; }
        .drawing-tab-scope { display:none; }
      }
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

  const addMenu = document.getElementById('add-menu');
  document.getElementById('btn-new')?.addEventListener('click', (event) => {
    event.stopPropagation();
    addMenu?.classList.toggle('hidden');
  });

  document.querySelectorAll('.add-menu-item').forEach(item => {
    item.addEventListener('click', () => {
      const kind = item.getAttribute('data-kind');
      addMenu?.classList.add('hidden');
      getVscode().postMessage({ type: 'requestNewDrawingName', isProject: kind === 'project' });
    });
  });

  document.addEventListener('click', () => addMenu?.classList.add('hidden'), { once: true });

  document.querySelectorAll('.drawing-tab').forEach(item => {
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
        setState({ activeDrawingId: id });
        getVscode().postMessage({ type: 'switchDrawing', id });
      }
    });
  });
}

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
    appState = {
      ...appState,
      activeDrawingId: drawing.id,
      drawings: upsertDrawing(appState.drawings, drawing),
    };
    saveEditorState({ activeDrawingId: drawing.id });
    renderApp(appState, setState);
  }

  if (msg.type === 'drawingCreated') {
    const drawing = msg.drawing as SyncDrawing;
    currentDrawingId = drawing.id;
    appState = {
      ...appState,
      activeDrawingId: drawing.id,
      drawings: upsertDrawing(appState.drawings, drawing),
    };
    saveEditorState({ activeDrawingId: drawing.id });
    renderApp(appState, setState);
    getVscode().postMessage({ type: 'switchDrawing', id: drawing.id });
  }

  if (msg.type === 'drawingSaved' && msg.drawing) {
    const drawing = msg.drawing as SyncDrawing;
    lastSavedContent = drawing.tldrawContent ?? null;
    appState = {
      ...appState,
      drawings: upsertDrawing(appState.drawings, drawing),
    };
  }
});

const loadingEl = document.getElementById('loading');
if (loadingEl) loadingEl.style.display = 'none';
