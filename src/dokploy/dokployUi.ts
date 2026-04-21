export function buildDokployHtml(isPanel: boolean): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; img-src data: http: https:;">
<title>Dokploy</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  html, body {
    width: 100%;
    height: 100%;
    overflow: hidden;
    background: var(--vscode-sideBar-background, var(--vscode-editor-background));
    color: var(--vscode-editor-foreground);
    font: 12px/1.45 -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
  }
  :root {
    --bg: var(--vscode-sideBar-background, var(--vscode-editor-background));
    --surface: color-mix(in srgb, var(--vscode-editor-background, #1e1e1e) 92%, transparent);
    --surface-2: color-mix(in srgb, var(--vscode-editor-background, #1e1e1e) 78%, var(--vscode-list-hoverBackground, rgba(255,255,255,.05)));
    --surface-3: var(--vscode-list-hoverBackground, rgba(255,255,255,.05));
    --border: var(--vscode-panel-border, rgba(128,128,128,.22));
    --text: var(--vscode-editor-foreground);
    --muted: var(--vscode-descriptionForeground);
    --accent: var(--vscode-button-background, #0078d4);
    --accent-text: var(--vscode-button-foreground, #fff);
    --focus: var(--vscode-focusBorder, var(--accent));
    --success: var(--vscode-testing-iconPassed, #3fb950);
    --warning: var(--vscode-testing-iconQueued, #d29922);
    --danger: var(--vscode-testing-iconFailed, #f85149);
    --info: var(--vscode-button-background, #0078d4);
  }
  body {
    display: flex;
    flex-direction: column;
  }
  #toolbar {
    flex: 0 0 auto;
    display: flex;
    align-items: center;
    justify-content: flex-end;
    gap: 8px;
    padding: 10px 12px;
    border-bottom: 1px solid var(--border);
    background: color-mix(in srgb, var(--bg) 92%, transparent);
  }
  .toolbar-actions {
    display: flex;
    gap: 8px;
    flex: 0 0 auto;
  }
  .btn {
    border: 1px solid var(--border);
    background: var(--surface-3);
    color: var(--text);
    border-radius: 8px;
    min-height: 30px;
    padding: 0 11px;
    cursor: pointer;
    font: inherit;
    font-size: 11px;
    font-weight: 600;
    transition: background .14s ease, border-color .14s ease, transform .14s ease;
  }
  .btn:hover {
    background: var(--vscode-toolbar-hoverBackground, var(--surface-3));
    border-color: var(--focus);
  }
  .btn:active {
    transform: translateY(1px);
  }
  .btn.primary {
    background: var(--accent);
    border-color: var(--accent);
    color: var(--accent-text);
  }
  .btn.primary:hover {
    filter: brightness(1.05);
  }
  .btn.ghost {
    background: transparent;
  }
  .btn.icon {
    width: 28px;
    min-width: 28px;
    padding: 0;
    font-size: 14px;
    line-height: 1;
  }
  #content {
    flex: 1 1 auto;
    overflow: auto;
  }
  .shell {
    display: flex;
    flex-direction: column;
    gap: 10px;
    padding: 12px;
    min-height: 100%;
  }
  .empty-card,
  .profile-card {
    border: 1px solid var(--border);
    border-radius: 14px;
    background: var(--surface);
    box-shadow: 0 10px 28px rgba(0,0,0,.14);
  }
  .empty {
    display: flex;
    align-items: center;
    justify-content: center;
    min-height: 100%;
    padding: 18px;
  }
  .empty-card {
    max-width: 520px;
    padding: 18px;
    display: flex;
    flex-direction: column;
    gap: 10px;
  }
  .empty-card h2 {
    font-size: 16px;
  }
  .empty-card p,
  .empty-card .hint {
    color: var(--muted);
  }
  .hint {
    padding: 10px 12px;
    border-radius: 10px;
    background: var(--surface-3);
    border: 1px solid var(--border);
    font-size: 11px;
  }
  .profiles {
    display: flex;
    flex-direction: column;
    gap: 10px;
  }
  .profile-card {
    padding: 12px 14px;
    display: flex;
    flex-direction: column;
    gap: 12px;
  }
  .profile-card.active {
    border-color: var(--focus);
    box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--focus) 65%, transparent), 0 10px 28px rgba(0,0,0,.14);
  }
  .profile-top {
    display: flex;
    align-items: flex-start;
    gap: 10px;
  }
  .expand-btn {
    width: 28px;
    min-width: 28px;
    height: 28px;
    border-radius: 8px;
    border: 1px solid var(--border);
    background: var(--surface-3);
    color: var(--text);
    cursor: pointer;
    font: inherit;
    font-size: 12px;
  }
  .expand-btn:hover {
    border-color: var(--focus);
    background: var(--vscode-toolbar-hoverBackground, var(--surface-3));
  }
  .profile-main {
    min-width: 0;
    flex: 1 1 auto;
    display: flex;
    flex-direction: column;
    gap: 8px;
  }
  .profile-header {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: 10px;
  }
  .profile-meta {
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 4px;
  }
  .profile-name-row {
    display: flex;
    align-items: center;
    gap: 8px;
    flex-wrap: wrap;
  }
  .profile-name {
    font-size: 13px;
    font-weight: 700;
    color: var(--text);
  }
  .profile-url {
    font-size: 11px;
    color: var(--muted);
    word-break: break-all;
    font-family: var(--vscode-editor-font-family, Consolas, monospace);
  }
  .badge-row {
    display: flex;
    gap: 6px;
    flex-wrap: wrap;
    justify-content: flex-end;
  }
  .badge {
    flex: 0 0 auto;
    min-height: 22px;
    display: inline-flex;
    align-items: center;
    padding: 0 8px;
    border-radius: 999px;
    font-size: 10px;
    font-weight: 700;
    border: 1px solid transparent;
  }
  .badge.active {
    background: color-mix(in srgb, var(--focus) 16%, transparent);
    color: var(--focus);
    border-color: color-mix(in srgb, var(--focus) 45%, transparent);
  }
  .badge.connected {
    background: color-mix(in srgb, var(--success) 16%, transparent);
    color: var(--success);
    border-color: color-mix(in srgb, var(--success) 45%, transparent);
  }
  .badge.disconnected {
    background: color-mix(in srgb, var(--muted) 15%, transparent);
    color: var(--muted);
    border-color: color-mix(in srgb, var(--muted) 35%, transparent);
  }
  .badge.error {
    background: color-mix(in srgb, var(--danger) 16%, transparent);
    color: var(--danger);
    border-color: color-mix(in srgb, var(--danger) 45%, transparent);
  }
  .profile-summary {
    display: flex;
    gap: 10px;
    flex-wrap: wrap;
    color: var(--muted);
    font-size: 11px;
  }
  .summary-pill {
    padding: 4px 8px;
    border-radius: 999px;
    border: 1px solid var(--border);
    background: var(--surface-3);
  }
  .profile-actions {
    display: flex;
    gap: 8px;
    flex-wrap: wrap;
  }
  .profile-actions .btn.primary {
    flex: 1 1 auto;
  }
  .profile-body {
    display: none;
    border-top: 1px solid var(--border);
    padding-top: 12px;
    gap: 10px;
    flex-direction: column;
  }
  .profile-card.expanded .profile-body {
    display: flex;
  }
  .auth-card,
  .error-card,
  .service-card {
    border: 1px solid var(--border);
    border-radius: 12px;
    background: var(--surface-2);
  }
  .auth-card,
  .error-card {
    padding: 12px;
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
  }
  .auth-copy,
  .error-copy {
    display: flex;
    flex-direction: column;
    gap: 4px;
  }
  .auth-copy strong,
  .error-copy strong {
    font-size: 12px;
  }
  .auth-copy span,
  .error-copy span {
    color: var(--muted);
    font-size: 11px;
  }
  .service-list {
    display: flex;
    flex-direction: column;
    gap: 8px;
  }
  .service-card {
    padding: 10px 12px;
    display: flex;
    flex-direction: column;
    gap: 9px;
  }
  .service-head {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: 10px;
  }
  .service-meta {
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 3px;
  }
  .service-name {
    font-size: 12px;
    font-weight: 700;
  }
  .service-sub {
    color: var(--muted);
    font-size: 11px;
  }
  .status-pill {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    min-height: 24px;
    padding: 0 9px;
    border-radius: 999px;
    border: 1px solid transparent;
    font-size: 10px;
    font-weight: 700;
    white-space: nowrap;
  }
  .status-pill.success {
    color: var(--success);
    border-color: color-mix(in srgb, var(--success) 40%, transparent);
    background: color-mix(in srgb, var(--success) 16%, transparent);
  }
  .status-pill.warning {
    color: var(--warning);
    border-color: color-mix(in srgb, var(--warning) 40%, transparent);
    background: color-mix(in srgb, var(--warning) 16%, transparent);
  }
  .status-pill.danger {
    color: var(--danger);
    border-color: color-mix(in srgb, var(--danger) 40%, transparent);
    background: color-mix(in srgb, var(--danger) 16%, transparent);
  }
  .status-pill.info {
    color: var(--info);
    border-color: color-mix(in srgb, var(--info) 40%, transparent);
    background: color-mix(in srgb, var(--info) 16%, transparent);
  }
  .status-pill.muted {
    color: var(--muted);
    border-color: color-mix(in srgb, var(--muted) 30%, transparent);
    background: color-mix(in srgb, var(--muted) 12%, transparent);
  }
  .domain-list {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
  }
  .domain-link,
  .domain-empty {
    min-height: 24px;
    display: inline-flex;
    align-items: center;
    padding: 0 8px;
    border-radius: 999px;
    border: 1px solid var(--border);
    background: color-mix(in srgb, var(--surface-3) 92%, transparent);
    font-size: 10px;
  }
  .domain-link {
    color: var(--text);
    text-decoration: none;
  }
  .domain-link:hover {
    border-color: var(--focus);
    background: var(--vscode-toolbar-hoverBackground, var(--surface-3));
  }
  .domain-empty {
    color: var(--muted);
  }
  .meta-line {
    color: var(--muted);
    font-size: 10px;
  }
  @media (max-width: 640px) {
    #toolbar,
    .profile-top,
    .profile-header,
    .auth-card,
    .error-card,
    .service-head {
      flex-direction: column;
      align-items: stretch;
    }
    .toolbar-actions,
    .profile-actions {
      width: 100%;
    }
    .toolbar-actions .btn,
    .profile-actions .btn,
    .auth-card .btn,
    .error-card .btn {
      width: 100%;
    }
    .badge-row {
      justify-content: flex-start;
    }
  }
</style>
</head>
<body>
<div id="toolbar">
  <div class="toolbar-actions">
    <button class="btn primary" id="btn-add">Add Profile</button>
  </div>
</div>
<div id="content"></div>

<script>
(function(){
'use strict';
const vscode = acquireVsCodeApi();
const viewState = vscode.getState() || {};
let expandedProfileIds = Array.isArray(viewState.expandedProfileIds) ? viewState.expandedProfileIds : [];
let state = { url: '', profiles: [], activeProfileId: '', mode: ${isPanel ? `'panel'` : `'sidebar'`} };

const contentEl = document.getElementById('content');
document.getElementById('btn-add').addEventListener('click', function(){
  vscode.postMessage({ type: 'addProfile' });
});

window.addEventListener('message', function(event){
  const msg = event.data;
  if (msg.type !== 'state') return;
  state = {
    url: typeof msg.url === 'string' ? msg.url : '',
    profiles: Array.isArray(msg.profiles) ? msg.profiles : [],
    activeProfileId: typeof msg.activeProfileId === 'string' ? msg.activeProfileId : '',
    mode: msg.mode === 'panel' ? 'panel' : 'sidebar'
  };
  render();
});

function persistExpanded() {
  vscode.setState({ expandedProfileIds: expandedProfileIds.slice() });
}

function toggleExpanded(profileId) {
  const next = new Set(expandedProfileIds);
  if (next.has(profileId)) next.delete(profileId);
  else next.add(profileId);
  expandedProfileIds = Array.from(next);
  persistExpanded();
  render();
}

function render() {
  if (!state.profiles.length) {
    contentEl.innerHTML = '' +
      '<div class="empty">' +
        '<div class="empty-card">' +
          '<h2>Add your first Dokploy profile</h2>' +
          '<p>Save each Dokploy server once, then connect its API key to load domains and deployment status right here.</p>' +
          '<div class="hint">Profiles stay lightweight, API keys stay out of plain text, and each connected profile can expand to show its deployed services.</div>' +
        '</div>' +
      '</div>';
    return;
  }

  const cards = state.profiles.map(function(profile) {
    const isActive = profile.id === state.activeProfileId;
    const isExpanded = expandedProfileIds.includes(profile.id);
    const cache = profile.cache || null;
    const hasToken = !!profile.hasToken;
    const isRefreshing = !!profile.isRefreshing;
    const services = cache && Array.isArray(cache.services) ? cache.services : [];
    const serviceCount = services.length;
    const domainCount = services.reduce(function(total, service) {
      return total + (Array.isArray(service.domains) ? service.domains.length : 0);
    }, 0);
    const lastSynced = cache && cache.lastSyncedAt ? formatTime(cache.lastSyncedAt) : '';

    const summaryBits = [];
    summaryBits.push('<span class="summary-pill">' + serviceCount + ' service' + (serviceCount === 1 ? '' : 's') + '</span>');
    summaryBits.push('<span class="summary-pill">' + domainCount + ' domain' + (domainCount === 1 ? '' : 's') + '</span>');
    if (cache && cache.version) {
      summaryBits.push('<span class="summary-pill">Dokploy ' + escHtml(cache.version) + '</span>');
    }
    if (lastSynced) {
      summaryBits.push('<span class="summary-pill">Synced ' + escHtml(lastSynced) + '</span>');
    }

    const badges = [];
    if (isActive) badges.push('<span class="badge active">Active</span>');
    if (hasToken && cache && !cache.lastError) badges.push('<span class="badge connected">API connected</span>');
    else if (hasToken) badges.push('<span class="badge disconnected">API saved</span>');
    else badges.push('<span class="badge disconnected">No API</span>');
    if (cache && cache.lastError) badges.push('<span class="badge error">Sync issue</span>');

    const body = !isExpanded ? '' : renderProfileBody(profile, cache, services, hasToken, isRefreshing);

    return '' +
      '<div class="profile-card' + (isActive ? ' active' : '') + (isExpanded ? ' expanded' : '') + '">' +
        '<div class="profile-top">' +
          '<button class="expand-btn" data-action="toggle" data-id="' + escAttr(profile.id) + '">' + (isExpanded ? '&#9662;' : '&#9656;') + '</button>' +
          '<div class="profile-main">' +
            '<div class="profile-header">' +
              '<div class="profile-meta">' +
                '<div class="profile-name-row">' +
                  '<div class="profile-name">' + escHtml(profile.name) + '</div>' +
                '</div>' +
                '<div class="profile-url">' + escHtml(profile.url) + '</div>' +
              '</div>' +
              '<div class="badge-row">' + badges.join('') + '</div>' +
            '</div>' +
            '<div class="profile-summary">' + summaryBits.join('') + '</div>' +
            '<div class="profile-actions">' +
              (isActive ? '' : '<button class="btn" data-action="activate" data-id="' + escAttr(profile.id) + '">Make Active</button>') +
              '<button class="btn" data-action="auth" data-id="' + escAttr(profile.id) + '">' + (hasToken ? 'Update API' : 'Auth API') + '</button>' +
              '<button class="btn primary" data-action="open" data-id="' + escAttr(profile.id) + '">Open</button>' +
              '<button class="btn icon" data-action="delete" data-id="' + escAttr(profile.id) + '">&times;</button>' +
            '</div>' +
            '<div class="profile-body">' + body + '</div>' +
          '</div>' +
        '</div>' +
      '</div>';
  }).join('');

  contentEl.innerHTML = '' +
    '<div class="shell">' +
      '<div class="profiles">' + cards + '</div>' +
    '</div>';

  Array.from(contentEl.querySelectorAll('[data-action]')).forEach(function(button) {
    button.addEventListener('click', function() {
      const action = button.getAttribute('data-action');
      const profileId = button.getAttribute('data-id');
      if (!action || !profileId) return;
      if (action === 'toggle') toggleExpanded(profileId);
      if (action === 'activate') vscode.postMessage({ type: 'activateProfile', profileId: profileId });
      if (action === 'open') vscode.postMessage({ type: 'openProfile', profileId: profileId });
      if (action === 'delete') vscode.postMessage({ type: 'deleteProfile', profileId: profileId });
      if (action === 'auth') vscode.postMessage({ type: 'authProfileApi', profileId: profileId });
      if (action === 'disconnect') vscode.postMessage({ type: 'disconnectProfileApi', profileId: profileId });
      if (action === 'refresh-profile') vscode.postMessage({ type: 'refreshProfileData', profileId: profileId });
      if (action === 'open-domain') {
        const url = button.getAttribute('data-url');
        if (url) window.open(url, '_blank');
      }
    });
  });
}

function renderProfileBody(profile, cache, services, hasToken, isRefreshing) {
  if (!hasToken) {
    return '' +
      '<div class="auth-card">' +
        '<div class="auth-copy">' +
          '<strong>Connect Dokploy API</strong>' +
          '<span>Add the API key from Dokploy profile settings to load services, domains, and deployment state here.</span>' +
        '</div>' +
        '<button class="btn primary" data-action="auth" data-id="' + escAttr(profile.id) + '">Connect API</button>' +
      '</div>';
  }

  if (cache && cache.lastError) {
    return '' +
      '<div class="error-card">' +
        '<div class="error-copy">' +
          '<strong>Sync failed</strong>' +
          '<span>' + escHtml(cache.lastError) + '</span>' +
        '</div>' +
        '<button class="btn" data-action="refresh-profile" data-id="' + escAttr(profile.id) + '">Retry</button>' +
      '</div>' +
      '<div class="profile-actions">' +
        '<button class="btn" data-action="disconnect" data-id="' + escAttr(profile.id) + '">Remove API</button>' +
      '</div>';
  }

  const topMeta = '' +
    '<div class="profile-actions">' +
      '<button class="btn" data-action="refresh-profile" data-id="' + escAttr(profile.id) + '">' + (isRefreshing ? 'Refreshing...' : 'Refresh Data') + '</button>' +
      '<button class="btn ghost" data-action="disconnect" data-id="' + escAttr(profile.id) + '">Remove API</button>' +
    '</div>';

  if (!services.length) {
    return topMeta +
      '<div class="auth-card">' +
        '<div class="auth-copy">' +
          '<strong>No services found yet</strong>' +
          '<span>This profile is connected, but Dokploy did not return any applications or compose services to show.</span>' +
        '</div>' +
      '</div>';
  }

  const serviceCards = services.map(function(service) {
    const domains = Array.isArray(service.domains) ? service.domains : [];
    const domainHtml = domains.length
      ? domains.map(function(domain) {
          const href = buildDomainHref(domain);
          return '<a class="domain-link" data-action="open-domain" data-id="' + escAttr(profile.id) + '" data-url="' + escAttr(href) + '" href="' + escAttr(href) + '">' + escHtml(domain) + '</a>';
        }).join('')
      : '<span class="domain-empty">No domains linked</span>';

    return '' +
      '<div class="service-card">' +
        '<div class="service-head">' +
          '<div class="service-meta">' +
            '<div class="service-name">' + escHtml(service.name) + '</div>' +
            '<div class="service-sub">' + escHtml(service.projectName) + ' · ' + escHtml(service.type) + '</div>' +
          '</div>' +
          '<span class="status-pill ' + escAttr(service.statusTone || 'muted') + '">' + escHtml(service.status || 'Unknown') + '</span>' +
        '</div>' +
        '<div class="domain-list">' + domainHtml + '</div>' +
        (service.updatedAt ? '<div class="meta-line">Updated ' + escHtml(formatTime(service.updatedAt)) + '</div>' : '') +
      '</div>';
  }).join('');

  return topMeta + '<div class="service-list">' + serviceCards + '</div>';
}

function buildDomainHref(domain) {
  if (/^https?:\\/\\//i.test(domain)) return domain;
  return 'https://' + domain.replace(/^\\/+/, '');
}

function formatTime(value) {
  try {
    const date = new Date(Number(value));
    if (Number.isNaN(date.getTime())) return '';
    return date.toLocaleString();
  } catch {
    return '';
  }
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
