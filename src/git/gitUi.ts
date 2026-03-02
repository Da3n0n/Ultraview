export function buildGitHtml(): string {
  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1" />
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
    #content{position:fixed;top:36px;left:0;right:0;bottom:24px;overflow-y:auto;padding:8px}
    #status{
      position:fixed;bottom:0;left:0;right:0;height:24px;
      display:flex;align-items:center;padding:0 10px;gap:12px;
      font-size:10px;color:var(--vscode-descriptionForeground);
      background:var(--vscode-statusBar-background,var(--vscode-sideBar-background));
      border-top:1px solid var(--vscode-panel-border,rgba(128,128,128,.2))}
    .section{margin-bottom:12px}
    .section-header{display:flex;justify-content:space-between;align-items:center;margin-bottom:6px}
    .section-title{font-size:11px;font-weight:600;opacity:0.7;text-transform:uppercase;letter-spacing:0.5px}
    .muted{color:var(--vscode-descriptionForeground);font-size:11px}
    .btn-action{
      padding:4px 10px;border-radius:4px;cursor:pointer;font-size:11px;
      background:var(--vscode-button-secondaryBackground,rgba(128,128,128,.15));
      border:1px solid var(--vscode-panel-border,rgba(128,128,128,.3));
      color:var(--vscode-editor-foreground);white-space:nowrap;flex-shrink:0}
    .btn-action:hover{background:var(--vscode-list-hoverBackground)}
    .btn-sm{padding:2px 6px;font-size:10px}
    .project-list{list-style:none;padding:0;margin:0}
    .project-item{
      display:flex;justify-content:space-between;align-items:center;
      padding:8px 10px;margin-bottom:6px;
      background:var(--vscode-editor-background,rgba(30,30,30,.5));
      border:1px solid var(--vscode-panel-border,rgba(128,128,128,.2));
      border-radius:6px;transition:background .15s,border-color .15s}
    .project-item:hover{background:var(--vscode-list-hoverBackground,rgba(255,255,255,.05))}
    .project-item.active{
      background:rgba(40,167,69,.12);
      border-color:rgba(40,167,69,.45)}
    .project-info{flex:1;min-width:0}
    .project-name{font-weight:600;font-size:12px;margin-bottom:2px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
    .project-path{font-size:10px;color:var(--vscode-descriptionForeground);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
    .project-account{font-size:10px;color:rgba(40,167,69,.9);margin-top:2px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
    .project-actions{display:flex;gap:4px;flex-shrink:0;margin-left:8px}
    .account-item{
      display:flex;justify-content:space-between;align-items:center;
      padding:8px 10px;margin-bottom:6px;cursor:pointer;
      background:var(--vscode-editor-background,rgba(30,30,30,.5));
      border:1px solid var(--vscode-panel-border,rgba(128,128,128,.2));
      border-radius:6px;transition:background .15s,border-color .15s}
    .account-item:hover{background:var(--vscode-list-hoverBackground,rgba(255,255,255,.05))}
    .account-item.active{
      background:rgba(40,167,69,.12);
      border-color:rgba(40,167,69,.45)}
    .account-info{flex:1;min-width:0;overflow:hidden}
    .account-name{font-weight:600;font-size:12px;display:flex;align-items:center;gap:6px;white-space:nowrap}
    .account-name-text{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
    .account-provider{font-size:10px;color:var(--vscode-descriptionForeground);opacity:.7}
    .account-actions{display:flex;gap:4px;flex-shrink:0;margin-left:8px}
    .account-item.warning{
      background:rgba(255,193,7,.12);
      border-color:rgba(255,193,7,.45)}
    .account-item.expired{
      background:rgba(220,53,69,.12);
      border-color:rgba(220,53,69,.45)}
    .auth-badge{
      display:inline-block;padding:1px 5px;border-radius:3px;font-size:9px;
      font-weight:600;letter-spacing:0.3px;text-transform:uppercase;
      vertical-align:middle;margin-left:4px;line-height:1.4}
    .auth-badge.oauth{background:rgba(66,133,244,.18);color:rgba(66,133,244,.9)}
    .auth-badge.ssh{background:rgba(156,39,176,.15);color:rgba(156,39,176,.9)}
    .auth-badge.pat{background:rgba(255,152,0,.15);color:rgba(255,152,0,.9)}
    .status-dot{
      display:inline-block;width:7px;height:7px;border-radius:50%;
      vertical-align:middle;margin-right:5px;flex-shrink:0}
    .status-dot.valid{background:#28a745}
    .status-dot.warning{background:#ffc107}
    .status-dot.expired{background:#dc3545}
    .btn-reauth{
      padding:2px 6px;font-size:9px;border-radius:3px;cursor:pointer;
      background:rgba(255,193,7,.2);border:1px solid rgba(255,193,7,.5);
      color:var(--vscode-editor-foreground);white-space:nowrap}
    .btn-reauth:hover{background:rgba(255,193,7,.35)}
    .btn-reauth.expired-btn{
      background:rgba(220,53,69,.2);border-color:rgba(220,53,69,.5)}
    .btn-reauth.expired-btn:hover{background:rgba(220,53,69,.35)}
    .empty-state{
      text-align:center;padding:20px;color:var(--vscode-descriptionForeground);
      font-size:11px}
    .loading{position:fixed;inset:0;display:flex;align-items:center;justify-content:center;gap:12px;
      background:var(--vscode-sideBar-background);z-index:20}
    .spinner{width:20px;height:20px;border-radius:50%;border:2px solid var(--vscode-panel-border);
      border-top-color:var(--vscode-textLink-foreground,#4ec9b0);animation:spin .7s linear infinite}
    @keyframes spin{to{transform:rotate(360deg)}}
    .hidden{display:none !important}
  </style>
</head>
<body>
<div id="loading"><div class="spinner"></div><span>Loading...</span></div>
<div id="toolbar">
  <button class="tbtn" id="btn-add" title="Add new project">+ Add</button>
  <button class="tbtn" id="btn-refresh" title="Refresh list">↻</button>
  <input id="search" placeholder="Filter projects..." autocomplete="off"/>
  <button class="tbtn" id="btn-add-account" title="Add account">+ Account</button>
</div>
<div id="content">

  <div class="section" id="accounts-section">
    <div class="section-header">
      <span class="section-title">Accounts</span>
    </div>
    <div id="account-list"></div>
  </div>

  <div class="section">
    <div class="section-header">
      <span class="section-title">Projects</span>
      <div style="display:flex;gap:4px">
        <button class="btn-action btn-sm" id="btn-add-project">+ Add Current</button>
        <button class="btn-action btn-sm" id="btn-add-repo">+ Add Repo</button>
      </div>
    </div>
    <ul id="project-list" class="project-list"></ul>
    <div id="empty-state" class="empty-state hidden">
      No projects yet. Click "+ Add" to add a project.
    </div>
  </div>
</div>
<div id="status">
  <span id="st-account"></span>
  <span id="st-projects">0 projects</span>
</div>

<script>
(function(){
'use strict';

var vscode = acquireVsCodeApi();
var allProjects = [];
var filterText = '';
var allAccounts = [];
var activeAccountId = null;
var activeProjectId = null;
var activeRepo = '';

var projectList = document.getElementById('project-list');
var emptyState = document.getElementById('empty-state');
var stProjects = document.getElementById('st-projects');
var accountList = document.getElementById('account-list');
var stAccount = document.getElementById('st-account');

function esc(s) {
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function renderProjects() {
  var q = filterText.toLowerCase();
  var filtered = allProjects.filter(function(p) { 
    return !q || p.name.toLowerCase().includes(q) || p.path.toLowerCase().includes(q);
  });
  
  projectList.innerHTML = '';
  
  if (filtered.length === 0) {
    emptyState.classList.remove('hidden');
    if (allProjects.length > 0 && q) {
      emptyState.textContent = 'No projects match "' + esc(q) + '"';
    }
  } else {
    emptyState.classList.add('hidden');
    filtered.forEach(function(pr) {
      var isActive = activeRepo && pr.path === activeRepo;
      var boundAccount = allAccounts.find(function(a) { return a.id === pr.accountId; });
      var li = document.createElement('li');
      li.className = 'project-item' + (isActive ? ' active' : '');
      li.innerHTML =
        '<div class="project-info">' +
          '<div class="project-name">' + esc(pr.name) + '</div>' +
          '<div class="project-path">' + esc(pr.path) + '</div>' +
          (boundAccount ? '<div class="project-account">⚡ ' + esc(boundAccount.username) + ' (' + esc(boundAccount.provider) + ')</div>' : '') +
        '</div>' +
        '<div class="project-actions">' +
          '<button class="btn-action btn-sm" data-action="open" data-id="' + esc(pr.id) + '">Open</button>' +
          '<button class="btn-action btn-sm" data-action="delete" data-id="' + esc(pr.id) + '">×</button>' +
        '</div>';
      projectList.appendChild(li);
    });
  }
  
  var count = filtered.length;
  stProjects.textContent = count + ' project' + (count !== 1 ? 's' : '');
}

function renderAccounts() {
  accountList.innerHTML = '';
  
  if (allAccounts.length === 0) {
    accountList.innerHTML = '<div class="muted" style="padding:6px 0">No accounts yet. Click "+ Account" to add one.</div>';
    stAccount.textContent = 'No account';
    return;
  }

  allAccounts.forEach(function(acc) {
    var isActive = activeAccountId && activeAccountId === acc.id;
    var authStatus = acc.authStatus || 'valid';
    var authMethod = acc.authMethod || '';
    var statusClass = authStatus !== 'valid' ? ' ' + authStatus : '';
    var div = document.createElement('div');
    div.className = 'account-item' + (isActive ? ' active' : '') + statusClass;

    // Auth method badge
    var badgeHtml = '';
    if (authMethod === 'oauth') badgeHtml = '<span class="auth-badge oauth">OAuth</span>';
    else if (authMethod === 'ssh') badgeHtml = '<span class="auth-badge ssh">SSH</span>';
    else if (authMethod === 'pat') badgeHtml = '<span class="auth-badge pat">PAT</span>';

    // Status dot
    var dotTitle = authStatus === 'valid' ? 'Token valid' : authStatus === 'warning' ? 'Token may need re-auth' : 'Token expired';
    var dotHtml = '<span class="status-dot ' + authStatus + '" title="' + dotTitle + '"></span>';

    // Auth icon based on method
    var authIcon = authMethod === 'ssh' ? '🔑' : authMethod === 'pat' ? '🔒' : '🔐';

    // Re-auth button for warning/expired OAuth
    var reAuthHtml = '';
    if (authMethod === 'oauth' && (authStatus === 'warning' || authStatus === 'expired')) {
      var btnClass = authStatus === 'expired' ? 'btn-reauth expired-btn' : 'btn-reauth';
      reAuthHtml = '<button class="' + btnClass + '" data-action="reauth" data-id="' + esc(acc.id) + '" title="Re-authenticate via browser">Re-auth</button>';
    }

    div.innerHTML = 
      '<div class="account-info">' +
        '<div class="account-name">' + 
          dotHtml +
          '<span class="account-name-text">' + esc(acc.username) + '</span>' +
          badgeHtml +
        '</div>' +
        '<div style="font-size:10px;color:var(--vscode-descriptionForeground);margin-top:1px">' +
          authIcon + ' ' + esc(acc.provider) +
          (authStatus === 'expired' ? ' · <span style="color:#dc3545">Token expired</span>' : 
           authStatus === 'warning' ? ' · <span style="color:#ffc107">Needs validation</span>' : 
           ' · <span style="color:#28a745">Valid</span>') +
        '</div>' +
      '</div>' +
      '<div class="account-actions">' +
        reAuthHtml +
        '<button class="btn-action btn-sm" data-action="auth" data-id="' + esc(acc.id) + '" title="Manage Authentication">' + authIcon + '</button>' +
        '<button class="btn-action btn-sm" data-action="delete" data-id="' + esc(acc.id) + '" title="Remove Account">×</button>' +
      '</div>';
    div.dataset.id = acc.id;
    // Click the row (not buttons) to switch account
    div.addEventListener('click', function(e) {
      if (e.target.closest('[data-action]')) return;
      vscode.postMessage({ type: 'switchAccount', accountId: acc.id });
    });
    accountList.appendChild(div);
  });

  var activeAcc = allAccounts.find(function(a) { return a.id === activeAccountId; });
  stAccount.textContent = activeAcc ? 'Account: ' + activeAcc.username : 'No account';
}

function updateUI(msg) {
  document.getElementById('loading').classList.add('hidden');

  allProjects = msg.projects || [];
  allAccounts = msg.accounts || [];
  activeAccountId = msg.activeAccountId || null;
  activeProjectId = msg.activeProjectId || null;
  activeRepo = msg.activeRepo || '';

  renderProjects();
  renderAccounts();
}

window.addEventListener('message', function(e) {
  var msg = e.data;
  if (msg.type === 'state') {
    updateUI(msg);
  } else if (msg.type === 'projectAdded') {
    vscode.postMessage({ type: 'refresh' });
  } else if (msg.type === 'projectRemoved') {
    vscode.postMessage({ type: 'refresh' });
  } else if (msg.type === 'accountAdded') {
    vscode.postMessage({ type: 'refresh' });
  } else if (msg.type === 'accountRemoved') {
    vscode.postMessage({ type: 'refresh' });
  } else if (msg.type === 'accountUpdated') {
    vscode.postMessage({ type: 'refresh' });
  } else if (msg.type === 'sshKeyGenerated') {
    vscode.postMessage({ type: 'refresh' });
  }
});

document.getElementById('btn-add').addEventListener('click', function() {
  vscode.postMessage({ type: 'addProject' });
});

document.getElementById('btn-add-project').addEventListener('click', function() {
  vscode.postMessage({ type: 'addCurrentProject' });
});

document.getElementById('btn-add-repo').addEventListener('click', function() {
  vscode.postMessage({ type: 'addRepo' });
});

document.getElementById('btn-refresh').addEventListener('click', function() {
  document.getElementById('loading').classList.remove('hidden');
  vscode.postMessage({ type: 'refresh' });
});

document.getElementById('btn-add-account').addEventListener('click', function() {
  vscode.postMessage({ type: 'addAccount' });
});

document.getElementById('search').addEventListener('input', function() {
  filterText = this.value;
  renderProjects();
});

projectList.addEventListener('click', function(e) {
  var btn = e.target.closest('[data-action]');
  if (!btn) return;
  
  var action = btn.dataset.action;
  var id = btn.dataset.id;
  
  if (action === 'open') {
    vscode.postMessage({ type: 'open', id: id });
  } else if (action === 'delete') {
    vscode.postMessage({ type: 'delete', id: id });
  }
});

accountList.addEventListener('click', function(e) {
  var btn = e.target.closest('[data-action]');
  if (!btn) return;
  
  var action = btn.dataset.action;
  var id = btn.dataset.id;
  
  if (action === 'auth') {
    vscode.postMessage({ type: 'authOptions', accountId: id });
  } else if (action === 'delete') {
    vscode.postMessage({ type: 'removeAccount', accountId: id });
  } else if (action === 'reauth') {
    vscode.postMessage({ type: 'reAuthAccount', accountId: id });
  }
});

vscode.postMessage({ type: 'ready' });

})();
</script>
</body>
</html>`;
}
