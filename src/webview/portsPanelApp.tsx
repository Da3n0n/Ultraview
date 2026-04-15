import React, { useEffect, useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';
import type { PortProcess } from '../ports/portManager';
import type { PortsPanelInboundMessage, PortsPanelOutboundMessage } from './portsPanelTypes';

function getVscode() {
    return window.__vscodeApi as
        | { postMessage: (message: PortsPanelOutboundMessage) => void }
        | undefined;
}

function normalize(value: string | number | undefined): string {
    return String(value ?? '').toLowerCase();
}

function App() {
    const [ports, setPorts] = useState<PortProcess[]>([]);
    const [loaded, setLoaded] = useState(false);
    const [killing, setKilling] = useState<Record<number, boolean>>({});
    const [killingAll, setKillingAll] = useState(false);

    useEffect(() => {
        getVscode()?.postMessage({ type: 'ready', devOnly: false });

        const handleMessage = (event: MessageEvent<PortsPanelInboundMessage>) => {
            const message = event.data;
            if (!message || message.type !== 'state') return;
            setLoaded(true);
            setPorts(message.ports ?? []);
            setKilling({});
            setKillingAll(false);
        };

        window.addEventListener('message', handleMessage as EventListener);
        return () => window.removeEventListener('message', handleMessage as EventListener);
    }, []);

    const devPorts = useMemo(() => ports.filter((port) => port.isDev), [ports]);

    const refresh = () => {
        getVscode()?.postMessage({ type: 'refresh', devOnly: false });
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
                    <div className="port-name" title={port.name}>
                        {port.name}
                    </div>
                    {port.isDev && <span className="port-chip">Dev</span>}
                </div>
                <div className="port-meta">PID {port.pid}</div>
            </div>
            <button
                className="danger-button"
                onClick={() => killOne(port.pid)}
                disabled={Boolean(killing[port.pid])}
            >
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
          background: var(--bg);
          color: var(--text);
        }
        .toolbar {
          display: flex;
          gap: 8px;
          padding: 10px;
          border-bottom: 1px solid var(--border);
          background: var(--bg);
        }
        .toolbar-button {
          border: 1px solid var(--border);
          border-radius: 8px;
          background: var(--surface2);
          color: var(--text);
          font: inherit;
          font-size: 11px;
          padding: 5px 10px;
          cursor: pointer;
          transition: border-color .14s ease, background .14s ease;
        }
        .toolbar-button:hover {
          border-color: color-mix(in srgb, var(--border) 60%, var(--accent));
          background: color-mix(in srgb, var(--surface2) 70%, white 4%);
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
          border: 1px solid var(--border);
          border-radius: 10px;
          color: var(--text);
          font: inherit;
        }
        .content {
          flex: 1;
          min-height: 0;
          overflow: auto;
          padding: 10px;
          display: grid;
          gap: 10px;
        }
        .list-card {
          display:grid; gap:8px;
        }
        .port-list {
          display:grid; gap:6px;
        }
        .port-card {
          display:grid; grid-template-columns:auto 1fr auto; gap:10px; align-items:center;
          padding:10px 12px; border-radius:10px; border:1px solid var(--border);
          background:var(--surface2);
          transition: border-color .14s ease, background .14s ease;
        }
        .port-card:hover {
          border-color: color-mix(in srgb, var(--border) 60%, var(--accent));
          background: color-mix(in srgb, var(--surface2) 70%, white 4%);
        }
        .port-card.dev {
          border-color: rgba(74,222,128,.35);
          background: color-mix(in srgb, var(--bg) 92%, rgba(74,222,128,.12));
        }
        .port-card.dev:hover {
          border-color: rgba(74,222,128,.6);
          background: color-mix(in srgb, var(--bg) 88%, rgba(74,222,128,.18));
        }
        .port-badge {
          min-width: 52px;
          text-align: center;
          border-radius: 999px;
          padding: 3px 8px;
          font: 700 10px/1 Consolas, 'Courier New', monospace;
          background: color-mix(in srgb, var(--bg) 85%, rgba(125,211,252,.15));
          color: var(--accent);
          border: 1px solid rgba(125,211,252,.3);
        }
        .port-badge.dev {
          background: color-mix(in srgb, var(--bg) 85%, rgba(74,222,128,.15));
          color: var(--dev-text);
          border-color: rgba(74,222,128,.35);
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
          background: color-mix(in srgb, var(--bg) 85%, rgba(74,222,128,.15));
          color: var(--dev-text);
          border: 1px solid rgba(74,222,128,.35);
        }
        .port-meta {
          font-size: 9px;
          color: var(--muted);
        }
        .danger-button {
          border:1px solid var(--danger-border); background:var(--surface2); color:var(--danger);
          border-radius:8px; padding:4px 10px; font:inherit; font-size:10px; font-weight:700;
          cursor:pointer; transition: border-color .14s ease, background .14s ease;
        }
        .danger-button:hover {
          border-color: var(--danger);
          background: color-mix(in srgb, var(--surface2) 60%, rgba(248,113,113,.15));
        }
        .danger-button:disabled { opacity:.45; cursor:default; }
        .empty {
          padding: 20px 12px;
          color: var(--muted);
          text-align: center;
          border: 1px dashed var(--border);
          border-radius: 10px;
        }
        .statusbar {
          display: flex;
          gap: 12px;
          padding: 7px 12px;
          font-size: 10px;
          color: var(--muted);
          border-top: 1px solid var(--border);
          background: var(--bg);
        }
        @media (max-width: 720px) {
          .hero {
            grid-template-columns: 1fr;
          }
        }
      `}</style>

            <div className="toolbar">
                <button className="toolbar-button" onClick={() => refresh()}>
                    ↻
                </button>
                <div
                    style={{
                        display: 'flex',
                        gap: '8px',
                        flex: 1,
                        alignItems: 'center',
                        margin: '0 4px',
                        overflow: 'hidden',
                    }}
                >
                    <span
                        style={{
                            fontSize: '10px',
                            color: 'var(--muted)',
                            fontWeight: 700,
                            whiteSpace: 'nowrap',
                        }}
                    >
                        {ports.length} PORTS ({devPorts.length} DEV)
                    </span>
                    <button
                        className="danger-button"
                        style={{
                            padding: '3px 8px',
                            fontSize: '9px',
                            marginLeft: 'auto',
                            whiteSpace: 'nowrap',
                        }}
                        onClick={killAllDev}
                        disabled={killingAll || devPorts.length === 0}
                    >
                        {killingAll ? 'Killing...' : `Kill Dev (${devPorts.length})`}
                    </button>
                </div>
                <button
                    className="toolbar-button"
                    id="btn-panel"
                    onClick={() => getVscode()?.postMessage({ type: 'openPanel' })}
                    title="Open as full panel"
                >
                    ⬡
                </button>
            </div>

            <div className="content">
                <section className="list-card">
                    {!loaded && <div className="empty">Scanning ports...</div>}
                    {loaded && ports.length === 0 && (
                        <div className="empty">No listening ports found.</div>
                    )}
                    {ports.length > 0 && (
                        <div className="port-list">{ports.map(renderPortCard)}</div>
                    )}
                </section>
            </div>

            <div className="statusbar">
                <span>{ports.length} shown</span>
                <span>Filtered system noise</span>
            </div>
        </div>
    );
}

const loadingEl = document.getElementById('loading');
if (loadingEl) loadingEl.remove();

const root = createRoot(document.getElementById('app')!);
root.render(<App />);
