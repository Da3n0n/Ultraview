export function buildDokployHtml(isPanel: boolean): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; img-src data: http: https:;">
<title>Dokploy</title>
<style>
  *{box-sizing:border-box;margin:0;padding:0}
  html,body{width:100%;height:100%;overflow:hidden;
    background:var(--vscode-sideBar-background,var(--vscode-editor-background));
    color:var(--vscode-editor-foreground);
    font:12px/1.45 -apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif}
  #toolbar{
    position:fixed;top:0;left:0;right:0;height:40px;
    display:flex;align-items:center;gap:8px;padding:0 8px;
    background:var(--vscode-sideBar-background,var(--vscode-editor-background));
    border-bottom:1px solid var(--vscode-panel-border,rgba(128,128,128,.25));
    z-index:10}
  .tbtn{
    height:26px;padding:0 10px;border:none;border-radius:6px;cursor:pointer;
    font-size:11px;white-space:nowrap;color:var(--vscode-editor-foreground);
    background:var(--vscode-button-secondaryBackground,rgba(128,128,128,.15))}
  .tbtn:hover{background:var(--vscode-list-hoverBackground)}
  .tbtn.primary{
    background:var(--vscode-button-background,rgba(0,120,212,.9));
    color:var(--vscode-button-foreground,#fff)}
  .url-pill{
    min-width:0;flex:1 1 auto;height:26px;display:flex;align-items:center;
    padding:0 10px;border-radius:6px;
    color:var(--vscode-descriptionForeground);
    background:var(--vscode-editor-background,rgba(0,0,0,.12));
    border:1px solid var(--vscode-panel-border,rgba(128,128,128,.25));
    overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  #content{position:fixed;top:40px;left:0;right:0;bottom:0;overflow:auto}
  .empty,.shell{
    width:100%;min-height:100%;display:flex;flex-direction:column}
  .empty{
    align-items:center;justify-content:center;padding:22px;text-align:center;gap:12px}
  .empty-card{
    max-width:520px;padding:18px 16px;border-radius:12px;
    background:var(--vscode-editor-background,rgba(30,30,30,.5));
    border:1px solid var(--vscode-panel-border,rgba(128,128,128,.25));
    box-shadow:0 10px 24px rgba(0,0,0,.12)}
  .empty-card h2{font-size:16px;margin-bottom:8px}
  .empty-card p{opacity:.82;margin-bottom:10px}
  .hint{
    font-size:11px;opacity:.72;line-height:1.5;
    background:var(--vscode-textBlockQuote-background,rgba(128,128,128,.08));
    border-radius:8px;padding:10px 12px;text-align:left}
  .shell{padding:12px;gap:12px}
  .note{
    font-size:11px;line-height:1.5;color:var(--vscode-descriptionForeground);
    padding:10px 12px;border-radius:10px;
    background:var(--vscode-textBlockQuote-background,rgba(128,128,128,.08));
    border:1px solid var(--vscode-panel-border,rgba(128,128,128,.18))}
  .profiles{display:flex;flex-direction:column;gap:10px}
  .profile-card{
    display:flex;flex-direction:column;gap:10px;padding:12px;border-radius:12px;
    background:var(--vscode-editor-background,rgba(30,30,30,.45));
    border:1px solid var(--vscode-panel-border,rgba(128,128,128,.18))}
  .profile-card.active{border-color:var(--vscode-focusBorder,var(--vscode-button-background,#0078d4));box-shadow:inset 0 0 0 1px var(--vscode-focusBorder,var(--vscode-button-background,#0078d4))}
  .profile-top{display:flex;align-items:flex-start;justify-content:space-between;gap:10px}
  .profile-meta{min-width:0;display:flex;flex-direction:column;gap:3px}
  .profile-name{font-size:13px;font-weight:600;color:var(--vscode-editor-foreground)}
  .profile-url{font-size:11px;color:var(--vscode-descriptionForeground);word-break:break-all}
  .badge{
    flex-shrink:0;padding:3px 7px;border-radius:999px;font-size:10px;font-weight:600;
    background:var(--vscode-button-background,rgba(0,120,212,.9));
    color:var(--vscode-button-foreground,#fff)}
  .profile-actions{display:flex;gap:6px;flex-wrap:wrap}
  .profile-actions .tbtn{height:24px;padding:0 8px}
  .mono{font-family:var(--vscode-editor-font-family,Consolas,monospace)}
</style>
</head>
<body>
<div id="toolbar">
  <button class="tbtn primary" id="btn-editor" title="Open Dokploy in the editor browser">Open in Editor</button>
  <button class="tbtn" id="btn-add" title="Add a Dokploy profile">Add Profile</button>
  <button class="tbtn" id="btn-configure" title="Edit the active Dokploy profile">Edit Active</button>
  <div class="url-pill mono" id="url-pill">No Dokploy URL configured</div>
</div>
<div id="content"></div>

<script>
(function(){
'use strict';
const vscode = acquireVsCodeApi();
let state = { url: '', profiles: [], activeProfileId: '', mode: ${isPanel ? `'panel'` : `'sidebar'`} };

const contentEl = document.getElementById('content');
const urlPill = document.getElementById('url-pill');

document.getElementById('btn-editor').addEventListener('click', function(){
  vscode.postMessage({ type: 'openEditor' });
});

document.getElementById('btn-add').addEventListener('click', function(){
  vscode.postMessage({ type: 'addProfile' });
});

document.getElementById('btn-configure').addEventListener('click', function(){
  vscode.postMessage({ type: 'configure' });
});

window.addEventListener('message', function(event){
  const msg = event.data;
  if (msg.type !== 'state') {
    return;
  }
  state = {
    url: typeof msg.url === 'string' ? msg.url : '',
    profiles: Array.isArray(msg.profiles) ? msg.profiles : [],
    activeProfileId: typeof msg.activeProfileId === 'string' ? msg.activeProfileId : '',
    mode: msg.mode === 'panel' ? 'panel' : 'sidebar'
  };
  urlPill.textContent = state.url || 'No Dokploy URL configured';
  urlPill.title = state.url || 'No Dokploy URL configured';
  render();
});

function render() {
  if (!state.url) {
    contentEl.innerHTML = '' +
      '<div class="empty">' +
        '<div class="empty-card">' +
          '<h2>Add your first Dokploy profile</h2>' +
          '<p>Save each Dokploy server once, then open the active one in the editor browser with one click.</p>' +
          '<div class="hint">This sidebar stores multiple Dokploy servers and switches between them. Login continues in the VS Code browser for each server, which is the reliable path when Dokploy blocks iframe embedding.</div>' +
        '</div>' +
      '</div>';
    return;
  }

  const cards = state.profiles.map(function(profile) {
    const isActive = profile.id === state.activeProfileId;
    return '' +
      '<div class="profile-card' + (isActive ? ' active' : '') + '">' +
        '<div class="profile-top">' +
          '<div class="profile-meta">' +
            '<div class="profile-name">' + escHtml(profile.name) + '</div>' +
            '<div class="profile-url mono">' + escHtml(profile.url) + '</div>' +
          '</div>' +
          (isActive ? '<div class="badge">Active</div>' : '') +
        '</div>' +
        '<div class="profile-actions">' +
          (isActive ? '' : '<button class="tbtn" data-action="activate" data-id="' + escAttr(profile.id) + '">Make Active</button>') +
          '<button class="tbtn primary" data-action="open" data-id="' + escAttr(profile.id) + '">Open</button>' +
          '<button class="tbtn" data-action="edit" data-id="' + escAttr(profile.id) + '">Edit</button>' +
          '<button class="tbtn" data-action="delete" data-id="' + escAttr(profile.id) + '">Remove</button>' +
        '</div>' +
      '</div>';
  }).join('');

  contentEl.innerHTML = '' +
    '<div class="shell">' +
      '<div class="note">Use the sidebar to manage Dokploy profiles. Each server keeps its own login inside the VS Code browser, so switching between production, staging, and local Dokploy instances stays predictable.</div>' +
      '<div class="profiles">' + cards + '</div>' +
    '</div>';

  Array.from(contentEl.querySelectorAll('[data-action]')).forEach(function(button) {
    button.addEventListener('click', function() {
      const action = button.getAttribute('data-action');
      const profileId = button.getAttribute('data-id');
      if (!action || !profileId) {
        return;
      }
      if (action === 'activate') vscode.postMessage({ type: 'activateProfile', profileId: profileId });
      if (action === 'open') vscode.postMessage({ type: 'openProfile', profileId: profileId });
      if (action === 'edit') vscode.postMessage({ type: 'editProfile', profileId: profileId });
      if (action === 'delete') vscode.postMessage({ type: 'deleteProfile', profileId: profileId });
    });
  });
}

function escHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function escAttr(value) {
  return escHtml(value).replace(/'/g, '&#39;');
}

vscode.postMessage({ type: 'ready' });
})();
</script>
</body>
</html>`;
}