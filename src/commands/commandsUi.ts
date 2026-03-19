export function buildCommandsHtml(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>Commands</title>
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
  #search{
    flex:1;min-width:0;padding:3px 7px;
    background:var(--vscode-input-background);
    color:var(--vscode-input-foreground);
    border:1px solid var(--vscode-input-border,rgba(128,128,128,.4));
    border-radius:4px;font-size:11px}
  #search:focus{outline:1px solid var(--vscode-focusBorder)}
  #type-filter{
    padding:3px 6px;
    background:var(--vscode-dropdown-background,var(--vscode-input-background));
    color:var(--vscode-dropdown-foreground,var(--vscode-input-foreground));
    border:1px solid var(--vscode-dropdown-border,var(--vscode-input-border,rgba(128,128,128,.4)));
    border-radius:4px;font-size:11px;cursor:pointer;flex-shrink:0}
  #type-filter:focus{outline:1px solid var(--vscode-focusBorder)}
  #content{position:fixed;top:36px;left:0;right:0;bottom:24px;overflow-y:auto;padding:8px}
  #status{
    position:fixed;bottom:0;left:0;right:0;height:24px;
    display:flex;align-items:center;padding:0 10px;
    font-size:10px;color:var(--vscode-descriptionForeground);
    background:var(--vscode-statusBar-background,var(--vscode-sideBar-background));
    border-top:1px solid var(--vscode-panel-border,rgba(128,128,128,.2))}
  .cmd-item{
    display:flex;align-items:flex-start;
    padding:10px 12px;margin-bottom:8px;
    background:var(--vscode-editor-background,rgba(30,30,30,.5));
    border:1px solid var(--vscode-panel-border,rgba(128,128,128,.2));
    border-radius:6px;transition:background .15s;
    cursor:pointer;gap:10px}
  .cmd-item:hover{
    background:var(--vscode-list-hoverBackground,rgba(255,255,255,.05));
    border-color:var(--vscode-focusBorder,rgba(128,128,128,.4))}
  .cmd-badge{
    font-family:monospace;font-weight:700;font-size:10px;
    padding:3px 6px;border-radius:3px;flex-shrink:0;
    text-transform:uppercase;letter-spacing:0.3px}
  .badge-npm { background:rgba(115,201,145,.2);color:#73C991;border:1px solid rgba(115,201,145,.35) }
  .badge-just{ background:rgba(197,134,192,.2);color:#C586C0;border:1px solid rgba(197,134,192,.35) }
  .badge-task{ background:rgba(78,201,176,.2); color:#4EC9B0;border:1px solid rgba(78,201,176,.35)  }
  .badge-make{ background:rgba(206,145,120,.2);color:#CE9178;border:1px solid rgba(206,145,120,.35) }
  .badge-python{ background:rgba(86,156,214,.2);color:#569CD6;border:1px solid rgba(86,156,214,.35) }
  .badge-go{ background:rgba(0,136,255,.2);color:#0088FF;border:1px solid rgba(0,136,255,.35) }
  .badge-powershell{ background:rgba(13,125,189,.2);color:#0D7DBD;border:1px solid rgba(13,125,189,.35) }
  .badge-shell{ background:rgba(0,153,102,.2);color:#009966;border:1px solid rgba(0,153,102,.35) }
  .badge-bun{ background:rgba(245,158,11,.2);color:#F59E0B;border:1px solid rgba(245,158,11,.35) }
  .badge-deno{ background:rgba(34,197,94,.2);color:#22C55E;border:1px solid rgba(34,197,94,.35) }
  .badge-npx{ background:rgba(99,102,241,.2);color:#6366F1;border:1px solid rgba(99,102,241,.35) }
  .badge-pnpm{ background:rgba(236,72,153,.2);color:#EC4899;border:1px solid rgba(236,72,153,.35) }
  .cmd-info{flex:1;min-width:0}
  .cmd-meta{
    display:flex;align-items:center;gap:8px;
    margin-bottom:4px;flex-wrap:wrap}
  .cmd-folder{
    font-size:10px;font-family:Consolas,'Courier New',monospace;
    color:var(--vscode-descriptionForeground);
    opacity:.95;
    background:var(--vscode-textCodeBlock-background,rgba(128,128,128,.12));
    border-radius:4px;padding:2px 6px}
  .cmd-name{
    font-weight:600;font-size:11px;
    color:var(--vscode-descriptionForeground);
    white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  .cmd-run{
    font-family:Consolas,'Courier New',monospace;
    font-weight:700;font-size:13px;line-height:1.45;
    white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  .cmd-desc{
    font-size:10px;margin-top:4px;
    color:var(--vscode-descriptionForeground);
    white-space:nowrap;overflow:hidden;text-overflow:ellipsis;
    font-family:Consolas,'Courier New',monospace;opacity:.85}
  .btn-run{
    margin-left:auto;
    padding:5px 10px;border-radius:4px;cursor:pointer;font-size:11px;
    background:var(--vscode-button-background,rgba(0,120,212,.85));
    color:var(--vscode-button-foreground,#fff);
    border:1px solid transparent;white-space:nowrap;flex-shrink:0}
  .btn-run:hover{background:var(--vscode-button-hoverBackground,rgba(0,120,212,1))}
  .btn-run:active{opacity:.8}
  .empty{
    padding:30px 10px;text-align:center;
    opacity:.5;font-size:13px}
  .no-workspace{
    padding:20px 10px;text-align:center;
    opacity:.6;font-size:12px;line-height:1.7}
</style>
</head>
<body>
<div id="toolbar">
  <button class="tbtn" id="btn-refresh" title="Refresh">↻</button>
  <input id="search" placeholder="Filter commands…" autocomplete="off"/>
  <select id="type-filter" title="Filter by type">
    <option value="">All</option>
    <option value="npm">npm</option>
    <option value="bun">bun</option>
    <option value="pnpm">pnpm</option>
    <option value="npx">npx</option>
    <option value="deno">deno</option>
    <option value="just">just</option>
    <option value="task">task</option>
    <option value="make">make</option>
    <option value="python">python</option>
    <option value="go">go</option>
    <option value="powershell">pwsh</option>
    <option value="shell">shell</option>
  </select>
  <button class="tbtn" id="btn-panel" title="Open as full panel">⬡</button>
</div>
<div id="content">
  <div class="empty">Scanning project…</div>
</div>
<div id="status">
  <span id="st-count">—</span>
</div>

<script>
(function(){
'use strict';
const vscode = acquireVsCodeApi();
let allCmds = [];
let filterText = '';
let filterType = '';

document.getElementById('btn-refresh').addEventListener('click', () => {
  document.getElementById('content').innerHTML = '<div class="empty">Scanning…</div>';
  vscode.postMessage({ type: 'refresh' });
});

document.getElementById('btn-panel').addEventListener('click', () => {
  vscode.postMessage({ type: 'openPanel' });
});

document.getElementById('search').addEventListener('input', function() {
  filterText = this.value.toLowerCase();
  render(allCmds);
});

document.getElementById('type-filter').addEventListener('change', function() {
  filterType = this.value;
  render(allCmds);
});

window.addEventListener('message', e => {
  const msg = e.data;
  if (msg.type === 'state') {
    allCmds = msg.commands || [];
    render(allCmds);
  }
});

function runCmd(command) {
  vscode.postMessage({ type: 'run', command });
}

function escHtml(s) {
  return String(s)
    .replace(/&/g,'&amp;').replace(/</g,'&lt;')
    .replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function buildCommandItem(c) {
  const item = document.createElement('div');
  item.className = 'cmd-item';
  item.title = 'Click to run: ' + escHtml(c.runCmd);

  item.innerHTML =
    '<div class="cmd-info">' +
      '<div class="cmd-meta">' +
        '<span class="cmd-badge badge-' + escHtml(c.type) + '">' + escHtml(c.type) + '</span>' +
        '<span class="cmd-folder">' + escHtml(c.folderLabel || c.workspaceLabel || '') + '</span>' +
        '<div class="cmd-name">' + escHtml(c.displayName || c.name) + '</div>' +
      '</div>' +
      '<div class="cmd-run">' + escHtml(c.runCmd) + '</div>' +
      '<div class="cmd-desc">cwd: ' + escHtml(c.cwd || '') + '</div>' +
      (c.description ? '<div class="cmd-desc">' + escHtml(c.description) + '</div>' : '') +
    '</div>' +
    '<button class="btn-run" title="Run in terminal: ' + escHtml(c.runCmd) + '">Run</button>';

  item.addEventListener('click', function(e) {
    if (e.target.classList.contains('btn-run')) return;
    runCmd(c);
  });

  const runButton = item.querySelector('.btn-run');
  if (runButton) {
    runButton.addEventListener('click', function(e) {
      e.stopPropagation();
      runCmd(c);
    });
  }

  return item;
}
function render(cmds) {
  const q = filterText;
  const t = filterType;

  let visible = q
    ? cmds.filter(c =>
        c.name.toLowerCase().includes(q) ||
        (c.displayName || '').toLowerCase().includes(q) ||
        (c.description||'').toLowerCase().includes(q) ||
        (c.folderLabel || '').toLowerCase().includes(q) ||
        (c.runCmd || '').toLowerCase().includes(q) ||
        c.type.includes(q)
      )
    : cmds.slice();

  if (t) {
    visible = visible.filter(c => c.type === t);
  }

  const el = document.getElementById('content');
  const st = document.getElementById('st-count');

  if (!cmds.length) {
    el.innerHTML = '<div class="no-workspace">No commands found.<br/>Open a project with a<br/><code>package.json</code>, <code>pyproject.toml</code>, <code>go.mod</code>,<br/><code>deno.json</code>, <code>bun.lock</code>, <code>pnpm-lock.yaml</code>,<br/><code>justfile</code>, <code>Taskfile.yml</code>, <code>Makefile</code><br/>or scripts in <code>scripts/</code> directory.</div>';
    st.textContent = 'No commands';
    return;
  }

  if (!visible.length) {
    el.innerHTML = '<div class="empty">No matches for filter.</div>';
    st.textContent = '0 / ' + cmds.length + ' commands';
    return;
  }

  el.innerHTML = '';

  for (const c of visible) {
    el.appendChild(buildCommandItem(c));
  }

  const isFiltered = q || t;
  st.textContent = visible.length + (visible.length === 1 ? ' command' : ' commands') +
    (isFiltered ? ' (filtered of ' + cmds.length + ')' : '');
}

vscode.postMessage({ type: 'ready' });
})();
</script>
</body>
</html>`;
}
