import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { buildCodeGraph, buildCodeGraphStreaming } from '../codenode';
import { defaultCodeGraphSettings } from '../settings';
import { colorPickerStyle, colorPickerScript } from '../ui/colorPicker';

// ─── Types ──────────────────────────────────────────────────────────────────

interface GNode {
  id: string;
  label: string;
  type: string;  // 'ts'|'js'|'md'|'fn'|'url'|'cpp'|'py'|'rs'|'go'|… (extension or special type)
  filePath: string;
  parentId?: string;    // for function nodes, parent file id
  meta?: Record<string, unknown>;
}

interface GEdge {
  source: string;
  target: string;
  kind: 'import' | 'link' | 'call';
}

interface GraphData {
  nodes: GNode[];
  edges: GEdge[];
}

interface ProjectCodeGraphState {
  hideUI: boolean;
  hiddenTypes: string[];
  showFns: boolean;
  graphMode: 'normal' | 'codeflow';
  filterText: string;
  edgeDirection: 'straight' | 'curved' | 'arrow' | 'curved-arrow';
  repulsion: number;
  springLength: number;
  damping: number;
  centerPull: number;
}

const PROJECT_GRAPH_STATE_KEY = 'ultraview.codeGraph.uiState.v1';

const defaultProjectCodeGraphState: ProjectCodeGraphState = {
  hideUI: false,
  hiddenTypes: [],
  showFns: false,
  graphMode: 'normal',
  filterText: '',
  edgeDirection: 'straight',
  repulsion: 9000,
  springLength: 130,
  damping: 0.65,
  centerPull: 0.008
};

function getProjectGraphState(ctx: vscode.ExtensionContext): ProjectCodeGraphState {
  const saved = ctx.workspaceState.get<Partial<ProjectCodeGraphState>>(PROJECT_GRAPH_STATE_KEY) || {};
  const config = vscode.workspace.getConfiguration('ultraview');
  return {
    ...defaultProjectCodeGraphState,
    hideUI: config.get<boolean>('codeGraph.hideUI') ?? defaultProjectCodeGraphState.hideUI,
    hiddenTypes: config.get<string[]>('codeGraph.hiddenTypes') ?? defaultProjectCodeGraphState.hiddenTypes,
    ...saved
  };
}

async function saveProjectGraphState(
  ctx: vscode.ExtensionContext,
  partial: Partial<ProjectCodeGraphState>
): Promise<ProjectCodeGraphState> {
  const nextState = { ...getProjectGraphState(ctx), ...partial };
  await ctx.workspaceState.update(PROJECT_GRAPH_STATE_KEY, nextState);
  return nextState;
}

// ─── Parser ──────────────────────────────────────────────────────────────────

const IMPORT_RE = /(?:import|require)\s*(?:[^'"]*from\s*)?['"]([^'"]+)['"]/g;
const WIKILINK_RE = /\[\[([^\]|#]+?)(?:[|#][^\]]*)?\]\]/g;
const MDLINK_RE = /\[(?:[^\]]*)\]\(([^)]+)\)/g;
const FN_RE = /export\s+(?:async\s+)?(?:function|class)\s+(\w+)|export\s+const\s+(\w+)\s*[=:]/g;

function resolveImport(fromFile: string, imp: string, allFiles: Set<string>): string | null {
  if (imp.startsWith('.')) {
    const dir = path.dirname(fromFile);
    const base = path.resolve(dir, imp);
    for (const ext of ['', '.ts', '.tsx', '.js', '.jsx', '/index.ts', '/index.js']) {
      const candidate = base + ext;
      if (allFiles.has(candidate)) return candidate;
    }
  }
  return null;
}

function resolveMdLink(fromFile: string, link: string, allFiles: Set<string>): string | null {
  if (link.startsWith('http') || link.startsWith('#')) return null;
  const dir = path.dirname(fromFile);
  const candidate = path.resolve(dir, link.split('#')[0]);
  if (allFiles.has(candidate)) return candidate;
  return null;
}

function resolveWikiLink(fromFile: string, name: string, allFiles: Set<string>): string | null {
  const lower = name.toLowerCase();
  for (const f of allFiles) {
    const base = path.basename(f, path.extname(f)).toLowerCase();
    if (base === lower) return f;
  }
  return null;
}

function getFileLinesCached(filePath: string, cache: Map<string, string[]>): string[] | null {
  if (cache.has(filePath)) return cache.get(filePath) ?? null;
  try {
    const lines = fs.readFileSync(filePath, 'utf8').replace(/\r\n/g, '\n').split('\n');
    cache.set(filePath, lines);
    return lines;
  } catch {
    cache.set(filePath, []);
    return null;
  }
}

function buildNodeSnippet(filePath: string, meta: Record<string, unknown> | undefined, cache: Map<string, string[]>): Record<string, unknown> | undefined {
  if (!filePath) return meta;
  const lines = getFileLinesCached(filePath, cache);
  if (!lines || lines.length === 0) return meta;

  let startLine = typeof meta?.line === 'number' ? Math.max(1, Math.floor(meta.line)) : 1;
  let endLine = startLine;

  if (typeof meta?.line === 'number') {
    endLine = Math.min(lines.length, startLine + 2);
  } else {
    const firstNonEmpty = lines.findIndex(line => line.trim().length > 0);
    startLine = firstNonEmpty >= 0 ? firstNonEmpty + 1 : 1;
    endLine = Math.min(lines.length, startLine + 3);
  }

  const snippet = lines
    .slice(startLine - 1, endLine)
    .map(line => line.trimEnd())
    .join('\n')
    .trim();

  if (!snippet) return meta;
  return { ...(meta ?? {}), snippet, snippetStartLine: startLine };
}

async function buildGraph(includeFns: boolean): Promise<GraphData> {
  // Use the new universal code graph builder
  const cg = await buildCodeGraph();
  const snippetCache = new Map<string, string[]>();
  // Map CodeNode/CodeEdge to GNode/GEdge for the view
  const nodes: GNode[] = cg.nodes.map(n => {
    const meta = buildNodeSnippet(n.filePath ?? '', n.meta, snippetCache);
    // Preserve URL nodes so the webview can open external links
    if (n.type === 'url') {
      const url = (n.meta && typeof n.meta.url === 'string') ? n.meta.url : (typeof n.id === 'string' && n.id.startsWith('url:') ? n.id.slice(4) : (n.filePath ?? ''));
      return {
        id: n.id,
        label: n.label,
        type: 'url' as const,
        filePath: url,
        parentId: (meta && typeof meta.parent === 'string') ? meta.parent : undefined,
        meta
      } as GNode;
    }

    // Normalise variants → canonical type names
    let t = n.type;
    if (t === 'tsx')                                    t = 'ts';
    else if (['jsx', 'mjs', 'cjs'].includes(t))        t = 'js';
    else if (['mdx', 'markdown'].includes(t))          t = 'md';
    else if (['sqlite3', 'db3', 'ddb', 'mdb', 'accdb'].includes(t)) t = 'db';
    else if (['cc', 'cxx', 'cpp', 'hh', 'hpp'].includes(t)) t = 'cpp';
    else if (t === 'h')                                 t = 'c';
    else if (t === 'yml')                               t = 'yaml';
    else if (['bash', 'zsh'].includes(t))              t = 'sh';
    return {
      id: n.id,
      label: n.label,
      type: t,
      filePath: n.filePath ?? '',
      parentId: (meta && typeof meta.parent === 'string') ? meta.parent : undefined,
      meta
    } as GNode;
  });
  const edges: GEdge[] = cg.edges.map(e => ({
    source: e.source,
    target: e.target,
    kind: ['import', 'declares'].includes(e.kind) ? 'import'
        : e.kind === 'call' ? 'call'
        : 'link'
  }));
  return { nodes, edges };
}

// ─── HTML ────────────────────────────────────────────────────────────────────

function buildHtml(wsPath: string, initialState: ProjectCodeGraphState): string {
  return /* html */`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>Code Graph</title>
<style>
  *{box-sizing:border-box;margin:0;padding:0}
  html,body{width:100%;height:100%;overflow:hidden;
    background:var(--vscode-sideBar-background,var(--vscode-editor-background));
    color:var(--vscode-editor-foreground);
    font:12px/1.4 -apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif}
  #toolbar{
    position:fixed;top:0;left:0;right:0;height:36px;
    display:flex;align-items:center;gap:6px;padding:0 8px;
    background:var(--vscode-sideBar-background,var(--vscode-editor-background));
    border-bottom:1px solid var(--vscode-panel-border,rgba(128,128,128,.3));
    z-index:10;flex-shrink:0}
  #search{
    flex:1;min-width:0;padding:3px 7px;
    background:var(--vscode-input-background);
    color:var(--vscode-input-foreground);
    border:1px solid var(--vscode-input-border,rgba(128,128,128,.4));
    border-radius:4px;font-size:11px}
  #search:focus{outline:1px solid var(--vscode-focusBorder)}
  .tbtn{
    padding:3px 8px;border-radius:4px;cursor:pointer;font-size:11px;
    background:var(--vscode-button-secondaryBackground,rgba(128,128,128,.15));
    border:1px solid var(--vscode-panel-border,rgba(128,128,128,.3));
    color:var(--vscode-editor-foreground);white-space:nowrap}
  .tbtn:hover{background:var(--vscode-list-hoverBackground)}
  .tbtn.active{
    background:var(--vscode-button-background,rgba(0,120,212,.9));
    color:var(--vscode-button-foreground,#fff);
    border-color:transparent}
  #canvas-wrap{position:fixed;top:36px;left:0;right:0;bottom:24px}
  #c{display:block;width:100%;height:100%}
  #status{
    position:fixed;bottom:0;left:0;right:0;height:24px;
    display:flex;align-items:center;padding:0 10px;gap:16px;
    font-size:10px;color:var(--vscode-descriptionForeground);
    background:var(--vscode-statusBar-background,var(--vscode-sideBar-background));
    border-top:1px solid var(--vscode-panel-border,rgba(128,128,128,.2))}
  #tooltip{
    position:fixed;pointer-events:none;display:none;max-width:320px;
    padding:6px 10px;border-radius:5px;font-size:11px;line-height:1.5;
    background:var(--vscode-editorHoverWidget-background,#252526);
    border:1px solid var(--vscode-editorHoverWidget-border,rgba(128,128,128,.4));
    color:var(--vscode-editorHoverWidget-foreground,#ccc);z-index:20}
  #loading{
    position:fixed;inset:0;display:flex;flex-direction:column;
    align-items:center;justify-content:center;gap:12px;
    background:var(--vscode-sideBar-background,var(--vscode-editor-background));z-index:30}
  .spinner{
    width:28px;height:28px;border-radius:50%;
    border:3px solid var(--vscode-panel-border,rgba(128,128,128,.3));
    border-top-color:var(--vscode-textLink-foreground,#4ec9b0);
    animation:spin .7s linear infinite}
  @keyframes spin{to{transform:rotate(360deg)}}
  #settings-panel{
    position:fixed;top:44px;left:8px;bottom:32px;display:flex;flex-direction:column;
    gap:10px;font-size:11px;color:var(--vscode-descriptionForeground);
    background:var(--vscode-sideBar-background,rgba(30,30,30,.9));
    padding:10px;border-radius:8px;
    border:1px solid var(--vscode-panel-border,rgba(128,128,128,.25));
    width:240px;max-width:calc(100vw - 16px);overflow:hidden;z-index:10}
  .settings-hidden .graph-settings-only{display:none !important;}
  .legend-hidden #legend-section{display:none !important;}
  .panels-hidden #settings-panel{display:none !important;}
  .settings-scroll{display:flex;flex-direction:column;gap:10px;overflow:auto;padding-right:2px}
  .settings-section{
    display:flex;flex-direction:column;gap:6px;padding:8px;border-radius:8px;
    background:var(--vscode-editorWidget-background,rgba(255,255,255,.03));
    border:1px solid var(--vscode-panel-border,rgba(128,128,128,.18))}
  .leg{display:flex;align-items:center;gap:8px;cursor:pointer;padding:4px 6px;border-radius:4px}
  .leg:hover{background:var(--vscode-list-hoverBackground,rgba(255,255,255,.1))}
  .leg.hidden{opacity:0.4}
  #legend{display:flex;flex-direction:column;gap:4px}
  .dot{width:14px;height:14px;border-radius:50%;flex-shrink:0;border:1.5px solid rgba(255,255,255,.25)}
  .eye-toggle{width:16px;height:16px;display:flex;align-items:center;justify-content:center;cursor:pointer;flex-shrink:0;border-radius:3px;transition:background .15s;font-size:11px}
  .eye-toggle:hover{background:var(--vscode-list-hoverBackground,rgba(255,255,255,.15))}
  .eye-toggle.hidden{opacity:0.5}
  .setting-row{display:flex;flex-direction:column;gap:3px}
  .setting-row label{font-size:10px;opacity:.8;display:flex;justify-content:space-between}
  .setting-row input[type="range"]{
    width:100%;height:4px;border-radius:2px;
    background:var(--vscode-input-background,rgba(128,128,128,.2));
    -webkit-appearance:none;cursor:pointer}
  .setting-row input[type="range"]::-webkit-slider-thumb{
    -webkit-appearance:none;width:12px;height:12px;border-radius:50%;
    background:var(--vscode-button-background,rgba(0,120,212,.9));
    border:1px solid rgba(255,255,255,.3);cursor:pointer}
  .settings-header{font-weight:600;font-size:11px;margin-bottom:2px;opacity:.9}
  .settings-copy{font-size:10px;line-height:1.45;opacity:.8}
  .controls-list{display:flex;flex-direction:column;gap:4px;font-size:10px;line-height:1.45}
  .controls-list span{opacity:.72}
  #btn-settings{margin-left:auto;padding:4px 8px;border-radius:4px;cursor:pointer;font-size:12px;background:var(--vscode-button-secondaryBackground,rgba(128,128,128,.15));border:1px solid var(--vscode-panel-border,rgba(128,128,128,.3));color:var(--vscode-editor-foreground)}
  ${colorPickerStyle}
</style>
</head>
<body>
<div id="loading"><div class="spinner"></div><span>Scanning workspace…</span></div>
<div id="toolbar">
  <button class="tbtn" id="btn-refresh" title="Refresh graph">↻</button>
  <button class="tbtn" id="btn-fit"     title="Fit to screen">⊡</button>
  <button class="tbtn" id="btn-fns"     title="Toggle function nodes">ƒ( )</button>
  <input id="search" placeholder="Filter nodes…" autocomplete="off"/>
  <button class="tbtn" id="btn-panel"   title="Open as full panel">⬡</button>
  <button class="tbtn" id="btn-eye" title="Toggle UI">👁</button>
  <button class="tbtn" id="btn-codeflow" title="Switch to CodeFlow">⟷</button>
  <button id="btn-settings" title="Open VS Code Settings">⚙</button>
</div>
<div id="canvas-wrap"><canvas id="c"></canvas></div>
<div id="status">
  <span id="st-nodes">0 nodes</span>
  <span id="st-edges">0 edges</span>
  <span id="st-selected"></span>
</div>
<div id="tooltip"></div>
<div id="settings-panel">
  <div class="settings-header">Graph Settings</div>
  <div class="settings-copy">Dense projects are easier to read when the graph stays interactive. Use the canvas to drag groups apart and filter by type from the legend below.</div>
  <div class="settings-scroll">
    <div class="settings-section">
      <div class="settings-header">Connection Style</div>
      <div class="setting-row">
        <label><span>Edge Direction</span></label>
        <select id="edge-direction" style="background:var(--vscode-input-background);color:var(--vscode-input-foreground);border:1px solid var(--vscode-input-border);border-radius:4px;padding:2px 4px;font-size:11px;width:100%">
          <option value="straight">Straight</option>
          <option value="curved">Curved</option>
          <option value="arrow">Arrow</option>
          <option value="curved-arrow">Curved + Arrow</option>
        </select>
      </div>
    </div>
    <div class="settings-section">
      <div class="settings-header">Legend</div>
      <div class="settings-copy">Click a row to hide that type. Click the color dot to customize it.</div>
      <div id="legend">
        <!-- populated dynamically by buildLegend() based on what node types exist in this project -->
      </div>
    </div>
    <div class="settings-section">
      <div class="settings-header">Controls</div>
      <div class="controls-list">
        <div><strong>Left drag</strong> <span>move selected nodes or pan empty space</span></div>
        <div><strong>Right drag</strong> <span>box-select clusters you want to separate</span></div>
        <div><strong>Wheel</strong> <span>zoom toward the cursor</span></div>
        <div><strong>Fit</strong> <span>recenters everything after you reorganize the layout</span></div>
      </div>
    </div>
  </div>
</div>


<script>
${colorPickerScript}
(function(){
'use strict';

const INITIAL_STATE = ${JSON.stringify(initialState)};



// ── Type palette & colour helpers ───────────────────────────────────────────
const TYPE_DEFAULTS = {
  ts:    { color: '#4EC9B0', label: 'TypeScript' },
  js:    { color: '#F0DB4F', label: 'JavaScript' },
  md:    { color: '#C586C0', label: 'Markdown' },
  fn:    { color: '#DCDCAA', label: 'Function' },
  url:   { color: '#569CD6', label: 'URL' },
  db:    { color: '#CE9178', label: 'Database' },
  py:    { color: '#3572A5', label: 'Python' },
  rs:    { color: '#DEA584', label: 'Rust' },
  go:    { color: '#00ADD8', label: 'Go' },
  cpp:   { color: '#F34B7D', label: 'C++' },
  c:     { color: '#A97BFF', label: 'C' },
  cs:    { color: '#178600', label: 'C#' },
  java:  { color: '#B07219', label: 'Java' },
  rb:    { color: '#CC342D', label: 'Ruby' },
  php:   { color: '#4F5D95', label: 'PHP' },
  swift: { color: '#FA7343', label: 'Swift' },
  kt:    { color: '#A97BFF', label: 'Kotlin' },
  html:  { color: '#E34C26', label: 'HTML' },
  css:   { color: '#563D7C', label: 'CSS' },
  scss:  { color: '#C6538C', label: 'SCSS' },
  json:  { color: '#8BC34A', label: 'JSON' },
  yaml:  { color: '#FFA000', label: 'YAML' },
  sql:   { color: '#FF7043', label: 'SQL' },
  sh:    { color: '#4CAF50', label: 'Shell' },
  ps1:   { color: '#012456', label: 'PowerShell' },
  toml:  { color: '#9B59B6', label: 'TOML' },
};
function typeColor(t) {
  let h = 0;
  for (let i = 0; i < t.length; i++) h = (h * 31 + t.charCodeAt(i)) & 0xFFFF;
  return 'hsl(' + ((h * 137.5) % 360 | 0) + ',60%,62%)';
}
function getTypeColor(t) {
  return COLORS[t] || (TYPE_DEFAULTS[t] && TYPE_DEFAULTS[t].color) || typeColor(t);
}
const RADIUS_DEFAULTS = { ts: 9, js: 8, md: 9, fn: 6, url: 7, db: 8, cpp: 8, c: 8, py: 8 };
function getTypeRadius(t) { return RADIUS_DEFAULTS[t] || 7; }

// ── Runtime colour table (edge colours + user overrides; type colours seeded by buildLegend) ──
let COLORS = {
  edge_import: 'rgba(78,201,176,0.25)',
  edge_link:   'rgba(197,134,192,0.30)',
  edge_call:   'rgba(220,180,120,0.28)',
  selected: '#FFFFFF',
  hovered:  'rgba(255,255,255,0.85)',
};
// Pre-seed defaults so COLOR[type] works before the first buildLegend call
Object.keys(TYPE_DEFAULTS).forEach(function(t){ COLORS[t] = TYPE_DEFAULTS[t].color; });
let REPULSION   = 9000;
let SPRING_LEN  = { import: 130, link: 150, fn: 55, call: 90 };
let SPRING_K    = 0.20;
let DAMPING     = 0.65;
let CENTER_K    = 0.008;
const REPEL_CUTOFF= 350;
let ALPHA_DECAY = 0.994;  // may be tightened for large graphs
const MIN_ALPHA   = 0.001;
let EDGE_DIRECTION = 'straight';

// ── State ────────────────────────────────────────────────────────────────────
let nodes = [];   // { id, label, type, filePath, x, y, vx, vy, r, col, parentId?, pinned? }
let edges = [];   // { si, ti, kind }
let camera = { x: 0, y: 0, zoom: 1 };
let alpha  = 1.0;
let rafId  = null;
let hovered = -1;
let selected = -1;
let selectedNodes = new Set();  // multiple selected nodes (for box selection)
let filterText = '';
let showFns  = false;
let allNodes = [];  // full unfiltered
let hiddenTypes = new Set();  // types that are hidden
let allEdges = [];
let pressing = false;
let panStart = null;
let dragNode = -1;
let lastMouse = { x: 0, y: 0 };
let simRunning = false;
let boxSelect = null;  // { startX, startY, currentX, currentY } for right-click box selection

const vscode = acquireVsCodeApi();
const canvas = document.getElementById('c');
const ctx    = canvas.getContext('2d');
const tooltip = document.getElementById('tooltip');
const legacyUiToggle = document.getElementById('btn-eye');
let btnToggleSettings = null;
let btnToggleLegend = null;

function updatePanelToggleButtons() {
  if (btnToggleSettings) btnToggleSettings.classList.toggle('active', !document.body.classList.contains('settings-hidden'));
  if (btnToggleLegend) btnToggleLegend.classList.toggle('active', !document.body.classList.contains('legend-hidden'));
}

function syncPanelVisibility() {
  const hideSettings = document.body.classList.contains('settings-hidden');
  const hideLegend = document.body.classList.contains('legend-hidden');
  document.body.classList.toggle('panels-hidden', hideSettings && hideLegend);
  updatePanelToggleButtons();
}

function setupIndependentPanelToggles() {
  const settingsPanel = document.getElementById('settings-panel');
  const toolbarPanelButton = document.getElementById('btn-panel');
  if (!settingsPanel || !toolbarPanelButton) return;

  const introCopy = settingsPanel.querySelector('.settings-copy');
  if (introCopy) introCopy.classList.add('graph-settings-only');

  settingsPanel.querySelectorAll('.settings-section').forEach(function(section) {
    const title = section.querySelector('.settings-header');
    const label = title ? title.textContent.trim() : '';
    if (label === 'Legend') {
      section.id = 'legend-section';
    } else {
      section.classList.add('graph-settings-only');
    }
  });

  if (legacyUiToggle) {
    legacyUiToggle.style.display = 'none';
    legacyUiToggle.setAttribute('aria-hidden', 'true');
    legacyUiToggle.tabIndex = -1;
  }

  if (!document.getElementById('btn-toggle-legend')) {
    btnToggleLegend = document.createElement('button');
    btnToggleLegend.className = 'tbtn';
    btnToggleLegend.id = 'btn-toggle-legend';
    btnToggleLegend.title = 'Toggle node legend';
    btnToggleLegend.textContent = 'L';
    toolbarPanelButton.insertAdjacentElement('afterend', btnToggleLegend);
  } else {
    btnToggleLegend = document.getElementById('btn-toggle-legend');
  }

  if (!document.getElementById('btn-toggle-settings')) {
    btnToggleSettings = document.createElement('button');
    btnToggleSettings.className = 'tbtn';
    btnToggleSettings.id = 'btn-toggle-settings';
    btnToggleSettings.title = 'Toggle graph settings';
    btnToggleSettings.textContent = 'G';
    toolbarPanelButton.insertAdjacentElement('afterend', btnToggleSettings);
  } else {
    btnToggleSettings = document.getElementById('btn-toggle-settings');
  }
}

function updateSettingControls() {
  const edgeDirection = document.getElementById('edge-direction');
  if (edgeDirection) edgeDirection.value = EDGE_DIRECTION;
}

function applyInitialState(state) {
  if (!state) return;
  if (typeof state.showFns === 'boolean') {
    showFns = state.showFns;
    document.getElementById('btn-fns').classList.toggle('active', showFns);
  }
  if (typeof state.filterText === 'string') {
    filterText = state.filterText;
    document.getElementById('search').value = filterText;
  }
  if (Array.isArray(state.hiddenTypes)) {
    hiddenTypes = new Set(state.hiddenTypes);
  }
  if (typeof state.hideUI === 'boolean') {
    document.body.classList.toggle('settings-hidden', state.hideUI);
    document.body.classList.toggle('legend-hidden', state.hideUI);
  }
  if (typeof state.hideGraphSettings === 'boolean') document.body.classList.toggle('settings-hidden', state.hideGraphSettings);
  if (typeof state.hideLegend === 'boolean') document.body.classList.toggle('legend-hidden', state.hideLegend);
  if (typeof state.edgeDirection === 'string') EDGE_DIRECTION = state.edgeDirection;
  if (typeof state.repulsion === 'number') REPULSION = state.repulsion;
  if (typeof state.springLength === 'number') {
    const val = state.springLength;
    SPRING_LEN = { import: val, link: val * 1.15, fn: val * 0.42, call: val * 0.69 };
  }
  if (typeof state.damping === 'number') DAMPING = state.damping;
  if (typeof state.centerPull === 'number') CENTER_K = state.centerPull;
  syncPanelVisibility();
  updateSettingControls();
}

function saveProjectState(partial) {
  vscode.postMessage({ type: 'saveProjectState', state: partial });
}

setupIndependentPanelToggles();
applyInitialState(INITIAL_STATE);

// ── Resize ───────────────────────────────────────────────────────────────────
function resize(){
  const wrap = document.getElementById('canvas-wrap');
  canvas.width  = wrap.clientWidth  * devicePixelRatio;
  canvas.height = wrap.clientHeight * devicePixelRatio;
  canvas.style.width  = wrap.clientWidth  + 'px';
  canvas.style.height = wrap.clientHeight + 'px';
  render();
}
window.addEventListener('resize', resize);

// ── Load graph data ──────────────────────────────────────────────────────────
window.addEventListener('message', e => {
  const msg = e.data;

  // Handle live configuration updates from VS Code config listener
  if (msg.type === 'configUpdate') {
    let needsUpdate = false;
    if (msg.colors) {
      COLORS = { ...COLORS, ...msg.colors };
      updateLegendColors();
      needsUpdate = true;
    }
    if (needsUpdate && alpha <= MIN_ALPHA) {
      kickSim(0.05);
    }
    return;
  }

  if (msg.type === 'graphData') {
    if (msg.hideUI !== undefined) {
      document.body.classList.toggle('settings-hidden', msg.hideUI);
      document.body.classList.toggle('legend-hidden', msg.hideUI);
      syncPanelVisibility();
    }
    if (msg.colors) {
      COLORS = { ...COLORS, ...msg.colors };
      updateLegendColors();
    }
    if (msg.hiddenTypes) {
      hiddenTypes = new Set(msg.hiddenTypes);
    }
    loadGraph(msg.nodes, msg.edges);
    document.getElementById('loading').style.display = 'none';
  }
});

function updateLegendColors() {
  document.querySelectorAll('.leg').forEach(leg => {
    const type = leg.dataset.type;
    const dot = leg.querySelector('.dot');
    if (dot && COLORS[type]) dot.style.background = COLORS[type];
  });
  // Also refresh live node colours so a settings change is visible immediately
  nodes.forEach(function(nd) { if (COLORS[nd.type]) nd.col = COLORS[nd.type]; });
  updateLegendVisibility();
}

function updateLegendVisibility() {
  document.querySelectorAll('.leg').forEach(leg => {
    const type = leg.dataset.type;
    const eye = leg.querySelector('.eye-toggle');
    const isHidden = hiddenTypes.has(type);
    if (isHidden) {
      leg.classList.add('hidden');
      if (eye) {
        eye.textContent = '👁‍🗨';
        eye.classList.add('hidden');
      }
    } else {
      leg.classList.remove('hidden');
      if (eye) {
        eye.textContent = '👁';
        eye.classList.remove('hidden');
      }
    }
  });
}

// ── Dynamic legend + colour pickers ─────────────────────────────────────────
const _LEGEND_ORDER = ['ts','js','md','fn','url','db','py','rs','go','cpp','c','cs',
                       'java','rb','php','swift','kt','html','css','scss','json',
                       'yaml','sql','sh','ps1','toml'];

function buildLegend(presentTypes) {
  const legend = document.getElementById('legend');
  legend.innerHTML = '';
  const sorted = [...presentTypes].sort(function(a, b) {
    const ai = _LEGEND_ORDER.indexOf(a), bi = _LEGEND_ORDER.indexOf(b);
    if (ai >= 0 && bi >= 0) return ai - bi;
    if (ai >= 0) return -1;
    if (bi >= 0) return  1;
    return a.localeCompare(b);
  });
  for (const t of sorted) {
    // Use previously-saved colour override if present, otherwise palette default
    if (!COLORS[t]) COLORS[t] = TYPE_DEFAULTS[t] ? TYPE_DEFAULTS[t].color : typeColor(t);
    const lbl = TYPE_DEFAULTS[t] ? TYPE_DEFAULTS[t].label : t.toUpperCase();
    const isHidden = hiddenTypes.has(t);
    const div = document.createElement('div');
    div.className = 'leg' + (isHidden ? ' hidden' : '');
    div.dataset.type = t;
    div.innerHTML =
      '<div class="eye-toggle' + (isHidden ? ' hidden' : '') + '" data-type="' + t + '">' + (isHidden ? '👁‍🗨' : '👁') + '</div>' +
      '<div class="dot" style="background:' + COLORS[t] + '"></div>' +
      '<span>' + lbl + '</span>';
    legend.appendChild(div);
  }
  bindLegendInteractions();
  bindColorPickers();
}

function bindLegendInteractions() {
  // Bind eye toggle clicks
  document.querySelectorAll('.eye-toggle').forEach(function(toggle) {
    // Remove old listeners by cloning
    const clone = toggle.cloneNode(true);
    toggle.parentNode.replaceChild(clone, toggle);
  });

  document.querySelectorAll('.eye-toggle').forEach(function(toggle) {
    toggle.addEventListener('click', function(e) {
      e.stopPropagation();
      const type = toggle.dataset.type;
      const leg = toggle.closest('.leg');

      if (hiddenTypes.has(type)) {
        hiddenTypes.delete(type);
        toggle.textContent = '👁';
        toggle.classList.remove('hidden');
        leg.classList.remove('hidden');
      } else {
        hiddenTypes.add(type);
        toggle.textContent = '👁‍🗨';
        toggle.classList.add('hidden');
        leg.classList.add('hidden');
      }

      applyFilter();
      saveHiddenTypes();
    });
  });

  // Allow clicking on the legend item itself to toggle (but not on dot or eye)
  document.querySelectorAll('.leg').forEach(function(leg) {
    leg.addEventListener('click', function(e) {
      if (e.target.classList.contains('dot') || e.target.classList.contains('eye-toggle')) {
        return;
      }
      const type = leg.dataset.type;
      const toggle = leg.querySelector('.eye-toggle');
      if (hiddenTypes.has(type)) {
        hiddenTypes.delete(type);
        toggle.textContent = '👁';
        toggle.classList.remove('hidden');
        leg.classList.remove('hidden');
      } else {
        hiddenTypes.add(type);
        toggle.textContent = '👁‍🗨';
        toggle.classList.add('hidden');
        leg.classList.add('hidden');
      }
      applyFilter();
      saveHiddenTypes();
    });
  });
}

function saveHiddenTypes() {
  saveProjectState({ hiddenTypes: Array.from(hiddenTypes) });
}

function bindColorPickers() {
  // Clone dots to drop old listeners cleanly
  document.querySelectorAll('.leg .dot').forEach(function(dot) {
    const clone = dot.cloneNode(true);
    dot.parentNode.replaceChild(clone, dot);
  });
  document.querySelectorAll('.leg .dot').forEach(function(dot) {
    dot.style.cursor = 'pointer';
    dot.addEventListener('click', function(e) {
      e.stopPropagation();
      const leg = dot.closest('.leg');
      const type = leg.dataset.type;
      if (activeColorPicker) { activeColorPicker.destroy(); activeColorPicker = null; }
      activeColorPicker = createColorPicker(document.body, {
        value: COLORS[type] || typeColor(type),
        onChange: function(color) {
          COLORS[type] = color;
          dot.style.background = color;
          nodes.forEach(function(nd) { if (nd.type === type) nd.col = color; });
          render();
          const co = {};
          co[type] = color;
          vscode.postMessage({ type: 'saveColors', colors: co });
        }
      });
    });
  });
}

function loadGraph(rawNodes, rawEdges) {
  allNodes = rawNodes;
  allEdges = rawEdges;
  // Build legend dynamically from whatever types are actually in this project
  const presentTypes = new Set(rawNodes.map(function(n) { return n.type; }));
  buildLegend(presentTypes);
  // Use faster alpha decay for very large graphs
  ALPHA_DECAY = rawNodes.length > 500 ? 0.985 : 0.994;
  applyFilter();
  // Auto-fit once the simulation has had a moment to settle
  setTimeout(fitView, rawNodes.length > 500 ? 3000 : 1600);
}

function applyFilter() {
  const q = filterText.toLowerCase();

  let visNodes = allNodes.filter(n => {
    if (!showFns && n.type === 'fn') return false;
    if (hiddenTypes.has(n.type)) return false;
    if (q && !n.label.toLowerCase().includes(q) && !n.filePath.toLowerCase().includes(q)) return false;
    return true;
  });

  const visIds = new Set(visNodes.map(n => n.id));
  let visEdges = allEdges.filter(e => visIds.has(e.source) && visIds.has(e.target));

  // Build index
  const idxMap = new Map();
  visNodes.forEach((n, i) => idxMap.set(n.id, i));

  // Position: keep old positions if node existed
  const oldById = new Map(nodes.map(n => [n.id, n]));

  nodes = visNodes.map((n, i) => {
    const old = oldById.get(n.id);
    const angle = (i / visNodes.length) * Math.PI * 2;
    const spread = Math.sqrt(visNodes.length) * 60;
    return {
      id: n.id,
      label: n.label,
      type: n.type,
      filePath: n.filePath,
      parentId: n.parentId,
      x: old ? old.x : Math.cos(angle) * spread * (0.5 + Math.random() * 0.5),
      y: old ? old.y : Math.sin(angle) * spread * (0.5 + Math.random() * 0.5),
      vx: 0, vy: 0,
      r: getTypeRadius(n.type),
      col: getTypeColor(n.type),
      pinned: false,
    };
  });

  edges = visEdges
    .map(e => ({ si: idxMap.get(e.source), ti: idxMap.get(e.target), kind: e.kind }))
    .filter(e => e.si !== undefined && e.ti !== undefined);

  hovered = -1;
  selected = -1;
  alpha = 1.0;
  updateStatus();

  if (!simRunning) {
    simRunning = true;
    rafId = requestAnimationFrame(tick);
  }
}

// ── Simulation ───────────────────────────────────────────────────────────────
function tick() {
  if (alpha > MIN_ALPHA) {
    simulate();
    alpha *= ALPHA_DECAY;
  }
  render();
  rafId = requestAnimationFrame(tick);
}

function simulate() {
  const n = nodes.length;
  const a = alpha;

  // Repulsion (O(n²) with cutoff — fast for <2000 nodes)
  for (let i = 0; i < n; i++) {
    const ni = nodes[i];
    for (let j = i + 1; j < n; j++) {
      const nj = nodes[j];
      const dx = nj.x - ni.x;
      const dy = nj.y - ni.y;
      const d2 = dx * dx + dy * dy || 0.01;
      const d  = Math.sqrt(d2);
      if (d > REPEL_CUTOFF) continue;
      const f = (REPULSION / d2) * a;
      const fx = (dx / d) * f, fy = (dy / d) * f;
      ni.vx -= fx; ni.vy -= fy;
      nj.vx += fx; nj.vy += fy;
    }
  }

  // Spring forces
  for (const e of edges) {
    const A = nodes[e.si];
    const B = nodes[e.ti];
    const dx = B.x - A.x;
    const dy = B.y - A.y;
    const d  = Math.sqrt(dx * dx + dy * dy) || 0.01;
    const nat = SPRING_LEN[e.kind] ?? 130;
    const f = (d - nat) * SPRING_K * a;
    const fx = (dx / d) * f, fy = (dy / d) * f;
    A.vx += fx; A.vy += fy;
    B.vx -= fx; B.vy -= fy;
  }

  // Centering + integrate
  for (const nd of nodes) {
    if (nd.pinned) continue;
    nd.vx = (nd.vx - nd.x * CENTER_K * a) * DAMPING;
    nd.vy = (nd.vy - nd.y * CENTER_K * a) * DAMPING;
    nd.x += nd.vx;
    nd.y += nd.vy;
  }
}

// ── Render ───────────────────────────────────────────────────────────────────
function worldToScreen(wx, wy) {
  const cx = canvas.width  / 2 + camera.x * devicePixelRatio;
  const cy = canvas.height / 2 + camera.y * devicePixelRatio;
  return [cx + wx * camera.zoom * devicePixelRatio,
          cy + wy * camera.zoom * devicePixelRatio];
}

function render() {
  const dpr = devicePixelRatio;
  const W = canvas.width, H = canvas.height;
  ctx.clearRect(0, 0, W, H);

  ctx.save();
  ctx.translate(W / 2 + camera.x * dpr, H / 2 + camera.y * dpr);
  const z = camera.zoom * dpr;
  ctx.scale(z, z);

  // Edges
  for (const e of edges) {
    const A = nodes[e.si], B = nodes[e.ti];
    const isSel = (e.si === selected || e.ti === selected);
    ctx.beginPath();
    
    if (EDGE_DIRECTION === 'curved' || EDGE_DIRECTION === 'curved-arrow') {
      const mx = (A.x + B.x) / 2;
      const my = (A.y + B.y) / 2 - 30;
      ctx.moveTo(A.x, A.y);
      ctx.quadraticCurveTo(mx, my, B.x, B.y);
    } else {
      ctx.moveTo(A.x, A.y);
      ctx.lineTo(B.x, B.y);
    }
    
    ctx.strokeStyle = isSel
      ? (e.kind === 'import' ? 'rgba(78,201,176,0.75)' : e.kind === 'call' ? 'rgba(220,180,120,0.80)' : 'rgba(197,134,192,0.75)')
      : (COLORS['edge_' + e.kind] || 'rgba(150,150,150,0.18)');
    ctx.lineWidth = isSel ? 1.5 / z : 0.8 / z;
    ctx.stroke();

    if (EDGE_DIRECTION === 'arrow' || EDGE_DIRECTION === 'curved-arrow') {
      const dx = B.x - A.x, dy = B.y - A.y;
      const len = Math.sqrt(dx * dx + dy * dy) || 1;
      const nx = dx / len, ny = dy / len;
      const arrowX = B.x - nx * (B.r + 4);
      const arrowY = B.y - ny * (B.r + 4);
      const arrowSize = 8 / z;
      const angle = Math.atan2(ny, nx);
      ctx.beginPath();
      ctx.moveTo(arrowX, arrowY);
      ctx.lineTo(arrowX - arrowSize * Math.cos(angle - Math.PI / 6), arrowY - arrowSize * Math.sin(angle - Math.PI / 6));
      ctx.lineTo(arrowX - arrowSize * Math.cos(angle + Math.PI / 6), arrowY - arrowSize * Math.sin(angle + Math.PI / 6));
      ctx.closePath();
      ctx.fillStyle = isSel
        ? (e.kind === 'import' ? 'rgba(78,201,176,0.75)' : e.kind === 'call' ? 'rgba(220,180,120,0.80)' : 'rgba(197,134,192,0.75)')
        : (COLORS['edge_' + e.kind] || 'rgba(150,150,150,0.18)');
      ctx.fill();
    }
  }

  // Nodes
  const labelScale = Math.max(0.6, Math.min(1.2, 1 / camera.zoom));
  const showLabel = camera.zoom > 0.25;

  for (let i = 0; i < nodes.length; i++) {
    const nd = nodes[i];
    const isSel = selectedNodes.has(i) || i === selected;
    const isHov = i === hovered;

    // Glow for selected
    if (isSel) {
      ctx.beginPath();
      ctx.arc(nd.x, nd.y, nd.r + 5 / z, 0, Math.PI * 2);
      ctx.fillStyle = nd.col + '33';
      ctx.fill();
    }

    // Node circle
    ctx.beginPath();
    ctx.arc(nd.x, nd.y, nd.r, 0, Math.PI * 2);
    ctx.fillStyle = nd.col;
    ctx.globalAlpha = (filterText && !nd.label.toLowerCase().includes(filterText.toLowerCase())) ? 0.25 : 1;
    ctx.fill();
    ctx.globalAlpha = 1;

    if (isSel || isHov) {
      ctx.strokeStyle = '#fff';
      ctx.lineWidth = 1.5 / z;
      ctx.stroke();
    }

    // Label
    if (showLabel) {
      ctx.save();
      ctx.scale(labelScale, labelScale);
      const sx = nd.x / labelScale;
      const sy = nd.y / labelScale;
      ctx.font = (nd.type === 'fn' ? 9 : 10) + 'px -apple-system,sans-serif';
      ctx.textAlign = 'center';
      ctx.fillStyle = 'rgba(220,220,220,0.85)';
      ctx.fillText(nd.label, sx, sy + (nd.r + 11) / labelScale);
      ctx.restore();
    }
  }

  // Draw box selection rectangle
  if (boxSelect) {
    const dpr = devicePixelRatio;
    const cx  = canvas.width  / 2 / dpr + camera.x;
    const cy  = canvas.height / 2 / dpr + camera.y;

    const startX = (boxSelect.startX - cx) / camera.zoom;
    const startY = (boxSelect.startY - cy) / camera.zoom;
    const currentX = (boxSelect.currentX - cx) / camera.zoom;
    const currentY = (boxSelect.currentY - cy) / camera.zoom;

    const minX = Math.min(startX, currentX);
    const maxX = Math.max(startX, currentX);
    const minY = Math.min(startY, currentY);
    const maxY = Math.max(startY, currentY);

    ctx.strokeStyle = 'rgba(255, 255, 255, 0.5)';
    ctx.lineWidth = 1 / z;
    ctx.fillStyle = 'rgba(255, 255, 255, 0.1)';
    ctx.fillRect(minX, minY, maxX - minX, maxY - minY);
    ctx.strokeRect(minX, minY, maxX - minX, maxY - minY);
  }

  ctx.restore();
}

// ── Status ───────────────────────────────────────────────────────────────────
function updateStatus() {
  document.getElementById('st-nodes').textContent = nodes.length + ' nodes';
  document.getElementById('st-edges').textContent = edges.length + ' edges';
}

function updateSelectedStatus() {
  const st = document.getElementById('st-selected');
  if (selectedNodes.size === 0) {
    st.textContent = '';
  } else if (selectedNodes.size === 1) {
    const idx = Array.from(selectedNodes)[0];
    const nd = nodes[idx];
    st.textContent = '● ' + nd.label;
  } else {
    st.textContent = '● ' + selectedNodes.size + ' nodes selected';
  }
}

// ── Hit test ─────────────────────────────────────────────────────────────────
function hitNode(mx, my) {
  // mx, my in CSS pixels (from mouse event)
  const dpr = devicePixelRatio;
  const cx  = canvas.width  / 2 / dpr + camera.x;
  const cy  = canvas.height / 2 / dpr + camera.y;
  for (let i = nodes.length - 1; i >= 0; i--) {
    const nd = nodes[i];
    const sx = cx + nd.x * camera.zoom;
    const sy = cy + nd.y * camera.zoom;
    const r  = nd.r * camera.zoom + 4;
    const dx = mx - sx, dy = my - sy;
    if (dx * dx + dy * dy <= r * r) return i;
  }
  return -1;
}

// ── Mouse events ─────────────────────────────────────────────────────────────
canvas.addEventListener('mousemove', e => {
  const rect = canvas.getBoundingClientRect();
  const mx = e.clientX - rect.left;
  const my = e.clientY - rect.top;
  lastMouse = { x: mx, y: my };

  // Handle box selection (right click drag)
  if (boxSelect) {
    boxSelect.currentX = mx;
    boxSelect.currentY = my;
    return;
  }

  // Handle node dragging (left click on selected nodes)
  if (dragNode >= 0) {
    const dpr = devicePixelRatio;
    const cx  = canvas.width  / 2 / dpr + camera.x;
    const cy  = canvas.height / 2 / dpr + camera.y;

    // If dragging a selected node, move all selected nodes together
    if (selectedNodes.has(dragNode)) {
      const dx = ((mx - cx) / camera.zoom) - nodes[dragNode].x;
      const dy = ((my - cy) / camera.zoom) - nodes[dragNode].y;

      for (const idx of selectedNodes) {
        nodes[idx].x += dx;
        nodes[idx].y += dy;
        nodes[idx].vx = 0;
        nodes[idx].vy = 0;
      }
    } else {
      // Drag single node
      nodes[dragNode].x = (mx - cx) / camera.zoom;
      nodes[dragNode].y = (my - cy) / camera.zoom;
      nodes[dragNode].vx = 0;
      nodes[dragNode].vy = 0;
    }
    kickSim(0.3);
    return;
  }

  // Handle panning
  if (panStart) {
    camera.x = panStart.cx + (mx - panStart.sx);
    camera.y = panStart.cy + (my - panStart.sy);
    return;
  }

  // Only update hover if not pressing (not dragging)
  if (!pressing) {
    const hit = hitNode(mx, my);
    if (hit !== hovered) {
      hovered = hit;
      canvas.style.cursor = hit >= 0 ? 'pointer' : 'grab';
    }

    if (hit >= 0) {
      const nd = nodes[hit];
      const rel = nd.filePath.replace(${JSON.stringify(wsPath)}.replace(/\\\\/g,'/') + '/', '').replace(/\\\\/g,'/');
      tooltip.innerHTML = '<b>' + nd.label + '</b><br/>'
        + '<span style="opacity:.65;font-size:10px">' + rel + '</span>';
      tooltip.style.display = 'block';
      tooltip.style.left = (e.clientX + 14) + 'px';
      tooltip.style.top  = (e.clientY - 6)  + 'px';
    } else {
      tooltip.style.display = 'none';
    }
  }
});

canvas.addEventListener('mousedown', e => {
  const rect = canvas.getBoundingClientRect();
  const mx = e.clientX - rect.left;
  const my = e.clientY - rect.top;
  const hit = hitNode(mx, my);
  pressing = true;
  canvas._dragStart = { x: mx, y: my };

  // Middle mouse button (button 1) - always pan
  if (e.button === 1) {
    panStart = { sx: mx, sy: my, cx: camera.x, cy: camera.y };
    canvas.style.cursor = 'grabbing';
    return;
  }

  // Right mouse button (button 2) - box selection
  if (e.button === 2) {
    e.preventDefault();
    boxSelect = { startX: mx, startY: my, currentX: mx, currentY: my };
    canvas.style.cursor = 'crosshair';
    return;
  }

  // Left mouse button (button 0) - normal interaction
  if (e.button === 0) {
    if (hit >= 0) {
      // If clicking on an already selected node, prepare to drag all selected nodes
      if (selectedNodes.has(hit)) {
        dragNode = hit;
        for (const idx of selectedNodes) {
          nodes[idx].pinned = true;
        }
        kickSim(0.5);
      } else {
        // If clicking on a new node, clear selection and select just this node
        selectedNodes.clear();
        selectedNodes.add(hit);
        dragNode = hit;
        nodes[hit].pinned = true;
        kickSim(0.5);
      }
    } else {
      // Clicked on empty space - clear selection and start pan
      selectedNodes.clear();
      panStart = { sx: mx, sy: my, cx: camera.x, cy: camera.y };
      canvas.style.cursor = 'grabbing';
    }
  }
});

// Prevent context menu on right click (for box selection)
canvas.addEventListener('contextmenu', e => e.preventDefault());

window.addEventListener('mouseup', e => {
  const rect = canvas.getBoundingClientRect();
  const mx = e.clientX - rect.left;
  const my = e.clientY - rect.top;
  const moved = canvas._dragStart && Math.hypot(mx - canvas._dragStart.x, my - canvas._dragStart.y) > 5;
  canvas._dragStart = undefined;

  // Handle box selection completion
  if (boxSelect) {
    const dpr = devicePixelRatio;
    const cx  = canvas.width  / 2 / dpr + camera.x;
    const cy  = canvas.height / 2 / dpr + camera.y;

    // Convert screen coordinates to world coordinates
    const startX = (boxSelect.startX - cx) / camera.zoom;
    const startY = (boxSelect.startY - cy) / camera.zoom;
    const endX = (boxSelect.currentX - cx) / camera.zoom;
    const endY = (boxSelect.currentY - cy) / camera.zoom;

    // Calculate bounding box
    const minX = Math.min(startX, endX);
    const maxX = Math.max(startX, endX);
    const minY = Math.min(startY, endY);
    const maxY = Math.max(startY, endY);

    // If box was actually drawn (not just a click), select nodes inside
    if (moved) {
      selectedNodes.clear();
      for (let i = 0; i < nodes.length; i++) {
        const nd = nodes[i];
        if (nd.x >= minX && nd.x <= maxX && nd.y >= minY && nd.y <= maxY) {
          selectedNodes.add(i);
        }
      }
      selected = selectedNodes.size > 0 ? Array.from(selectedNodes)[0] : -1;
      updateSelectedStatus();
    }

    boxSelect = null;
    canvas.style.cursor = hovered >= 0 ? 'pointer' : 'grab';
    pressing = false;
    canvas._didDrag = moved;
    return;
  }

  if (dragNode >= 0) {
    // Unpin all dragged nodes
    for (const idx of selectedNodes) {
      nodes[idx].pinned = false;
    }
    dragNode = -1;
  }
  if (panStart) {
    panStart = null;
    canvas.style.cursor = hovered >= 0 ? 'pointer' : 'grab';
  }
  pressing = false;
  canvas._didDrag = moved;
});

canvas.addEventListener('click', e => {
  const rect = canvas.getBoundingClientRect();
  const mx = e.clientX - rect.left;
  const my = e.clientY - rect.top;
  const hit = hitNode(mx, my);

  // Only open file if it's a single node click (not box selection) and not dragged
  if (selectedNodes.size === 1 && hit >= 0 && !canvas._didDrag) {
    const idx = Array.from(selectedNodes)[0];
    const nd = nodes[idx];
    if (nd.type === 'url') {
      vscode.postMessage({ type: 'openUrl', url: nd.filePath });
    } else {
      vscode.postMessage({ type: 'openFile', path: nd.filePath });
    }
  }
  canvas._didDrag = false;
});

canvas.addEventListener('wheel', e => {
  e.preventDefault();
  const factor = e.deltaY < 0 ? 1.12 : 0.89;
  const rect = canvas.getBoundingClientRect();
  const mx = e.clientX - rect.left;
  const my = e.clientY - rect.top;
  const dpr = devicePixelRatio;
  const cx  = canvas.width  / 2 / dpr + camera.x;
  const cy  = canvas.height / 2 / dpr + camera.y;
  // Zoom toward cursor
  const wx = (mx - cx) / camera.zoom;
  const wy = (my - cy) / camera.zoom;
  camera.zoom = Math.max(0.05, Math.min(8, camera.zoom * factor));
  camera.x = mx - wx * camera.zoom - canvas.width / 2 / dpr;
  camera.y = my - wy * camera.zoom - canvas.height / 2 / dpr;
}, { passive: false });

// Pinch-zoom (trackpad)
canvas.addEventListener('gesturechange', e => {
  e.preventDefault();
  camera.zoom = Math.max(0.05, Math.min(8, camera.zoom * e.scale));
}, { passive: false });

// ── Toolbar ──────────────────────────────────────────────────────────────────
if (btnToggleSettings) {
  btnToggleSettings.addEventListener('click', function() {
    const isHidden = document.body.classList.toggle('settings-hidden');
    syncPanelVisibility();
    saveProjectState({ hideGraphSettings: isHidden, hideUI: isHidden && document.body.classList.contains('legend-hidden') });
  });
}

if (btnToggleLegend) {
  btnToggleLegend.addEventListener('click', function() {
    const isHidden = document.body.classList.toggle('legend-hidden');
    syncPanelVisibility();
    saveProjectState({ hideLegend: isHidden, hideUI: isHidden && document.body.classList.contains('settings-hidden') });
  });
}

const edgeDirectionControl = document.getElementById('edge-direction');
if (edgeDirectionControl) {
  edgeDirectionControl.addEventListener('change', function() {
    EDGE_DIRECTION = this.value;
    render();
    saveProjectState({ edgeDirection: EDGE_DIRECTION });
  });
}

document.getElementById('btn-refresh').addEventListener('click', () => {
  document.getElementById('loading').style.display = 'flex';
  vscode.postMessage({ type: 'refresh', showFns });
});

document.getElementById('btn-fit').addEventListener('click', fitView);

document.getElementById('btn-fns').addEventListener('click', function() {
  showFns = !showFns;
  this.classList.toggle('active', showFns);
  saveProjectState({ showFns: showFns });
  applyFilter();
});

document.getElementById('btn-panel').addEventListener('click', () => {
  vscode.postMessage({ type: 'openPanel' });
});

document.getElementById('btn-codeflow').addEventListener('click', function() {
  this.classList.toggle('active');
  saveProjectState({ graphMode: this.classList.contains('active') ? 'codeflow' : 'normal' });
  vscode.postMessage({ type: 'switchToCodeFlow', active: this.classList.contains('active') });
});

document.getElementById('search').addEventListener('input', function() {
  filterText = this.value;
  saveProjectState({ filterText: filterText });
  applyFilter();
});

// Color picker – activeColorPicker declared here; pickers are wired by bindColorPickers()
var activeColorPicker = null;

document.addEventListener('click', function(e) {
  if (activeColorPicker && !e.target.closest('.leg') && !e.target.closest('.color-picker-popup')) {
    activeColorPicker.destroy();
    activeColorPicker = null;
  }
});

// Settings button
document.getElementById('btn-settings').addEventListener('click', () => {
  vscode.postMessage({ type: 'openSettings' });
});

function fitView() {
  if (nodes.length === 0) return;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const nd of nodes) {
    minX = Math.min(minX, nd.x); minY = Math.min(minY, nd.y);
    maxX = Math.max(maxX, nd.x); maxY = Math.max(maxY, nd.y);
  }
  const dpr = devicePixelRatio;
  const W = canvas.width / dpr, H = canvas.height / dpr;
  const pad = 60;
  const rangeX = maxX - minX || 1, rangeY = maxY - minY || 1;
  const zoom = Math.min((W - pad * 2) / rangeX, (H - pad * 2) / rangeY, 4);
  camera.zoom = zoom;
  camera.x = -(minX + rangeX / 2) * zoom;
  camera.y = -(minY + rangeY / 2) * zoom;
}

// ── Boot ─────────────────────────────────────────────────────────────────────
resize();
vscode.postMessage({ type: 'ready', showFns: showFns });

})();
</script>
</body>
</html>`;
}

// ─── CodeFlow HTML (React Flow) ──────────────────────────────────────────────

function buildCodeFlowHtml(
  extensionPath: string,
  _webview: vscode.Webview,
  initialState: ProjectCodeGraphState
): string {
  const scriptUri = _webview.asWebviewUri(vscode.Uri.file(path.join(extensionPath, 'dist', 'codeFlow.next.js')));
  
  return /* html */`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>CodeFlow</title>
<style>
  *{box-sizing:border-box;margin:0;padding:0}
  html,body{width:100%;height:100%;overflow:hidden;
    background:var(--vscode-sideBar-background,var(--vscode-editor-background));
    color:var(--vscode-editor-foreground);
    font:12px/1.4 -apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif}
  #toolbar{
    position:fixed;top:0;left:0;right:0;height:36px;
    display:flex;align-items:center;gap:6px;padding:0 8px;
    background:var(--vscode-sideBar-background,var(--vscode-editor-background));
    border-bottom:1px solid var(--vscode-panel-border,rgba(128,128,128,.3));
    z-index:10;flex-shrink:0}
  .tbtn{
    padding:3px 8px;border-radius:4px;cursor:pointer;font-size:11px;
    background:var(--vscode-button-secondaryBackground,rgba(128,128,128,.15));
    border:1px solid var(--vscode-panel-border,rgba(128,128,128,.3));
    color:var(--vscode-editor-foreground);white-space:nowrap}
  .tbtn:hover{background:var(--vscode-list-hoverBackground)}
  .tbtn.active{
    background:var(--vscode-button-background,rgba(0,120,212,.9));
    color:var(--vscode-button-foreground,#fff);
    border-color:transparent}
  #app-wrap{position:fixed;top:36px;left:0;right:0;bottom:0}
  #loading{
    position:absolute;inset:0;display:flex;flex-direction:column;
    align-items:center;justify-content:center;gap:12px;
    background:var(--vscode-sideBar-background,var(--vscode-editor-background));z-index:20}
  .spinner{
    width:28px;height:28px;border-radius:50%;
    border:3px solid var(--vscode-panel-border,rgba(128,128,128,.3));
    border-top-color:var(--vscode-textLink-foreground,#4ec9b0);
    animation:spin .7s linear infinite}
  @keyframes spin{to{transform:rotate(360deg)}}
</style>
</head>
<body>
<div id="toolbar">
  <button class="tbtn active" id="btn-normal" title="Switch to Normal Graph">Normal</button>
  <input id="search" placeholder="Search functions…" style="flex:1;min-width:0;padding:3px 7px;background:var(--vscode-input-background);color:var(--vscode-input-foreground);border:1px solid var(--vscode-input-border,rgba(128,128,128,.4));border-radius:4px;font-size:11px"/>
  <button class="tbtn" id="btn-refresh" title="Refresh">↻</button>
</div>
<div id="app-wrap">
  <div id="loading"><div class="spinner"></div><span>Loading CodeFlow…</span></div>
  <div id="app"></div>
</div>
<script>
  // Acquire vscode API BEFORE the React bundle loads (can only be called once)
  window.__vscodeApi = acquireVsCodeApi();
  window.__ultraviewCodeGraphState = ${JSON.stringify(initialState)};
</script>
<script src="${scriptUri}"></script>
<script>
  (function() {
    var vscode = window.__vscodeApi;
    document.getElementById('btn-normal').addEventListener('click', function() {
      vscode.postMessage({ type: 'saveProjectState', state: { graphMode: 'normal' } });
      vscode.postMessage({ type: 'switchToCodeFlow', active: false });
    });
    document.getElementById('btn-refresh').addEventListener('click', function() {
      vscode.postMessage({ type: 'requestGraph' });
    });
  })();
</script>
</body>
</html>`;
}

// ─── WebviewViewProvider (Sidebar) ───────────────────────────────────────────

export class CodeGraphProvider implements vscode.WebviewViewProvider {
  public static readonly viewId = 'ultraview.codeGraph';
  private _view?: vscode.WebviewView;

  // Static list of all active webviews to broadcast settings changes
  private static readonly activeWebviews = new Set<vscode.Webview>();
  private static configListener?: vscode.Disposable;

  constructor(private readonly ctx: vscode.ExtensionContext) {
    if (!CodeGraphProvider.configListener) {
      CodeGraphProvider.configListener = vscode.workspace.onDidChangeConfiguration(e => {
        if (e.affectsConfiguration('ultraview.codeGraph.nodeColors')) {
          CodeGraphProvider.broadcastSettings();
        }
      });
      ctx.subscriptions.push(CodeGraphProvider.configListener);
    }
  }

  resolveWebviewView(
    webviewView: vscode.WebviewView,
    _context: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken
  ): void {
    this._view = webviewView;
    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.file(path.join(this.ctx.extensionPath, 'dist'))]
    };

    const wsRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? '';
    const state = getProjectGraphState(this.ctx);
    webviewView.webview.html = state.graphMode === 'codeflow'
      ? buildCodeFlowHtml(this.ctx.extensionPath, webviewView.webview, state)
      : buildHtml(wsRoot, state);

    CodeGraphProvider.activeWebviews.add(webviewView.webview);
    webviewView.onDidDispose(() => {
      CodeGraphProvider.activeWebviews.delete(webviewView.webview);
    });

    webviewView.webview.onDidReceiveMessage(msg => this._handleMessage(msg, webviewView.webview));
  }

  // Called by command to open as full editor panel
  static openAsPanel(ctx: vscode.ExtensionContext): void {
    const panel = vscode.window.createWebviewPanel(
      'ultraview.codeGraphPanel',
      'Code Graph',
      vscode.ViewColumn.One,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [vscode.Uri.file(path.join(ctx.extensionPath, 'dist'))]
      }
    );
    const wsRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? '';
    const state = getProjectGraphState(ctx);
    panel.webview.html = state.graphMode === 'codeflow'
      ? buildCodeFlowHtml(ctx.extensionPath, panel.webview, state)
      : buildHtml(wsRoot, state);

    CodeGraphProvider.activeWebviews.add(panel.webview);
    panel.onDidDispose(() => {
      CodeGraphProvider.activeWebviews.delete(panel.webview);
    });
    panel.webview.onDidReceiveMessage(msg => {
      if (msg.type === 'ready' || msg.type === 'refresh') {
        if (msg.streaming) {
          sendGraphStreaming(panel.webview);
        } else {
          sendGraph(panel.webview, msg.showFns ?? false, ctx);
        }
      } else if (msg.type === 'requestGraph') {
        const nextState = getProjectGraphState(ctx);
        sendGraph(panel.webview, nextState.showFns, ctx);
      } else if (msg.type === 'openFile') {
        openFile(String(msg.path), typeof msg.line === 'number' ? msg.line : undefined);
      } else if (msg.type === 'openUrl') {
        try { vscode.commands.executeCommand('ultraview.openUrl', String(msg.url)); } catch (e) { /* ignore */ }
      } else if (msg.type === 'switchToCodeFlow') {
        if (msg.active) {
          panel.webview.html = buildCodeFlowHtml(ctx.extensionPath, panel.webview, getProjectGraphState(ctx));
        } else {
          const nextState = getProjectGraphState(ctx);
          panel.webview.html = buildHtml(wsRoot, nextState);
          sendGraph(panel.webview, nextState.showFns, ctx);
        }
      } else if (msg.type === 'saveProjectState') {
        void saveProjectGraphState(ctx, (msg.state as Partial<ProjectCodeGraphState>) ?? {});
      }
    });
  }

  private _handleMessage(msg: Record<string, unknown>, webview: vscode.Webview): void {
    switch (msg.type) {
      case 'ready':
      case 'refresh':
        if (msg.streaming) {
          sendGraphStreaming(webview);
        } else {
          sendGraph(webview, (msg.showFns as boolean) ?? false, this.ctx);
        }
        break;
      case 'openFile':
        openFile(String(msg.path), typeof msg.line === 'number' ? msg.line : undefined);
        break;
      case 'openUrl':
        try { vscode.commands.executeCommand('ultraview.openUrl', String(msg.url)); } catch (e) { /* ignore */ }
        break;
      case 'openPanel':
        vscode.commands.executeCommand('ultraview.openCodeGraph');
        break;
      case 'saveColors':
        this._saveColors(msg.colors as Record<string, string>);
        break;
      case 'openSettings':
        vscode.commands.executeCommand('ultraview.settings.focus');
        break;
      case 'saveProjectState':
        void saveProjectGraphState(this.ctx, (msg.state as Partial<ProjectCodeGraphState>) ?? {});
        break;
      case 'switchToCodeFlow':
        this._switchToCodeFlow(webview, msg.active as boolean);
        break;
      case 'requestGraph':
        {
          const state = getProjectGraphState(this.ctx);
          sendGraph(webview, state.showFns, this.ctx);
        }
        break;
    }
  }

  private _switchToCodeFlow(webview: vscode.Webview, active: boolean): void {
    if (active) {
      webview.html = buildCodeFlowHtml(this.ctx.extensionPath, webview, getProjectGraphState(this.ctx));
    } else {
      const wsRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? '';
      const state = getProjectGraphState(this.ctx);
      webview.html = buildHtml(wsRoot, state);
      sendGraph(webview, state.showFns, this.ctx);
    }
  }

  private async _saveColors(colors: Record<string, string>): Promise<void> {
    const config = vscode.workspace.getConfiguration('ultraview');
    const currentColors = config.get<Record<string, string>>('codeGraph.nodeColors')
      || { ...defaultCodeGraphSettings.nodeColors };
    const mergedColors = { ...currentColors, ...colors };
    await config.update('codeGraph.nodeColors', mergedColors, vscode.ConfigurationTarget.Global);
  }

  private static broadcastSettings() {
    const colors = getColors();
    for (const webview of CodeGraphProvider.activeWebviews) {
      webview.postMessage({ type: 'configUpdate', colors });
    }
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function getColors(): Record<string, string> {
  const config = vscode.workspace.getConfiguration('ultraview');
  return config.get<Record<string, string>>('codeGraph.nodeColors')
    || { ...defaultCodeGraphSettings.nodeColors };
}

async function sendGraph(
  webview: vscode.Webview,
  showFns: boolean,
  ctx: vscode.ExtensionContext
): Promise<void> {
  try {
    const data = await buildGraph(showFns);
    const colors = getColors();
    const state = getProjectGraphState(ctx);
    webview.postMessage({
      type: 'graphData',
      ...data,
      colors,
      hideUI: state.hideUI,
      hiddenTypes: state.hiddenTypes
    });
  } catch (err) {
    vscode.window.showErrorMessage('Code Graph error: ' + String(err));
  }
}

function mapNode(n: { id: string; label: string; type: string; filePath?: string; meta?: Record<string, unknown> }): GNode {
  if (n.type === 'url') {
    const url = (n.meta && typeof n.meta.url === 'string') ? n.meta.url : (typeof n.id === 'string' && n.id.startsWith('url:') ? n.id.slice(4) : (n.filePath ?? ''));
    return { id: n.id, label: n.label, type: 'url', filePath: url, parentId: (n.meta && typeof n.meta.parent === 'string') ? n.meta.parent : undefined, meta: n.meta };
  }
  let t = n.type;
  if (t === 'tsx') t = 'ts';
  else if (['jsx', 'mjs', 'cjs'].includes(t)) t = 'js';
  else if (['mdx', 'markdown'].includes(t)) t = 'md';
  else if (['sqlite3', 'db3', 'ddb', 'mdb', 'accdb'].includes(t)) t = 'db';
  else if (['cc', 'cxx', 'cpp', 'hh', 'hpp'].includes(t)) t = 'cpp';
  else if (t === 'h') t = 'c';
  else if (t === 'yml') t = 'yaml';
  else if (['bash', 'zsh'].includes(t)) t = 'sh';
  return {
    id: n.id, label: n.label, type: t, filePath: n.filePath ?? '',
    parentId: (n.meta && typeof n.meta.parent === 'string') ? n.meta.parent : undefined,
    meta: n.meta
  };
}

function mapEdge(e: { source: string; target: string; kind: string }): GEdge {
  return {
    source: e.source, target: e.target,
    kind: ['import', 'declares'].includes(e.kind) ? 'import' : e.kind === 'call' ? 'call' : 'link'
  };
}

async function sendGraphStreaming(webview: vscode.Webview): Promise<void> {
  const wsRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? '';
  try {
    await buildCodeGraphStreaming((progress) => {
      const mappedNodes = progress.nodes.map(mapNode);
      const mappedEdges = progress.edges.map(mapEdge);
      webview.postMessage({
        type: 'graphBatch',
        phase: progress.phase,
        file: progress.file ? progress.file.replace(wsRoot.replace(/\\/g, '/') + '/', '').replace(/\\/g, '/') : undefined,
        nodes: mappedNodes,
        edges: mappedEdges,
        totalFiles: progress.totalFiles,
        scannedFiles: progress.scannedFiles
      });
    });
  } catch (err) {
    vscode.window.showErrorMessage('Code Graph streaming error: ' + String(err));
  }
}

async function openFile(filePath: string, line?: number): Promise<void> {
  const uri = vscode.Uri.file(filePath);
  const hasTargetLine = typeof line === 'number' && Number.isFinite(line) && line > 0;

  if (/\.(md|mdx|markdown)$/i.test(filePath) && !hasTargetLine) {
    void vscode.commands.executeCommand('vscode.openWith', uri, 'ultraview.markdown');
    return;
  }

  const doc = vscode.workspace.textDocuments.find(d => d.uri.fsPath === uri.fsPath)
    ?? await vscode.workspace.openTextDocument(uri);
  const editor = await vscode.window.showTextDocument(doc, { preview: false, preserveFocus: false });

  if (hasTargetLine) {
    const lineIndex = Math.min(Math.max(Math.floor(line) - 1, 0), Math.max(doc.lineCount - 1, 0));
    const position = new vscode.Position(lineIndex, 0);
    const selection = new vscode.Selection(position, position);
    editor.selection = selection;
    editor.revealRange(new vscode.Range(position, position), vscode.TextEditorRevealType.InCenter);
  }
}
