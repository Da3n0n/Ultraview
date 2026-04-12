import * as vscode from 'vscode';

export function buildDbHtml(webview: vscode.Webview, _extUri: vscode.Uri, dbType: string): string {
  return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>${dbType} Viewer</title>
<style>
/* ─── Reset & tokens (VS Code theme variables) ───── */
:root {
  --bg:       var(--vscode-editor-background);
  --surface:  var(--vscode-sideBar-background, var(--vscode-editor-background));
  --surface2: var(--vscode-list-hoverBackground, rgba(128,128,128,0.1));
  --border:   var(--vscode-panel-border, var(--vscode-widget-border, rgba(128,128,128,0.35)));
  --text:     var(--vscode-editor-foreground);
  --muted:    var(--vscode-descriptionForeground);
  --accent:   var(--vscode-textLink-foreground, var(--vscode-button-background));
  --green:    var(--vscode-terminal-ansiGreen,  #4ec9b0);
  --yellow:   var(--vscode-terminal-ansiYellow, #dcdcaa);
  --red:      var(--vscode-terminal-ansiRed,    #f44747);
  --mauve:    var(--vscode-terminal-ansiMagenta,#c586c0);
  --teal:     var(--vscode-terminal-ansiCyan,   #9cdcfe);
  --code:     var(--vscode-input-background,    var(--vscode-editor-background));
  --row-alt:  var(--vscode-list-inactiveSelectionBackground, rgba(128,128,128,0.06));
  --radius: 6px;
  --scrollbar: var(--vscode-scrollbarSlider-background, rgba(128,128,128,0.4));
}
*, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
html, body { height: 100%; background: var(--bg); color: var(--text);
  font: 13px/1.5 -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; overflow: hidden; }

/* ─── Layout ──────────────────────────────────────── */
#root { display: flex; height: 100vh; }
#sidebar { width: 220px; min-width: 160px; background: var(--surface);
  border-right: 1px solid var(--border); display: flex; flex-direction: column; overflow: hidden; }
#main { flex: 1; display: flex; flex-direction: column; overflow: hidden; }

/* ─── Sidebar ─────────────────────────────────────── */
#sidebar-header { padding: 12px 14px 10px; border-bottom: 1px solid var(--border);
  font-size: 11px; font-weight: 700; text-transform: uppercase;
  letter-spacing: 0.08em; color: var(--muted); display: flex; align-items: center; gap: 6px; }
#sidebar-meta { padding: 8px 14px; border-bottom: 1px solid var(--border);
  font-size: 11px; color: var(--muted); }
#sidebar-meta span { color: var(--accent); font-weight: 600; }
#table-list { flex: 1; overflow-y: auto; padding: 6px 0; }
.tbl-item { display: flex; align-items: center; gap: 8px; padding: 6px 14px;
  cursor: pointer; border-radius: 0; transition: background 0.1s; position: relative; }
.tbl-item:hover { background: var(--surface2); }
.tbl-item.active { background: var(--vscode-list-activeSelectionBackground, rgba(128,128,255,0.15)); }
.tbl-item.active::before { content: ''; position: absolute; left: 0; top: 0; bottom: 0;
  width: 2px; background: var(--accent); border-radius: 0 2px 2px 0; }
.tbl-icon { font-size: 14px; opacity: 0.7; flex-shrink: 0; }
.tbl-name { flex: 1; font-size: 12px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.tbl-count { font-size: 10px; color: var(--muted); background: var(--bg);
  padding: 1px 5px; border-radius: 10px; flex-shrink: 0; }

/* ─── Tabs ────────────────────────────────────────── */
#tabs { display: flex; background: var(--surface); border-bottom: 1px solid var(--border);
  padding: 0 12px; }
.tab { padding: 9px 16px; font-size: 12px; color: var(--muted); cursor: pointer;
  border-bottom: 2px solid transparent; transition: color 0.15s, border-color 0.15s; user-select: none; }
.tab:hover { color: var(--text); }
.tab.active { color: var(--accent); border-bottom-color: var(--accent); }

/* ─── Content ─────────────────────────────────────── */
#content { flex: 1; overflow: hidden; display: flex; flex-direction: column; }
.pane { display: none; flex: 1; flex-direction: column; overflow: hidden; }
.pane.visible { display: flex; }

/* ─── Table pane ──────────────────────────────────── */
#pane-table { position: relative; }
#table-toolbar { display: flex; align-items: center; gap: 10px; padding: 8px 14px;
  border-bottom: 1px solid var(--border); background: var(--surface); flex-shrink: 0; }
#table-name-label { font-size: 12px; font-weight: 600; color: var(--text); }
#table-info { font-size: 11px; color: var(--muted); margin-left: auto; }
.btn { padding: 5px 12px; background: var(--surface2); border: 1px solid var(--border);
  color: var(--text); border-radius: var(--radius); cursor: pointer; font-size: 12px;
  transition: background 0.15s; }
.btn:hover { background: var(--border); }
.btn-primary { background: var(--vscode-button-secondaryBackground, rgba(128,128,255,0.15)); border-color: var(--accent); color: var(--accent); }
.btn-primary:hover { background: var(--vscode-button-secondaryHoverBackground, rgba(128,128,255,0.25)); }

#table-scroll { flex: 1; overflow: auto; }
table { width: 100%; border-collapse: collapse; font-size: 12px; }
thead th { position: sticky; top: 0; background: var(--surface); color: var(--accent);
  font-weight: 600; text-align: left; padding: 8px 12px; border-bottom: 1px solid var(--border);
  white-space: nowrap; z-index: 1; }
tbody tr:nth-child(even) { background: var(--row-alt); }
tbody tr:hover { background: var(--vscode-list-hoverBackground, rgba(128,128,128,0.1)); }
td { padding: 6px 12px; border-bottom: 1px solid var(--border);
  max-width: 320px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.null-val { color: var(--muted); font-style: italic; font-size: 11px; }
.num-val { color: var(--teal); }
.bool-val { color: var(--green); }

#pagination { display: flex; align-items: center; gap: 8px; padding: 8px 14px;
  border-top: 1px solid var(--border); background: var(--surface); flex-shrink: 0;
  font-size: 12px; color: var(--muted); }
#page-info { flex: 1; }

/* ─── Structure pane ──────────────────────────────── */
#pane-structure { overflow-y: auto; padding: 14px; }
.col-table { width: 100%; border-collapse: collapse; font-size: 12px; }
.col-table th { background: var(--surface); color: var(--accent); padding: 7px 12px;
  text-align: left; font-weight: 600; border: 1px solid var(--border); }
.col-table td { padding: 6px 12px; border: 1px solid var(--border); }
.pk-badge { display: inline-block; background: var(--vscode-badge-background, rgba(128,128,255,0.2)); color: var(--accent);
  padding: 1px 5px; border-radius: 3px; font-size: 10px; margin-left: 4px; }
.notnull-badge { display: inline-block; background: var(--vscode-inputValidation-errorBackground, rgba(255,80,80,0.2)); color: var(--red);
  padding: 1px 5px; border-radius: 3px; font-size: 10px; margin-left: 4px; }

/* ─── Query pane ──────────────────────────────────── */
#pane-query { gap: 0; }
#query-editor-wrap { flex-shrink: 0; border-bottom: 1px solid var(--border); }
#query-toolbar { display: flex; align-items: center; gap: 8px; padding: 8px 14px;
  background: var(--surface); }
#query-label { font-size: 12px; color: var(--muted); flex: 1; }
#query-input { width: 100%; padding: 10px 14px; background: var(--code); color: var(--text);
  border: none; font-family: 'Cascadia Code', 'Fira Code', Consolas, monospace; font-size: 12px;
  resize: vertical; min-height: 80px; outline: none; tab-size: 2; }
#query-result { flex: 1; overflow-y: auto; }
#query-status { padding: 8px 14px; font-size: 11px; color: var(--muted);
  border-bottom: 1px solid var(--border); background: var(--surface); flex-shrink: 0; }
#query-status.err { color: var(--red); }
#query-status.ok { color: var(--green); }

/* ─── Stats pane ──────────────────────────────────── */
#pane-stats { overflow-y: auto; padding: 24px; }
.stat-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(200px,1fr)); gap: 16px; margin-bottom: 24px; }
.stat-card { background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius);
  padding: 16px; }
.stat-card .label { font-size: 11px; color: var(--muted); text-transform: uppercase;
  letter-spacing: 0.06em; margin-bottom: 6px; }
.stat-card .value { font-size: 22px; font-weight: 700; color: var(--accent); }
.stat-card .sub { font-size: 11px; color: var(--muted); margin-top: 4px; }
.file-path { font-size: 11px; color: var(--muted); font-family: Consolas, monospace;
  word-break: break-all; background: var(--surface); border: 1px solid var(--border);
  border-radius: var(--radius); padding: 10px 14px; margin-bottom: 16px; }

/* ─── Scrollbars ──────────────────────────────────── */
::-webkit-scrollbar { width: 7px; height: 7px; }
::-webkit-scrollbar-track { background: transparent; }
::-webkit-scrollbar-thumb { background: var(--scrollbar); border-radius: 4px; }
::-webkit-scrollbar-thumb:hover { background: var(--muted); }

/* ─── Loader ──────────────────────────────────────── */
#loader { display: flex; flex-direction: column; align-items: center; justify-content: center;
  height: 100%; gap: 14px; }
.spinner { width: 32px; height: 32px; border: 3px solid var(--border);
  border-top-color: var(--accent); border-radius: 50%; animation: spin 0.7s linear infinite; }
@keyframes spin { to { transform: rotate(360deg); } }
#loader p { color: var(--muted); font-size: 13px; }
</style>
</head>
<body>
<div id="root">
  <!-- Sidebar -->
  <div id="sidebar">
    <div id="sidebar-header">
      <span>&#9646;</span> ${dbType}
    </div>
    <div id="sidebar-meta" style="display:none">
      <div>Size: <span id="meta-size">–</span></div>
      <div>Tables: <span id="meta-tables">–</span></div>
    </div>
    <div id="table-list"><div id="loader"><div class="spinner"></div><p>Loading…</p></div></div>
  </div>

  <!-- Main -->
  <div id="main">
    <div id="tabs">
      <div class="tab active" data-tab="table">Data</div>
      <div class="tab" data-tab="structure">Structure</div>
      <div class="tab" data-tab="query">Query</div>
      <div class="tab" data-tab="stats">Stats</div>
    </div>
    <div id="content">
      <!-- Data pane -->
      <div id="pane-table" class="pane visible">
        <div id="loader-main" style="display:flex;flex:1;flex-direction:column;align-items:center;justify-content:center;gap:14px">
          <div class="spinner"></div><p style="color:var(--muted)">Select a table</p>
        </div>
        <div id="table-view" style="display:none;flex:1;flex-direction:column;overflow:hidden">
          <div id="table-toolbar">
            <span id="table-name-label"></span>
            <span id="table-info"></span>
          </div>
          <div id="table-scroll"><table><thead id="thead-row"></thead><tbody id="tbody"></tbody></table></div>
          <div id="pagination">
            <span id="page-info"></span>
            <button class="btn" id="btn-prev">← Prev</button>
            <button class="btn" id="btn-next">Next →</button>
          </div>
        </div>
      </div>

      <!-- Structure pane -->
      <div id="pane-structure" class="pane">
        <div id="structure-content"><p style="color:var(--muted);padding:14px">Select a table to view its structure.</p></div>
      </div>

      <!-- Query pane -->
      <div id="pane-query" class="pane">
        <div id="query-editor-wrap">
          <div id="query-toolbar">
            <span id="query-label">SQL Query</span>
            <button class="btn btn-primary" id="btn-run">▶ Run (Ctrl+Enter)</button>
          </div>
          <textarea id="query-input" placeholder="SELECT * FROM …" spellcheck="false"></textarea>
        </div>
        <div id="query-status" style="display:none"></div>
        <div id="query-result" style="overflow-x:auto"></div>
      </div>

      <!-- Stats pane -->
      <div id="pane-stats" class="pane">
        <div id="stats-content"><p style="color:var(--muted)">Loading…</p></div>
      </div>
    </div>
  </div>
</div>

<script>
(function () {
  'use strict';
  const vscode = acquireVsCodeApi();

  /* ── State ── */
  let schema = null;
  let activeTable = null;
  let page = 0;
  const PAGE_SIZE = 200;
  let totalRows = 0;

  /* ── Helpers ── */
  function fmtBytes(b) {
    if (b == null) return '–';
    if (b < 1024) return b + ' B';
    if (b < 1048576) return (b / 1024).toFixed(1) + ' KB';
    return (b / 1048576).toFixed(2) + ' MB';
  }
  function esc(v) {
    if (v == null) return '<span class="null-val">NULL</span>';
    const s = String(v);
    const safe = s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
    if (typeof v === 'number') return '<span class="num-val">' + safe + '</span>';
    if (typeof v === 'boolean') return '<span class="bool-val">' + safe + '</span>';
    return safe;
  }
  function buildTable(cols, rows) {
    if (!cols.length && !rows.length) return '<p style="padding:14px;color:var(--muted)">No rows.</p>';
    const heads = cols.map(c => '<th>' + String(c).replace(/</g,'&lt;') + '</th>').join('');
    const body = rows.map(r =>
      '<tr>' + cols.map(c => '<td>' + esc(r[c]) + '</td>').join('') + '</tr>'
    ).join('');
    return '<table><thead><tr>' + heads + '</tr></thead><tbody>' + body + '</tbody></table>';
  }

  /* ── Tabs ── */
  document.querySelectorAll('.tab').forEach(tab => {
    tab.addEventListener('click', () => {
      document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
      document.querySelectorAll('.pane').forEach(p => p.classList.remove('visible'));
      tab.classList.add('active');
      const id = 'pane-' + tab.dataset.tab;
      const pane = document.getElementById(id);
      if (pane) pane.classList.add('visible');
      if (tab.dataset.tab === 'structure') renderStructure();
    });
  });

  /* ── Table list ── */
  function renderSidebar() {
    const list = document.getElementById('table-list');
    if (!schema || !schema.tables.length) {
      list.innerHTML = '<p style="padding:14px;color:var(--muted);font-size:12px">No tables found.</p>';
      return;
    }
    document.getElementById('sidebar-meta').style.display = '';
    document.getElementById('meta-size').textContent = fmtBytes(schema.dbSize);
    document.getElementById('meta-tables').textContent = schema.tables.length;

    list.innerHTML = schema.tables.map((t, i) =>
      '<div class="tbl-item" data-idx="' + i + '" data-name="' + t.name.replace(/"/g,'&quot;') + '">' +
        '<span class="tbl-icon">&#9706;</span>' +
        '<span class="tbl-name">' + t.name.replace(/</g,'&lt;') + '</span>' +
        '<span class="tbl-count">' + (t.rowCount != null ? t.rowCount.toLocaleString() : '?') + '</span>' +
      '</div>'
    ).join('');

    list.querySelectorAll('.tbl-item').forEach(item => {
      item.addEventListener('click', () => {
        list.querySelectorAll('.tbl-item').forEach(i => i.classList.remove('active'));
        item.classList.add('active');
        selectTable(schema.tables[+item.dataset.idx].name, schema.tables[+item.dataset.idx].rowCount);
      });
    });

    // Auto-select first table
    const first = list.querySelector('.tbl-item');
    if (first) first.click();
  }

  function selectTable(name, count) {
    activeTable = name;
    totalRows = count || 0;
    page = 0;
    // switch to data tab
    document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
    document.querySelectorAll('.pane').forEach(p => p.classList.remove('visible'));
    document.querySelector('[data-tab="table"]').classList.add('active');
    document.getElementById('pane-table').classList.add('visible');

    document.getElementById('loader-main').style.display = 'flex';
    document.getElementById('table-view').style.display = 'none';
    document.getElementById('table-name-label').textContent = name;
    vscode.postMessage({ type: 'getTableData', table: name, page: 0, pageSize: PAGE_SIZE });
  }

  /* ── Pagination ── */
  document.getElementById('btn-prev').addEventListener('click', () => {
    if (page > 0) { page--; vscode.postMessage({ type: 'getTableData', table: activeTable, page, pageSize: PAGE_SIZE }); }
  });
  document.getElementById('btn-next').addEventListener('click', () => {
    if ((page + 1) * PAGE_SIZE < totalRows) { page++; vscode.postMessage({ type: 'getTableData', table: activeTable, page, pageSize: PAGE_SIZE }); }
  });

  /* ── Structure ── */
  function renderStructure() {
    const el = document.getElementById('structure-content');
    if (!activeTable || !schema) { el.innerHTML = '<p style="color:var(--muted);padding:14px">Select a table first.</p>'; return; }
    const tbl = schema.tables.find(t => t.name === activeTable);
    if (!tbl || !tbl.columns.length) { el.innerHTML = '<p style="color:var(--muted);padding:14px">No column information available.</p>'; return; }
    const rows = tbl.columns.map(c =>
      '<tr><td>' + String(c.name).replace(/</g,'&lt;') + (c.pk ? '<span class="pk-badge">PK</span>' : '') +
      (c.notnull ? '<span class="notnull-badge">NOT NULL</span>' : '') +
      '</td><td style="color:var(--teal)">' + String(c.type || '').replace(/</g,'&lt;') + '</td></tr>'
    ).join('');
    el.innerHTML = '<h3 style="font-size:13px;color:var(--accent);margin-bottom:12px">' + tbl.name + '</h3>' +
      '<table class="col-table"><thead><tr><th>Column</th><th>Type</th></tr></thead><tbody>' + rows + '</tbody></table>';
  }

  /* ── Query ── */
  document.getElementById('btn-run').addEventListener('click', runQuery);
  document.getElementById('query-input').addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { e.preventDefault(); runQuery(); }
  });
  function runQuery() {
    const sql = document.getElementById('query-input').value.trim();
    if (!sql) return;
    const status = document.getElementById('query-status');
    status.style.display = '';
    status.className = '';
    status.textContent = 'Running…';
    document.getElementById('query-result').innerHTML = '';
    vscode.postMessage({ type: 'runQuery', sql });
  }

  /* ── Stats ── */
  function renderStats() {
    if (!schema) return;
    const el = document.getElementById('stats-content');
    const totalTableRows = schema.tables.reduce((a, t) => a + (t.rowCount || 0), 0);
    el.innerHTML =
      '<div class="file-path">' + schema.filePath.replace(/</g,'&lt;') + '</div>' +
      '<div class="stat-grid">' +
        '<div class="stat-card"><div class="label">Type</div><div class="value" style="font-size:14px;color:var(--mauve)">' + schema.dbType + '</div></div>' +
        '<div class="stat-card"><div class="label">File Size</div><div class="value">' + fmtBytes(schema.dbSize) + '</div></div>' +
        '<div class="stat-card"><div class="label">Tables</div><div class="value">' + schema.tables.length + '</div></div>' +
        '<div class="stat-card"><div class="label">Total Rows</div><div class="value">' + totalTableRows.toLocaleString() + '</div></div>' +
      '</div>' +
      '<table class="col-table"><thead><tr><th>Table</th><th>Rows</th><th>Columns</th></tr></thead><tbody>' +
      schema.tables.map(t =>
        '<tr><td>' + t.name + '</td><td style="color:var(--teal)">' + (t.rowCount != null ? t.rowCount.toLocaleString() : '?') +
        '</td><td style="color:var(--muted)">' + (t.columns ? t.columns.length : '?') + '</td></tr>'
      ).join('') + '</tbody></table>';
  }
  document.querySelector('[data-tab="stats"]').addEventListener('click', renderStats);

  /* ── Messages from extension ── */
  window.addEventListener('message', (event) => {
    const msg = event.data;
    switch (msg.type) {
      case 'schema': {
        schema = msg;
        renderSidebar();
        renderStats();
        break;
      }
      case 'tableData': {
        document.getElementById('loader-main').style.display = 'none';
        const view = document.getElementById('table-view');
        view.style.display = 'flex';
        
        // Update row count in schema and UI if provided
        if (msg.rowCount !== undefined) {
          totalRows = msg.rowCount;
          const tblMeta = schema && schema.tables.find(t => t.name === msg.table);
          if (tblMeta) {
            tblMeta.rowCount = msg.rowCount;
            // Update sidebar count label
            const sidebarItem = document.querySelector(\`.tbl-item[data-name="\${msg.table.replace(/"/g,'\\\\\\"')}"] .tbl-count\`);
            if (sidebarItem) sidebarItem.textContent = msg.rowCount.toLocaleString();
          }
        } else {
          // Fallback to schema total
          const tblMeta = schema && schema.tables.find(t => t.name === msg.table);
          if (tblMeta && tblMeta.rowCount != null) totalRows = tblMeta.rowCount;
        }

        page = msg.page;
        // Header
        document.getElementById('thead-row').innerHTML =
          '<tr>' + msg.columns.map(c => '<th>' + String(c).replace(/</g,'&lt;') + '</th>').join('') + '</tr>';
        // Body
        document.getElementById('tbody').innerHTML =
          msg.rows.map(r =>
            '<tr>' + msg.columns.map(c => '<td>' + esc(r[c]) + '</td>').join('') + '</tr>'
          ).join('');
        // Info
        const start = page * PAGE_SIZE + 1;
        const end = page * PAGE_SIZE + msg.rows.length;
        document.getElementById('table-info').textContent =
          'Rows ' + start + '–' + end + ' of ' + totalRows.toLocaleString();
        document.getElementById('page-info').textContent =
          'Page ' + (page + 1) + ' / ' + Math.max(1, Math.ceil(totalRows / PAGE_SIZE));
        document.getElementById('btn-prev').disabled = page === 0;
        document.getElementById('btn-next').disabled = end >= totalRows;
        break;
      }
      case 'queryResult': {
        const status = document.getElementById('query-status');
        const result = document.getElementById('query-result');
        if (msg.rows && msg.rows.length > 0) {
          status.className = 'ok';
          status.textContent = msg.rows.length + ' row(s) returned.';
          result.innerHTML = buildTable(msg.columns || [], msg.rows);
        } else if (msg.changes != null) {
          status.className = 'ok';
          status.textContent = msg.changes + ' row(s) affected.';
          result.innerHTML = '';
        } else {
          status.className = 'ok';
          status.textContent = 'Query executed. No rows returned.';
          result.innerHTML = '';
        }
        break;
      }
      case 'error': {
        const status = document.getElementById('query-status');
        if (status) { status.style.display = ''; status.className = 'err'; status.textContent = '⚠ ' + msg.message; }
        const loaderMain = document.getElementById('loader-main');
        if (loaderMain && loaderMain.style.display !== 'none') {
          loaderMain.innerHTML = '<p style="color:var(--red);padding:20px;text-align:center">⚠ ' + String(msg.message).replace(/</g,'&lt;') + '</p>';
        }
        break;
      }
    }
  });

  // Signal ready
  vscode.postMessage({ type: 'ready' });
})();
</script>
</body>
</html>`;
}
