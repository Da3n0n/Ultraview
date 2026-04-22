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
    --surface-card: linear-gradient(180deg, rgba(255,255,255,.03), rgba(255,255,255,.015));
    --surface-card-hover: linear-gradient(180deg, rgba(255,255,255,.045), rgba(255,255,255,.02));
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
    background: var(--surface-card);
    box-shadow: inset 0 1px 0 rgba(255,255,255,.03), 0 10px 28px rgba(0,0,0,.14);
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
    position: relative;
    padding: 12px 14px;
    display: flex;
    flex-direction: column;
    gap: 10px;
    transition: transform .16s ease, border-color .16s ease, background .16s ease;
  }
  .profile-card:hover {
    transform: translateY(-1px);
    border-color: color-mix(in srgb, var(--border) 50%, var(--focus));
    background: var(--surface-card-hover);
  }
  .profile-card.active {
    border-color: color-mix(in srgb, var(--focus) 58%, var(--border));
    box-shadow: 0 0 0 1px color-mix(in srgb, var(--focus) 18%, transparent), inset 0 1px 0 rgba(255,255,255,.03), 0 10px 28px rgba(0,0,0,.14);
  }
  .profile-top {
    display: block;
  }
  .expand-btn {
    grid-area: toggle;
    justify-self: end;
    align-self: start;
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
    width: 100%;
    flex: 1 1 auto;
    display: flex;
    flex-direction: column;
    gap: 8px;
  }
  .profile-compact {
    display: grid;
    grid-template-columns: minmax(0, 1fr) auto auto;
    grid-template-areas:
      "meta metrics toggle"
      "summary summary summary"
      "actions actions actions";
    gap: 10px;
    align-items: start;
  }
  .profile-meta {
    grid-area: meta;
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
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    font-family: var(--vscode-editor-font-family, Consolas, monospace);
  }
  .profile-summary {
    display: flex;
    gap: 8px;
    flex-wrap: wrap;
    align-items: center;
    justify-content: flex-start;
  }
  .profile-summary.compact {
    grid-area: summary;
  }
  .profile-metrics {
    grid-area: metrics;
    display: flex;
    gap: 8px;
    flex-wrap: wrap;
    align-items: center;
    justify-content: flex-end;
    min-width: 0;
  }
  .metric-pill {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    min-height: 24px;
    padding: 0 9px;
    border-radius: 999px;
    border: 1px solid color-mix(in srgb, var(--border) 80%, transparent);
    background: color-mix(in srgb, var(--surface-3) 92%, transparent);
    color: var(--text);
    font-size: 10px;
    font-weight: 700;
    white-space: nowrap;
  }
  .metric-pill .metric-label {
    color: var(--muted);
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: .03em;
  }
  .summary-pill {
    display: inline-flex;
    align-items: center;
    min-height: 22px;
    padding: 0 8px;
    border-radius: 999px;
    border: 1px solid var(--border);
    background: var(--surface-3);
    color: var(--muted);
    font-size: 10px;
    font-weight: 700;
    white-space: nowrap;
  }
  button.summary-pill {
    cursor: pointer;
    font: inherit;
  }
  button.summary-pill:hover {
    border-color: var(--focus);
    filter: brightness(1.04);
  }
  .summary-pill.active {
    color: var(--focus);
    border-color: color-mix(in srgb, var(--focus) 45%, transparent);
    background: color-mix(in srgb, var(--focus) 16%, transparent);
  }
  .summary-pill.connected {
    color: var(--success);
    border-color: color-mix(in srgb, var(--success) 45%, transparent);
    background: color-mix(in srgb, var(--success) 16%, transparent);
  }
  .summary-pill.disconnected {
    color: var(--muted);
    border-color: color-mix(in srgb, var(--muted) 35%, transparent);
    background: color-mix(in srgb, var(--muted) 12%, transparent);
  }
  .summary-pill.error {
    color: var(--danger);
    border-color: color-mix(in srgb, var(--danger) 45%, transparent);
    background: color-mix(in srgb, var(--danger) 16%, transparent);
  }
  .profile-actions {
    display: flex;
    gap: 8px;
    flex-wrap: wrap;
    align-items: center;
  }
  .profile-actions.compact {
    grid-area: actions;
    display: grid;
    grid-template-columns: repeat(3, minmax(0, 1fr));
    gap: 8px;
    width: 100%;
  }
  .profile-actions.compact .btn {
    width: 100%;
    min-height: 34px;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    padding: 0;
  }
  .profile-actions.compact .btn.icon {
    min-width: 0;
    font-size: 16px;
  }
  .profile-actions.expanded {
    padding-top: 2px;
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
  .project-group {
    display: flex;
    flex-direction: column;
    gap: 8px;
    padding: 10px 12px 12px;
    border: 1px solid var(--border);
    border-radius: 12px;
    background: var(--surface-2);
  }
  .project-group-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
    width: 100%;
    min-width: 0;
  }
  .project-group-name {
    font-size: 11px;
    font-weight: 800;
    letter-spacing: .04em;
    text-transform: uppercase;
    color: var(--muted);
  }
  .project-group-title {
    display: inline-flex;
    align-items: center;
    gap: 8px;
    min-width: 0;
    flex: 1 1 auto;
  }
  .project-group-actions {
    display: inline-flex;
    align-items: center;
    gap: 8px;
    flex: 0 0 auto;
  }
  .project-toggle {
    width: 22px;
    min-width: 22px;
    height: 22px;
    border-radius: 7px;
    border: 1px solid var(--border);
    background: var(--surface-3);
    color: var(--muted);
    font-size: 10px;
    text-align: center;
    cursor: pointer;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    line-height: 1;
  }
  .project-toggle:hover {
    border-color: var(--focus);
    background: var(--vscode-toolbar-hoverBackground, var(--surface-3));
  }
  .project-group.collapsed .service-list {
    display: none;
  }
  .service-card {
    padding: 10px 12px;
    display: flex;
    flex-direction: column;
    gap: 9px;
  }
  .service-actions {
    display: flex;
    gap: 8px;
    flex-wrap: wrap;
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
    .profile-compact,
    .auth-card,
    .error-card,
    .service-head {
      flex-direction: column;
      align-items: stretch;
    }
    .toolbar-actions,
    .profile-actions,
    .profile-summary.compact {
      width: 100%;
    }
    .toolbar-actions .btn,
    .profile-actions .btn,
    .auth-card .btn,
    .error-card .btn {
      width: 100%;
    }
    .profile-summary {
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
let expandedProjectIds = viewState && typeof viewState.expandedProjectIds === 'object' && viewState.expandedProjectIds
  ? viewState.expandedProjectIds
  : {};
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
  vscode.setState({
    expandedProfileIds: expandedProfileIds.slice(),
    expandedProjectIds: expandedProjectIds
  });
}

function toggleExpanded(profileId) {
  const next = new Set(expandedProfileIds);
  if (next.has(profileId)) next.delete(profileId);
  else next.add(profileId);
  expandedProfileIds = Array.from(next);
  persistExpanded();
  render();
}

function toggleProjectExpanded(projectKey) {
  expandedProjectIds = Object.assign({}, expandedProjectIds, {
    [projectKey]: !expandedProjectIds[projectKey]
  });
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
    const serverMetrics = cache && Array.isArray(cache.serverMetrics) ? cache.serverMetrics : [];
    const primaryServerMetric = serverMetrics.length ? serverMetrics[0] : null;
    const projectCount = cache && typeof cache.projectCount === 'number'
      ? cache.projectCount
      : Array.from(new Set(services.map(function(service) { return service.projectName; }).filter(Boolean))).length;
    const serviceCount = services.length;
    const domainCount = services.reduce(function(total, service) {
      return total + (Array.isArray(service.domains) ? service.domains.length : 0);
    }, 0);
    const lastSynced = cache && cache.lastSyncedAt ? formatTime(cache.lastSyncedAt) : '';
    const topMetricBits = [];

    const summaryBits = [];
    summaryBits.push('<span class="summary-pill">' + projectCount + ' project' + (projectCount === 1 ? '' : 's') + '</span>');
    summaryBits.push('<span class="summary-pill">' + serviceCount + ' service' + (serviceCount === 1 ? '' : 's') + '</span>');
    summaryBits.push('<span class="summary-pill">' + domainCount + ' domain' + (domainCount === 1 ? '' : 's') + '</span>');
    if (cache && cache.version) {
      summaryBits.push('<span class="summary-pill">Dokploy ' + escHtml(cache.version) + '</span>');
    }
    if (primaryServerMetric && primaryServerMetric.serverName) {
      summaryBits.push('<span class="summary-pill">' + escHtml(primaryServerMetric.serverName) + '</span>');
    }
    if (primaryServerMetric && typeof primaryServerMetric.cpuPercent === 'number') {
      topMetricBits.push(renderMetricPill('CPU', formatPercent(primaryServerMetric.cpuPercent)));
    }
    if (primaryServerMetric && (typeof primaryServerMetric.memoryPercent === 'number' || typeof primaryServerMetric.memoryUsedBytes === 'number')) {
      topMetricBits.push(renderMetricPill('RAM', formatMemory(primaryServerMetric)));
    }
    if (primaryServerMetric && (typeof primaryServerMetric.diskPercent === 'number' || typeof primaryServerMetric.diskReadBytes === 'number' || typeof primaryServerMetric.diskWriteBytes === 'number')) {
      topMetricBits.push(renderMetricPill('IO', formatIo(primaryServerMetric)));
    }
    if (primaryServerMetric && (typeof primaryServerMetric.networkRxBytes === 'number' || typeof primaryServerMetric.networkTxBytes === 'number')) {
      topMetricBits.push(renderMetricPill('NET', formatNet(primaryServerMetric)));
    }
    if (lastSynced) {
      summaryBits.push('<span class="summary-pill">Synced ' + escHtml(lastSynced) + '</span>');
    }

    if (isActive) summaryBits.push('<span class="summary-pill active">Active</span>');
    if (cache && cache.lastError) summaryBits.push('<span class="summary-pill error">Sync issue</span>');
    else if (hasToken && cache) summaryBits.push('<button class="summary-pill connected" data-action="disconnect" data-id="' + escAttr(profile.id) + '" aria-label="Remove API key">API &times;</button>');
    else if (hasToken) summaryBits.push('<button class="summary-pill disconnected" data-action="disconnect" data-id="' + escAttr(profile.id) + '" aria-label="Remove API key">Saved &times;</button>');
    else summaryBits.push('<button class="summary-pill disconnected" data-action="auth" data-id="' + escAttr(profile.id) + '" aria-label="Add API key">No API +</button>');

    const body = !isExpanded ? '' : renderProfileBody(profile, cache, services, hasToken, isRefreshing, isActive);

    return '' +
      '<div class="profile-card' + (isActive ? ' active' : '') + (isExpanded ? ' expanded' : '') + '">' +
        '<div class="profile-top">' +
          '<div class="profile-main">' +
            '<div class="profile-compact">' +
              '<div class="profile-meta">' +
                '<div class="profile-name-row">' +
                  '<div class="profile-name">' + escHtml(profile.name) + '</div>' +
                '</div>' +
                '<div class="profile-url">' + escHtml(profile.url) + '</div>' +
              '</div>' +
              '<div class="profile-metrics">' + topMetricBits.join('') + '</div>' +
              '<button class="expand-btn" data-action="toggle" data-id="' + escAttr(profile.id) + '" aria-label="Toggle profile">' + (isExpanded ? '&#9662;' : '&#9656;') + '</button>' +
              '<div class="profile-summary compact">' + summaryBits.join('') + '</div>' +
              '<div class="profile-actions compact">' +
                '<button class="btn icon" data-action="open" data-id="' + escAttr(profile.id) + '" aria-label="Open profile">&#8599;</button>' +
                '<button class="btn icon" data-action="refresh-profile" data-id="' + escAttr(profile.id) + '" aria-label="Scan Dokploy">' + (isRefreshing ? '…' : '&#10227;') + '</button>' +
                '<button class="btn icon" data-action="delete" data-id="' + escAttr(profile.id) + '" aria-label="Delete profile">&times;</button>' +
              '</div>' +
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
      if (!action) return;
      if (action === 'toggle') toggleExpanded(profileId);
      if (action === 'toggle-project') {
        const projectKey = button.getAttribute('data-project-key');
        if (projectKey) toggleProjectExpanded(projectKey);
        return;
      }
      if (!profileId) return;
      if (action === 'activate') vscode.postMessage({ type: 'activateProfile', profileId: profileId });
      if (action === 'open') vscode.postMessage({ type: 'openProfile', profileId: profileId });
      if (action === 'delete') vscode.postMessage({ type: 'deleteProfile', profileId: profileId });
      if (action === 'auth') vscode.postMessage({ type: 'authProfileApi', profileId: profileId });
      if (action === 'disconnect') vscode.postMessage({ type: 'disconnectProfileApi', profileId: profileId });
      if (action === 'refresh-profile') vscode.postMessage({ type: 'refreshProfileData', profileId: profileId });
      if (action === 'open-service-db') {
        const serviceId = button.getAttribute('data-service-id');
        if (serviceId) {
          vscode.postMessage({ type: 'openServiceDatabase', profileId: profileId, serviceId: serviceId });
        }
      }
      if (action === 'open-domain') {
        const url = button.getAttribute('data-url');
        if (url) window.open(url, '_blank');
      }
    });
  });
}

function renderProfileBody(profile, cache, services, hasToken, isRefreshing, isActive) {
  if (!hasToken) {
    return (isActive ? '' : '<div class="profile-actions expanded"><button class="btn" data-action="activate" data-id="' + escAttr(profile.id) + '">Make Active</button></div>') +
      '<div class="auth-card">' +
        '<div class="auth-copy">' +
          '<strong>Connect Dokploy API</strong>' +
          '<span>Add the API key from Dokploy profile settings to load projects, services, and domains here.</span>' +
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
        '<button class="btn" data-action="auth" data-id="' + escAttr(profile.id) + '">Reconnect API</button>' +
      '</div>';
  }

  if (!services.length) {
    return isRefreshing ? '<div class="hint">Refreshing Dokploy data...</div>' : '';
  }

  const projectCards = groupServicesByProject(services).map(function(project) {
    const projectKey = profile.id + '::' + project.name;
    const isProjectExpanded = !!expandedProjectIds[projectKey];
    const serviceCards = project.services.map(function(service) {
      const domains = Array.isArray(service.domains) ? service.domains : [];
      const canOpenDb = service &&
        service.type === 'database' &&
        typeof service.serviceKind === 'string' &&
        service.serviceKind.toLowerCase().includes('postgres');
      const domainHtml = domains.length
        ? domains.map(function(domain) {
            const href = buildDomainHref(domain);
            return '<a class="domain-link" data-action="open-domain" data-id="' + escAttr(profile.id) + '" data-url="' + escAttr(href) + '" href="' + escAttr(href) + '">' + escHtml(domain) + '</a>';
          }).join('')
        : '<span class="domain-empty">No domains linked</span>';
      const actionHtml = canOpenDb
        ? '<div class="service-actions"><button class="btn" data-action="open-service-db" data-id="' + escAttr(profile.id) + '" data-service-id="' + escAttr(service.id) + '">Open DB</button></div>'
        : '';

      return '' +
        '<div class="service-card">' +
          '<div class="service-head">' +
            '<div class="service-meta">' +
              '<div class="service-name">' + escHtml(service.name) + '</div>' +
              '<div class="service-sub">' + escHtml(service.type === 'database' ? (service.serviceKind || 'database') : service.type) + '</div>' +
            '</div>' +
            '<span class="status-pill ' + escAttr(service.statusTone || 'muted') + '">' + escHtml(service.status || 'Unknown') + '</span>' +
          '</div>' +
          '<div class="domain-list">' + domainHtml + '</div>' +
          actionHtml +
          (service.updatedAt ? '<div class="meta-line">Updated ' + escHtml(formatTime(service.updatedAt)) + '</div>' : '') +
        '</div>';
    }).join('');

    return '' +
      '<div class="project-group' + (isProjectExpanded ? '' : ' collapsed') + '">' +
        '<div class="project-group-header">' +
          '<div class="project-group-title">' +
            '<div class="project-group-name">' + escHtml(project.name) + '</div>' +
          '</div>' +
          '<div class="project-group-actions">' +
            '<span class="summary-pill">' + project.services.length + ' service' + (project.services.length === 1 ? '' : 's') + '</span>' +
            '<button class="project-toggle" data-action="toggle-project" data-project-key="' + escAttr(projectKey) + '" data-id="' + escAttr(profile.id) + '" aria-label="Toggle project">' + (isProjectExpanded ? '&#9662;' : '&#9656;') + '</button>' +
          '</div>' +
        '</div>' +
        '<div class="service-list">' + serviceCards + '</div>' +
      '</div>';
  }).join('');

  return '<div class="service-list">' + projectCards + '</div>';
}

function groupServicesByProject(services) {
  const map = new Map();
  services.forEach(function(service) {
    const projectName = service && service.projectName ? service.projectName : 'Project';
    if (!map.has(projectName)) map.set(projectName, []);
    map.get(projectName).push(service);
  });

  return Array.from(map.entries()).sort(function(left, right) {
    return left[0].localeCompare(right[0]);
  }).map(function(entry) {
    return {
      name: entry[0],
      services: entry[1].slice().sort(function(left, right) {
        return left.name.localeCompare(right.name) || left.type.localeCompare(right.type);
      })
    };
  });
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

function formatPercent(value) {
  const rounded = Math.round(Number(value) * 10) / 10;
  return rounded.toFixed(rounded % 1 === 0 ? 0 : 1) + '%';
}

function formatBytes(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let size = numeric;
  let unitIndex = 0;
  while (size >= 1024 && unitIndex < units.length - 1) {
    size /= 1024;
    unitIndex += 1;
  }
  const rounded = size >= 10 || unitIndex === 0 ? Math.round(size) : Math.round(size * 10) / 10;
  return String(rounded) + ' ' + units[unitIndex];
}

function formatMemory(metric) {
  if (typeof metric.memoryPercent === 'number') return formatPercent(metric.memoryPercent);
  if (typeof metric.memoryUsedBytes === 'number' && typeof metric.memoryTotalBytes === 'number' && metric.memoryTotalBytes > 0) {
    return formatBytes(metric.memoryUsedBytes) + '/' + formatBytes(metric.memoryTotalBytes);
  }
  if (typeof metric.memoryUsedBytes === 'number') return formatBytes(metric.memoryUsedBytes);
  return 'n/a';
}

function formatIo(metric) {
  if (typeof metric.diskPercent === 'number') return formatPercent(metric.diskPercent);
  const read = typeof metric.diskReadBytes === 'number' ? formatBytes(metric.diskReadBytes) : null;
  const write = typeof metric.diskWriteBytes === 'number' ? formatBytes(metric.diskWriteBytes) : null;
  if (read && write) return read + '/' + write;
  if (read) return read;
  if (write) return write;
  return 'n/a';
}

function formatNet(metric) {
  const rx = typeof metric.networkRxBytes === 'number' ? formatBytes(metric.networkRxBytes) : null;
  const tx = typeof metric.networkTxBytes === 'number' ? formatBytes(metric.networkTxBytes) : null;
  if (rx && tx) return rx + '/' + tx;
  if (rx) return rx;
  if (tx) return tx;
  return 'n/a';
}

function renderMetricPill(label, value) {
  return '' +
    '<span class="metric-pill">' +
      '<span class="metric-label">' + escHtml(label) + '</span>' +
      '<span>' + escHtml(value) + '</span>' +
    '</span>';
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
