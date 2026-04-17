import {
  Tldraw,
  createTLStore,
  defaultShapeUtils,
  defaultBindingUtils,
  TLUiComponents,
  TLUiOverrides,
  insertMediaIntoCanvas,
} from 'tldraw';
import 'tldraw/tldraw.css';
import 'tldraw/editor.css';
import 'tldraw/ui.css';

declare global {
  interface Window {
    acquireVsCodeApi: () => { postMessage: (msg: Record<string, unknown>) => void };
    __vscodeApi?: { postMessage: (msg: Record<string, unknown>) => void };
    __ultraviewWebviewState?: {
      drawings: SyncDrawing[];
      activeWorkspace: string;
      projects: { id: string; path: string; name: string }[];
    };
  }
}

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

function getVscode(): { postMessage: (msg: Record<string, unknown>) => void } | undefined {
  return window.__vscodeApi || window.acquireVsCodeApi?.();
}

const STORAGE_KEY = 'ultraview.drawings.editorState';
const SAVE_DEBOUNCE_MS = 1200;

let currentDrawingId: string | null = null;
let saveTimer: ReturnType<typeof setTimeout> | null = null;
let lastSavedContent: string | null = null;

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
  filter: 'all' | 'global' | 'project',
  activeWorkspace: string
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

function createTldrawContainer(): HTMLElement {
  const el = document.createElement('div');
  el.id = 'tldraw-container';
  return el;
}

let tldrawInstance: Tldraw | null = null;

function createTldrawInstance(
  container: HTMLElement,
  initialContent?: string
): Tldraw {
  const store = createTLStore({
    shapes: defaultShapeUtils,
    bindings: defaultBindingUtils,
  });

  let parsedContent: Record<string, unknown> | undefined;
  if (initialContent) {
    try {
      parsedContent = JSON.parse(initialContent);
    } catch { /* ignore */ }
  }

  const components: TLUiComponents = {
    // Customize toolbar if needed
  };

  const instance = new Tldraw({
    container,
    store,
    components,
    inferDarkMode: () => {
      const bg = getComputedStyle(document.body).backgroundColor;
      return isDarkColor(bg);
    },
  });

  if (parsedContent) {
    try {
      store.loadSnapshot(parsedContent as Parameters<typeof store.loadSnapshot>[0]);
    } catch { /* ignore */ }
  }

  return instance;
}

function isDarkColor(color: string): boolean {
  if (!color || color === 'transparent') return true;
  const match = color.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/);
  if (!match) return true;
  const [, r, g, b] = match.map(Number);
  const luminance = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
  return luminance < 0.5;
}

function scheduleAutoSave(drawingId: string, store: ReturnType<typeof createTLStore>): void {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try {
      const snapshot = store.getSnapshot();
      const content = JSON.stringify(snapshot);
      if (content !== lastSavedContent) {
        lastSavedContent = content;
        getVscode()?.postMessage({ type: 'saveDrawing', id: drawingId, content });
      }
    } catch { /* ignore */ }
  }, SAVE_DEBOUNCE_MS);
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
          ${buildSidebarList(state.drawings, state.activeDrawingId, state.filter, state.activeWorkspace)}
        </div>
      </div>
      <div class="drawings-editor" id="editor-area">
        ${state.sidebarView === 'editor' && state.activeDrawingId ? '' : `
          <div class="editor-placeholder">
            <div class="placeholder-inner">
              <div style="font-size:32px;margin-bottom:12px">✏️</div>
              <div style="font-size:13px;opacity:.7">Select a drawing from the sidebar or create a new one</div>
            </div>
          </div>
        `}
      </div>
    </div>
  `;

  // Style injection
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
        background:transparent; color:var(--vscode-descriptionForeground);
        border:1px solid transparent; }
      .filter-btn.active { background:var(--vscode-button-background,rgba(0,120,212,.9)); color:#fff; }
      .filter-btn:hover:not(.active) { background:var(--vscode-list-hoverBackground,rgba(255,255,255,.05)); }
      .drawing-list { flex:1; overflow-y:auto; padding:4px 0; }
      .drawing-item { display:flex; align-items:center; gap:4px; padding:6px 10px; cursor:pointer;
        transition:background .1s; }
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
      #tldraw-container { width:100%; height:100%; }
      .tldraw { width:100%; height:100%; }
    `;
    document.head.appendChild(style);
  }

  // If editor mode, mount tldraw
  if (state.sidebarView === 'editor' && state.activeDrawingId) {
    const editorArea = document.getElementById('editor-area')!;
    editorArea.innerHTML = '';
    const container = createTldrawContainer();
    editorArea.appendChild(container);

    const drawing = state.drawings.find(d => d.id === state.activeDrawingId);
    const initialContent = drawing?.tldrawContent;

    // Dispose old instance
    if (tldrawInstance) {
      tldrawInstance.dispose();
      tldrawInstance = null;
    }

    tldrawInstance = createTldrawInstance(container, initialContent);
    lastSavedContent = initialContent ?? null;

    // Listen for changes
    tldrawInstance.store.listen(() => {
      if (state.activeDrawingId && tldrawInstance) {
        scheduleAutoSave(state.activeDrawingId, tldrawInstance.store);
      }
    });
  }

  // Bind events
  document.getElementById('btn-new')?.addEventListener('click', () => {
    const name = prompt('Drawing name:', 'Untitled');
    if (name) {
      const isProject = state.filter === 'project';
      getVscode()?.postMessage({ type: 'createDrawing', name, isProject });
    }
  });

  document.getElementById('btn-open-panel')?.addEventListener('click', () => {
    getVscode()?.postMessage({ type: 'openDrawingPanel' });
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
          getVscode()?.postMessage({ type: 'deleteDrawing', id });
        }
        return;
      }
      const id = item.getAttribute('data-id');
      if (id) {
        currentDrawingId = id;
        saveEditorState({ activeDrawingId: id, sidebarView: 'editor' });
        setState({ activeDrawingId: id, sidebarView: 'editor' });
        getVscode()?.postMessage({ type: 'switchDrawing', id });
      }
    });
  });
}

// ─── Mount ─────────────────────────────────────────────────────────────────────

const initState = getSavedState();
const webviewState = window.__ultraviewWebviewState ?? { drawings: [], activeWorkspace: '' };

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

// Request drawings list
getVscode()?.postMessage({ type: 'listDrawings' });

// Handle messages from extension
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
    getVscode()?.postMessage({ type: 'switchDrawing', id: drawing.id });
  }
});

// Hide loading
const loadingEl = document.getElementById('loading');
if (loadingEl) loadingEl.style.display = 'none';
