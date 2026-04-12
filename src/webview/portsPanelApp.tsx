import React, { useEffect, useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';
import type { PortProcess } from '../ports/portManager';
import type { PortsPanelInboundMessage, PortsPanelOutboundMessage } from './portsPanelTypes';

function getVscode() {
  return window.__vscodeApi as { postMessage: (message: PortsPanelOutboundMessage) => void } | undefined;
}

function normalize(value: string | number | undefined): string {
  return String(value ?? '').toLowerCase();
}

function App() {
  const [ports, setPorts] = useState<PortProcess[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [devOnly, setDevOnly] = useState(true);
  const [search, setSearch] = useState('');
  const [killing, setKilling] = useState<Record<number, boolean>>({});
  const [killingAll, setKillingAll] = useState(false);

  useEffect(() => {
    getVscode()?.postMessage({ type: 'ready', devOnly: true });

    const handleMessage = (event: MessageEvent<PortsPanelInboundMessage>) => {
      const message = event.data;
      if (!message || message.type !== 'state') return;
      setLoaded(true);
      setPorts(message.ports ?? []);
      setDevOnly(Boolean(message.devOnly));
      setKilling({});
      setKillingAll(false);
    };

    window.addEventListener('message', handleMessage as EventListener);
    return () => window.removeEventListener('message', handleMessage as EventListener);
  }, []);

  const visiblePorts = useMemo(() => {
    const query = search.trim().toLowerCase();
    const list = devOnly ? ports.filter((port) => port.isDev) : ports;

    if (!query) {
      return list;
    }

    return list.filter((port) =>
      normalize(port.port).includes(query)
      || normalize(port.pid).includes(query)
      || normalize(port.name).includes(query)
      || (port.isDev && 'dev'.includes(query))
    );
  }, [ports, search, devOnly]);

  const devPorts = useMemo(() => ports.filter((port) => port.isDev), [ports]);
  const processSummary = useMemo(() => new Set(visiblePorts.map((port) => port.pid)).size, [visiblePorts]);

  const refresh = (nextDevOnly = devOnly) => {
    getVscode()?.postMessage({ type: 'refresh', devOnly: nextDevOnly });
  };

  const toggleDevOnly = () => {
    const nextValue = !devOnly;
    setDevOnly(nextValue);
    refresh(nextValue);
  };

  const killOne = (pid: number) => {
    setKilling((current) => ({ ...current, [pid]: true }));
    getVscode()?.postMessage({ type: 'kill', pid });
  };

  const killAllDev = () => {
    if (devPorts.length === 0) return;
    setKillingAll(true);
    getVscode()?.postMessage({ type: 'killAll', ports: devPorts.map((port) => port.pid) });
  };

  const renderPortCard = (port: PortProcess) => (
    <div key={`${port.port}-${port.pid}`} className={`port-card${port.isDev ? ' dev' : ''}`}>
      <div className={`port-badge${port.isDev ? ' dev' : ''}`}>:{port.port}</div>
      <div className="port-info">
        <div className="port-name-row">
          <div className="port-name" title={port.name}>{port.name}</div>
          {port.isDev && <span className="port-chip">Dev</span>}
        </div>
        <div className="port-meta">PID {port.pid}</div>
      </div>
      <button className="danger-button" onClick={() => killOne(port.pid)} disabled={Boolean(killing[port.pid])}>
        {killing[port.pid] ? 'Killing...' : 'Kill'}
      </button>
    </div>
  );

  return (
    <div className="ports-app">
      <style>{`
        :root {
          --bg: var(--vscode-sideBar-background, var(--vscode-editor-background));
          --surface: var(--vscode-editor-background, rgba(30,30,30,.55));
          --surface2: var(--vscode-list-hoverBackground, rgba(255,255,255,.05));
          --border: var(--vscode-panel-border, rgba(128,128,128,.24));
          --text: var(--vscode-editor-foreground);
          --muted: var(--vscode-descriptionForeground);
          --accent: var(--vscode-textLink-foreground, #7dd3fc);
          --danger: #f87171;
          --danger-bg: rgba(248,113,113,.14);
          --danger-border: rgba(248,113,113,.26);
          --dev-bg: rgba(74,222,128,.14);
          --dev-border: rgba(74,222,128,.26);
          --dev-text: #4ade80;
        }
        .ports-app {
          display: flex;
          flex-direction: column;
          height: 100vh;
          background:
            radial-gradient(circle at top right, rgba(74,222,128,.08), transparent 28%),
            linear-gradient(180deg, color-mix(in srgb, var(--bg) 94%, black), var(--bg));
          color: var(--text);
        }
        .toolbar {
          display: flex;
          gap: 8px;
          padding: 10px;
          border-bottom: 1px solid var(--border);
          background: rgba(0,0,0,.08);
          backdrop-filter: blur(8px);
        }
        .toolbar-button, .search {
          border: 1px solid var(--border);
          border-radius: 10px;
          background: var(--surface2);
          color: var(--text);
          font: inherit;
        }
        .toolbar-button {
          padding: 6px 10px;
          cursor: pointer;
          transition: transform .14s ease, border-color .14s ease, background .14s ease;
        }
        .toolbar-button:hover {
          transform: translateY(-1px);
          border-color: color-mix(in srgb, var(--border) 55%, var(--accent));
          background: color-mix(in srgb, var(--surface2) 72%, white 5%);
        }
        .toolbar-button.active {
          background: rgba(74,222,128,.16);
          border-color: rgba(74,222,128,.34);
          color: var(--dev-text);
        }
        .search {
          flex: 1;
          min-width: 0;
          padding: 6px 10px;
          background: var(--vscode-input-background, var(--surface));
        }
        .content {
          flex: 1;
          min-height: 0;
          overflow: auto;
          padding: 10px;
          display: grid;
          gap: 10px;
        }
        .hero {
          display: grid;
          grid-template-columns: repeat(3, minmax(0, 1fr));
          gap: 8px;
        }
        .stat-card {
          border: 1px solid var(--border);
          border-radius: 12px;
          background: linear-gradient(180deg, rgba(255,255,255,.03), rgba(255,255,255,.015));
          padding: 10px 12px;
          display: grid;
          gap: 2px;
          min-height: 78px;
        }
        .stat-label {
          font-size: 10px;
          text-transform: uppercase;
          letter-spacing: .08em;
          color: var(--muted);
          font-weight: 700;
        }
        .stat-value {
          font-size: 20px;
          font-weight: 800;
          color: var(--accent);
        }
        .list-card {
          border: 1px solid var(--border);
          border-radius: 14px;
          background: linear-gradient(180deg, rgba(255,255,255,.03), rgba(255,255,255,.015));
          padding: 10px;
          display: grid;
          gap: 8px;
        }
        .section-header {
          display: flex;
          justify-content: space-between;
          gap: 10px;
          align-items: center;
        }
        .section-title {
          font-size: 11px;
          letter-spacing: .08em;
          text-transform: uppercase;
          color: var(--muted);
          font-weight: 700;
        }
        .section-action {
          border: 1px solid var(--danger-border);
          border-radius: 999px;
          padding: 5px 10px;
          background: var(--danger-bg);
          color: var(--danger);
          font: inherit;
          font-size: 10px;
          font-weight: 700;
          cursor: pointer;
        }
        .section-action:disabled {
          opacity: .45;
          cursor: default;
        }
        .port-list {
          display: grid;
          gap: 6px;
        }
        .port-card {
          display: grid;
          grid-template-columns: auto minmax(0, 1fr) auto;
          gap: 8px;
          align-items: center;
          border: 1px solid var(--border);
          border-radius: 10px;
          padding: 7px 9px;
          background: rgba(255,255,255,.02);
          transition: transform .14s ease, border-color .14s ease, background .14s ease;
        }
        .port-card:hover {
          transform: translateY(-1px);
          border-color: color-mix(in srgb, var(--border) 52%, var(--accent));
          background: rgba(125,211,252,.06);
        }
        .port-card.dev {
          border-color: rgba(74,222,128,.2);
          background: linear-gradient(180deg, rgba(74,222,128,.08), rgba(74,222,128,.03));
        }
        .port-badge {
          min-width: 54px;
          text-align: center;
          border-radius: 999px;
          padding: 4px 7px;
          font: 700 10px/1 Consolas, 'Courier New', monospace;
          background: rgba(125,211,252,.14);
          color: var(--accent);
          border: 1px solid rgba(125,211,252,.28);
        }
        .port-badge.dev {
          background: var(--dev-bg);
          color: var(--dev-text);
          border-color: var(--dev-border);
        }
        .port-info {
          min-width: 0;
          display: grid;
          gap: 3px;
        }
        .port-name-row {
          display: flex;
          gap: 8px;
          align-items: center;
          min-width: 0;
        }
        .port-name {
          font-size: 11px;
          font-weight: 700;
          min-width: 0;
          white-space: nowrap;
          overflow: hidden;
          text-overflow: ellipsis;
        }
        .port-chip {
          flex-shrink: 0;
          border-radius: 999px;
          padding: 2px 7px;
          font-size: 10px;
          font-weight: 700;
          background: var(--dev-bg);
          color: var(--dev-text);
          border: 1px solid var(--dev-border);
        }
        .port-meta {
          font-size: 9px;
          color: var(--muted);
        }
        .danger-button {
          border: 1px solid var(--danger-border);
          border-radius: 8px;
          padding: 5px 8px;
          background: var(--danger-bg);
          color: var(--danger);
          font: inherit;
          font-size: 10px;
          font-weight: 700;
          cursor: pointer;
        }
        .danger-button:disabled {
          opacity: .45;
          cursor: default;
        }
        .empty {
          padding: 16px 10px;
          color: var(--muted);
          text-align: center;
          border: 1px dashed var(--border);
          border-radius: 14px;
        }
        .statusbar {
          display: flex;
          gap: 12px;
          padding: 7px 12px;
          font-size: 10px;
          color: var(--muted);
          border-top: 1px solid var(--border);
          background: rgba(0,0,0,.08);
        }
        @media (max-width: 720px) {
          .hero {
            grid-template-columns: 1fr;
          }
        }
      `}</style>

      <div className="toolbar">
        <button className="toolbar-button" onClick={() => refresh()}>Refresh</button>
        <button className={`toolbar-button${devOnly ? ' active' : ''}`} onClick={toggleDevOnly}>{devOnly ? 'Dev Focus' : 'Show All'}</button>
        <input className="search" value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Filter ports, PIDs, or process names..." />
        <button className="toolbar-button" onClick={() => getVscode()?.postMessage({ type: 'openPanel' })}>Open</button>
      </div>

      <div className="content">
        <div className="hero">
          <div className="stat-card">
            <div className="stat-label">Visible Ports</div>
            <div className="stat-value">{visiblePorts.length}</div>
          </div>
          <div className="stat-card">
            <div className="stat-label">Visible Processes</div>
            <div className="stat-value">{processSummary}</div>
          </div>
          <div className="stat-card">
            <div className="stat-label">Dev Ports</div>
            <div className="stat-value">{devPorts.length}</div>
          </div>
        </div>

        <section className="list-card">
          <div className="section-header">
            <div className="section-title">{devOnly ? 'Relevant Dev Ports' : 'Ports And Processes'}</div>
            <button className="section-action" onClick={killAllDev} disabled={killingAll || devPorts.length === 0}>
              {killingAll ? 'Killing Dev...' : `Kill All Dev (${devPorts.length})`}
            </button>
          </div>

          {!loaded && <div className="empty">Scanning ports...</div>}
          {loaded && visiblePorts.length === 0 && (
            <div className="empty">
              {ports.length === 0 ? 'No relevant listening ports found.' : 'No ports match the current filter.'}
            </div>
          )}
          {visiblePorts.length > 0 && (
            <div className="port-list">
              {visiblePorts.map(renderPortCard)}
            </div>
          )}
        </section>
      </div>

      <div className="statusbar">
        <span>{visiblePorts.length} shown</span>
        <span>{ports.length} total</span>
        <span>{devOnly ? 'Focused on common dev ports/processes' : 'Showing all non-system listening ports'}</span>
      </div>
    </div>
  );
}

const loadingEl = document.getElementById('loading');
if (loadingEl) loadingEl.remove();

const root = createRoot(document.getElementById('app')!);
root.render(<App />);
