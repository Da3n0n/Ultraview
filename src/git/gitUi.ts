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
    #content{position:fixed;top:0;left:0;right:0;bottom:24px;overflow-y:auto;padding:8px}
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
    .git-badges{display:flex;gap:4px;margin-top:4px;flex-wrap:wrap;align-items:center}
    .git-badge{
      display:inline-flex;align-items:center;gap:3px;
      padding:1px 6px;border-radius:3px;font-size:9px;
      font-weight:600;letter-spacing:0.3px;line-height:1.4}
    .git-badge.local{background:rgba(255,152,0,.18);color:#FFA726;border:1px solid rgba(255,152,0,.35)}
    .git-badge.behind{background:rgba(66,165,245,.18);color:#42A5F5;border:1px solid rgba(66,165,245,.35)}
    .git-badge.ahead{background:rgba(102,187,106,.18);color:#66BB6A;border:1px solid rgba(102,187,106,.35)}
    .git-badge.synced{background:rgba(76,175,80,.12);color:#4CAF50;border:1px solid rgba(76,175,80,.25)}
    .git-badge.branch{background:rgba(128,128,128,.12);color:var(--vscode-descriptionForeground);border:1px solid rgba(128,128,128,.2)}
    .git-inline-row{display:flex;align-items:center;gap:8px;margin:4px 0 0 0;flex-wrap:wrap}
    .git-badge{margin-right:2px;}
    .btn-git{
      padding:2px 7px;border-radius:3px;cursor:pointer;font-size:10px;font-weight:600;
      white-space:nowrap;border:1px solid transparent; margin-right:2px; vertical-align:middle;}
    .btn-git.pull{background:rgba(66,165,245,.2);color:#42A5F5;border-color:rgba(66,165,245,.4)}
    .btn-git.pull:hover{background:rgba(66,165,245,.35)}
    .btn-git.push{background:rgba(255,152,0,.2);color:#FFA726;border-color:rgba(255,152,0,.4)}
    .btn-git.push:hover{background:rgba(255,152,0,.35)}
    .btn-git.sync{background:rgba(156,39,176,.2);color:#BA68C8;border-color:rgba(156,39,176,.4)}
    .btn-git.sync:hover{background:rgba(156,39,176,.35)}
  </style>
</head>
<body>
<div id="loading"><div class="spinner"></div><span>Loading...</span></div>
<div id="content">

  <div class="section" id="accounts-section">
    <div class="section-header">
      <span class="section-title">Accounts</span>
      <button class="btn-action btn-sm" id="btn-add-account">+ Account</button>
    </div>
    <div id="account-list"></div>
  </div>

  <div class="section">
    <div class="section-header">
      <span class="section-title">Projects</span>
      <div style="display:flex;gap:4px">
        <button class="btn-action btn-sm" id="btn-refresh-projects" title="Refresh all projects">↻ Refresh</button>
        <button class="btn-action btn-sm" id="btn-add-project">+ Add Current</button>
        <button class="btn-action btn-sm" id="btn-add-repo">+ Add Repo</button>
        <button class="btn-action btn-sm" id="btn-add" title="Browse for folder">+ Browse</button>
      </div>
    </div>
    <ul id="project-list" class="project-list"></ul>
    <div id="empty-state" class="empty-state hidden">
      No projects yet. Click "+ Browse" to add a project.
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
var allAccounts = [];
var activeAccountId = null;
var activeProjectId = null;
var activeRepo = '';
var activeRepoName = '';
var gitStatuses = {};

var projectList = document.getElementById('project-list');
var emptyState = document.getElementById('empty-state');
var stProjects = document.getElementById('st-projects');
var accountList = document.getElementById('account-list');
var stAccount = document.getElementById('st-account');

// Add refresh handler for projects
var btnRefreshProjects = document.getElementById('btn-refresh-projects');
if (btnRefreshProjects) {
  btnRefreshProjects.addEventListener('click', function() {
    vscode.postMessage({ type: 'refreshProjects' });
  });
}

// Periodic auto-refresh for active project only
var autoRefreshInterval = null;
var lastActiveProjectId = null;

function setupAutoRefresh(activeProjectId) {
  if (autoRefreshInterval) {
    clearInterval(autoRefreshInterval);
    autoRefreshInterval = null;
  }
  if (!activeProjectId) return;
  lastActiveProjectId = activeProjectId;
  autoRefreshInterval = setInterval(function() {
    // Only refresh if still on the same project
    if (lastActiveProjectId === activeProjectId) {
      vscode.postMessage({ type: 'refreshProjects' });
    }
  }, 30000); // 30 seconds
}

// Listen for state updates to track active project
window.addEventListener('message', function(e) {
  var msg = e.data;
  if (msg && msg.type === 'state') {
    setupAutoRefresh(msg.activeProjectId);
  }
});

function esc(s) {
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function renderProjects() {
  var filtered = allProjects;
  
  projectList.innerHTML = '';
  
  if (filtered.length === 0) {
    emptyState.classList.remove('hidden');
  } else {
    emptyState.classList.add('hidden');
    filtered.forEach(function(pr) {
      var isActive = activeRepo && pr.path === activeRepo;
      var boundAccount = allAccounts.find(function(a) { return a.id === pr.accountId; });
      var gs = gitStatuses[pr.id] || {};
      var li = document.createElement('li');
      li.className = 'project-item' + (isActive ? ' active' : '');

      // Build new layout: branch badge next to name, sync button top right, local/push and remote/pull inline below
      var branchHtml = '';
      if (gs.isGitRepo && gs.branch) {
        branchHtml = '<span class="git-badge branch" style="margin-left:6px;vertical-align:middle;">⎇ ' + esc(gs.branch) + '</span>';
      }

      // Inline badges and buttons row
      var inlineRow = '';
      if (gs.isGitRepo) {
        inlineRow = '<div class="git-inline-row">';
        // Local changes + push
        if (gs.localChanges > 0) {
          inlineRow += '<span class="git-badge local">● ' + gs.localChanges + ' local</span>';
          inlineRow += '<button class="btn-git push" data-git="push" data-id="' + esc(pr.id) + '" title="Commit all changes and push" style="margin-right:8px;">↑ Push</button>';
        } else if (gs.ahead > 0) {
          inlineRow += '<span class="git-badge ahead">↑ ' + gs.ahead + ' ahead</span>';
          inlineRow += '<button class="btn-git push" data-git="push" data-id="' + esc(pr.id) + '" title="Push commits" style="margin-right:8px;">↑ Push</button>';
        }
        // Remote changes + pull
        if (gs.behind > 0) {
          inlineRow += '<span class="git-badge behind">↓ ' + gs.behind + ' behind</span>';
          inlineRow += '<button class="btn-git pull" data-git="pull" data-id="' + esc(pr.id) + '" title="Pull ' + gs.behind + ' commits from remote" style="margin-right:8px;">↓ Pull</button>';
        }
        // Synced
        if (gs.localChanges === 0 && gs.ahead === 0 && gs.behind === 0) {
          inlineRow += '<span class="git-badge synced">✓ synced</span>';
        }
        inlineRow += '</div>';
      }

      // Sync button top right, next to open/delete
      var syncBtn = '';
      if (gs.isGitRepo) {
        syncBtn = '<button class="btn-git sync" data-git="sync" data-id="' + esc(pr.id) + '" title="Pull remote changes then push local changes" style="margin-left:8px;">⟳ Sync</button>';
      }

      li.innerHTML =
        '<div class="project-info">' +
          '<div class="project-name" style="display:flex;align-items:center;gap:4px;">' + esc(pr.name) + branchHtml + '</div>' +
          '<div class="project-path">' + esc(pr.path) + '</div>' +
          (boundAccount ? '<div class="project-account">⚡ ' + esc(boundAccount.username) + ' (' + esc(boundAccount.provider) + ')</div>' : '') +
          inlineRow +
        '</div>' +
        '<div class="project-actions" style="display:flex;align-items:center;gap:4px;">' +
          '<button class="btn-action btn-sm" data-action="open" data-id="' + esc(pr.id) + '">Open</button>' +
          syncBtn +
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
  activeRepoName = msg.activeRepoName || '';
  gitStatuses = msg.gitStatuses || {};

  // Update "+ Add Current" button: show project name, hide if already exists
  var btnAddProject = document.getElementById('btn-add-project');
  if (btnAddProject) {
    if (!activeRepo) {
      btnAddProject.classList.add('hidden');
    } else {
      var alreadyExists = allProjects.some(function(p) { return p.path === activeRepo; });
      if (alreadyExists) {
        btnAddProject.classList.add('hidden');
      } else {
        btnAddProject.classList.remove('hidden');
        btnAddProject.textContent = '+ Add ' + (activeRepoName || 'Current');
      }
    }
  }

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

document.getElementById('btn-add-account').addEventListener('click', function() {
  vscode.postMessage({ type: 'addAccount' });
});

projectList.addEventListener('click', function(e) {
  var btn = e.target.closest('[data-action]');
  if (btn) {
    var action = btn.dataset.action;
    var id = btn.dataset.id;
    if (action === 'open') {
      vscode.postMessage({ type: 'open', id: id });
    } else if (action === 'delete') {
      vscode.postMessage({ type: 'delete', id: id });
    }
    return;
  }

  var gitBtn = e.target.closest('[data-git]');
  if (gitBtn) {
    var gitAction = gitBtn.dataset.git;
    var projId = gitBtn.dataset.id;
    if (gitAction === 'pull') {
      vscode.postMessage({ type: 'gitPull', id: projId });
    } else if (gitAction === 'push') {
      vscode.postMessage({ type: 'gitPush', id: projId });
    } else if (gitAction === 'sync') {
      vscode.postMessage({ type: 'gitSync', id: projId });
    }
    return;
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
