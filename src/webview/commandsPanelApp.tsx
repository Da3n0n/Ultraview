import React, { useEffect, useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';
import type { ProjectCommand } from '../commands/commandScanner';
import type {
    CommandsPanelInboundMessage,
    CommandsPanelOutboundMessage,
} from './commandsPanelTypes';

interface GroupedCommands {
    key: string;
    title: string;
    subtitle: string;
    commands: ProjectCommand[];
}

function getVscode() {
    return window.__vscodeApi as
        | { postMessage: (message: CommandsPanelOutboundMessage) => void }
        | undefined;
}

function normalize(text: string | undefined): string {
    return (text ?? '').toLowerCase();
}

function getCommandRole(command: ProjectCommand): string {
    const name = normalize(command.name);
    const run = normalize(command.runCmd);

    if (
        name === 'dev' ||
        name === 'develop' ||
        name.startsWith('dev:') ||
        /\b(dev|develop|vite|next dev|astro dev|nuxt dev)\b/.test(run)
    ) {
        return 'Dev';
    }
    if (
        name === 'build' ||
        name.startsWith('build:') ||
        /\b(build|cmake --build|cargo build|go build)\b/.test(run)
    ) {
        return 'Build';
    }
    if (
        name === 'start' ||
        name === 'serve' ||
        name === 'preview' ||
        /\b(start|serve|preview|run)\b/.test(run)
    ) {
        return 'Run';
    }
    if (name === 'test' || name.startsWith('test:') || name === 'e2e' || name.startsWith('e2e:')) {
        return 'Test';
    }
    if (
        name === 'lint' ||
        name.startsWith('lint:') ||
        name === 'typecheck' ||
        name === 'type-check' ||
        name === 'check' ||
        name === 'format'
    ) {
        return 'Check';
    }
    if (/\b(next|vite|astro|nuxt|svelte|webpack|rollup|cmake|gradle|cargo)\b/.test(run)) {
        return 'Framework';
    }
    return 'Task';
}

function getMainCommandRank(command: ProjectCommand): number {
    const role = getCommandRole(command);
    if (role === 'Dev') return 0;
    if (role === 'Build') return 1;
    if (role === 'Run') return 2;
    if (role === 'Framework') return 3;
    if (role === 'Test') return 4;
    if (role === 'Check') return 5;
    return 6 + command.priority;
}

function groupCommands(commands: ProjectCommand[]): GroupedCommands[] {
    const grouped = new Map<string, GroupedCommands>();

    for (const command of commands) {
        const key = `${command.workspaceLabel}:${command.cwd}`;
        const existing = grouped.get(key);
        if (existing) {
            existing.commands.push(command);
            continue;
        }

        grouped.set(key, {
            key,
            title: command.folderLabel || command.workspaceLabel,
            subtitle: command.cwd,
            commands: [command],
        });
    }

    return Array.from(grouped.values());
}

function App() {
    const [commands, setCommands] = useState<ProjectCommand[]>([]);
    const [loaded, setLoaded] = useState(false);
    const [search, setSearch] = useState('');
    const [typeFilter, setTypeFilter] = useState('');
    const [runningId, setRunningId] = useState<string | null>(null);
    const [expandedGroups, setExpandedGroups] = useState<Record<string, boolean>>({});

    useEffect(() => {
        getVscode()?.postMessage({ type: 'ready' });

        const handleMessage = (event: MessageEvent<CommandsPanelInboundMessage>) => {
            const message = event.data;
            if (!message || message.type !== 'state') return;
            setLoaded(true);
            setCommands(message.commands ?? []);
            setRunningId(null);
        };

        window.addEventListener('message', handleMessage as EventListener);
        return () => window.removeEventListener('message', handleMessage as EventListener);
    }, []);

    const filteredCommands = useMemo(() => {
        const query = search.trim().toLowerCase();
        return commands.filter((command) => {
            if (typeFilter && command.type !== typeFilter) {
                return false;
            }

            if (!query) {
                return true;
            }

            return [
                command.name,
                command.displayName,
                command.description,
                command.folderLabel,
                command.workspaceLabel,
                command.cwd,
                command.runCmd,
                command.type,
                getCommandRole(command),
            ].some((value) => normalize(value).includes(query));
        });
    }, [commands, search, typeFilter]);

    const groups = useMemo(() => groupCommands(filteredCommands), [filteredCommands]);

    const runCommand = (command: ProjectCommand) => {
        setRunningId(command.id);
        getVscode()?.postMessage({ type: 'run', command });
    };

    const toggleGroup = (key: string) => {
        setExpandedGroups((prev) => ({ ...prev, [key]: !prev[key] }));
    };

    const renderCompactCommand = (command: ProjectCommand, prominent = false) => (
        <button
            key={command.id}
            className={`command-row${prominent ? ' prominent' : ''}`}
            onClick={() => runCommand(command)}
            title={command.runCmd}
        >
            <span className={`type-badge ${command.type}`}>{command.type}</span>
            <span className="command-text">
                <span className="command-line">{command.runCmd}</span>
                <span className="command-meta">
                    <span className="command-role">{getCommandRole(command)}</span>
                    {command.description ? (
                        <span className="command-desc">{command.description}</span>
                    ) : (
                        <span className="command-desc">{command.displayName}</span>
                    )}
                </span>
            </span>
            <span className="run-pill">{runningId === command.id ? 'Running...' : 'Run'}</span>
        </button>
    );

    return (
        <div className="commands-app">
            <style>{`
        :root {
          --bg: var(--vscode-sideBar-background, var(--vscode-editor-background));
          --surface: var(--vscode-editor-background, rgba(30,30,30,.55));
          --surface2: var(--vscode-list-hoverBackground, rgba(255,255,255,.05));
          --surface3: rgba(255,255,255,.025);
          --border: var(--vscode-panel-border, rgba(128,128,128,.24));
          --text: var(--vscode-editor-foreground);
          --muted: var(--vscode-descriptionForeground);
          --accent: var(--vscode-textLink-foreground, #7dd3fc);
        }
        .commands-app {
          display: flex;
          flex-direction: column;
          height: 100vh;
          background: var(--vscode-editor-background, #1e1e1e);
          color: var(--text);
        }
        .toolbar {
          display: flex;
          gap: 8px;
          padding: 10px;
          border-bottom: 1px solid var(--border);
          background: var(--vscode-editor-background, #1e1e1e);
        }
        .toolbar-button, .search {
          border: 1px solid var(--border);
          border-radius: 10px;
          background: var(--surface2);
          color: var(--text);
          font: inherit;
          font-size: 11px;
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
        .search {
          flex: 1;
          min-width: 0;
          padding: 5px 10px;
          background: var(--bg);
        }

        .content {
          flex: 1;
          min-height: 0;
          overflow: auto;
          padding: 12px;
          display: grid;
          gap: 14px;
        }
        .project-card {
          display:grid; gap:10px; padding:12px; border-radius:14px; border:1px solid var(--border);
          background:linear-gradient(180deg, rgba(255,255,255,.03), rgba(255,255,255,.015));
          box-shadow: inset 0 1px 0 rgba(255,255,255,.03);
          transition: transform .16s ease, border-color .16s ease, background .16s ease;
        }
        .project-header {
          display:flex; justify-content:space-between; gap:10px; align-items:center;
        }
        .project-title-wrap { min-width:0; display:grid; gap:2px; }
        .project-title { font-size:12px; font-weight:700; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
        .project-path { font-size:10px; color:var(--muted); white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
        .project-count { font-size:10px; color:var(--muted); padding:2px 8px; border:1px solid var(--border); border-radius:999px; background:rgba(255,255,255,.04); flex-shrink:0; }
        .main-strip, .command-list { display:grid; gap:6px; }
        .section-label { font-size:10px; letter-spacing:.06em; text-transform:uppercase; color:var(--muted); font-weight:700; margin-bottom:2px; }
        .command-row {
          display:grid; grid-template-columns:auto 1fr auto; gap:10px; align-items:center;
          width:100%; text-align:left; border:1px solid var(--border); border-radius:12px;
          padding:7px 10px; background:rgba(255,255,255,.02); color:var(--text); cursor:pointer;
          transition: transform .14s ease, border-color .14s ease, background .14s ease;
        }
        .command-row:hover {
          transform: translateY(-1px);
          border-color: color-mix(in srgb, var(--border) 52%, var(--accent));
          background: rgba(125,211,252,.06);
        }
        .command-row.prominent { background:var(--bg); border-color:rgba(125,211,252,.3); }
        .command-row.prominent:hover { background:color-mix(in srgb, var(--bg) 90%, white 2%); }
        .type-badge {
          font-family: Consolas, 'Courier New', monospace;
          text-transform: uppercase;
          font-size: 10px;
          font-weight: 800;
          padding: 2px 7px;
          border-radius: 999px;
          border: 1px solid transparent;
        }
        .type-badge.npm { background:color-mix(in srgb,var(--bg) 82%,rgba(115,201,145,.15)); color: #73c991; border-color: rgba(115,201,145,.28); }
        .type-badge.bun { background:color-mix(in srgb,var(--bg) 82%,rgba(245,158,11,.15)); color: #f59e0b; border-color: rgba(245,158,11,.28); }
        .type-badge.pnpm { background:color-mix(in srgb,var(--bg) 82%,rgba(236,72,153,.15)); color: #ec4899; border-color: rgba(236,72,153,.28); }
        .type-badge.npx { background:color-mix(in srgb,var(--bg) 82%,rgba(99,102,241,.15)); color: #818cf8; border-color: rgba(99,102,241,.28); }
        .type-badge.deno { background:color-mix(in srgb,var(--bg) 82%,rgba(34,197,94,.15)); color: #4ade80; border-color: rgba(34,197,94,.28); }
        .type-badge.just { background:color-mix(in srgb,var(--bg) 82%,rgba(197,134,192,.15)); color: #c586c0; border-color: rgba(197,134,192,.28); }
        .type-badge.task { background:color-mix(in srgb,var(--bg) 82%,rgba(78,201,176,.15)); color: #4ec9b0; border-color: rgba(78,201,176,.28); }
        .type-badge.make { background:color-mix(in srgb,var(--bg) 82%,rgba(206,145,120,.15)); color: #ce9178; border-color: rgba(206,145,120,.28); }
        .type-badge.python { background:color-mix(in srgb,var(--bg) 82%,rgba(86,156,214,.15)); color: #569cd6; border-color: rgba(86,156,214,.28); }
        .type-badge.go { background:color-mix(in srgb,var(--bg) 82%,rgba(0,136,255,.15)); color: #60a5fa; border-color: rgba(0,136,255,.28); }
        .type-badge.powershell { background:color-mix(in srgb,var(--bg) 82%,rgba(13,125,189,.15)); color: #38bdf8; border-color: rgba(13,125,189,.28); }
        .type-badge.shell { background:color-mix(in srgb,var(--bg) 82%,rgba(0,153,102,.15)); color: #34d399; border-color: rgba(0,153,102,.28); }
        .command-text {
          min-width: 0;
          display: grid;
          gap: 2px;
        }
        .command-line {
          font: 600 11px/1.4 Consolas, 'Courier New', monospace;
          white-space: nowrap;
          overflow: hidden;
          text-overflow: ellipsis;
        }
        .command-meta {
          display: flex;
          gap: 8px;
          min-width: 0;
          align-items: center;
        }
        .command-role, .command-desc {
          font-size: 10px;
          color: var(--muted);
          white-space: nowrap;
          overflow: hidden;
          text-overflow: ellipsis;
        }
        .command-role {
          color: var(--accent);
          flex-shrink: 0;
          font-weight: 700;
        }
        .command-desc {
          min-width: 0;
        }
        .run-pill {
          font-size: 10px;
          font-weight: 700;
          border-radius: 999px;
          padding: 3px 8px;
          background: var(--bg);
          border: 1px solid var(--border);
        }
        .statusbar {
          display: flex;
          gap: 12px;
          padding: 7px 12px;
          font-size: 10px;
          color: var(--muted);
          border-top: 1px solid var(--border);
          background: var(--vscode-editor-background, #1e1e1e);
        }
        .empty {
          padding: 22px 12px;
          color: var(--muted);
          text-align: center;
          border: 1px dashed var(--border);
          border-radius: 14px;
        }
      `}</style>

            <div className="toolbar">
                <button
                    className="toolbar-button"
                    onClick={() => getVscode()?.postMessage({ type: 'refresh' })}
                >
                    Refresh
                </button>
                <input
                    className="search"
                    value={search}
                    onChange={(event) => setSearch(event.target.value)}
                    placeholder="Search commands, folders, frameworks..."
                />
                <button
                    className="toolbar-button"
                    onClick={() => getVscode()?.postMessage({ type: 'openPanel' })}
                >
                    Open
                </button>
            </div>

            <div className="content">
                {!loaded && <div className="empty">Scanning project commands...</div>}
                {loaded && commands.length === 0 && (
                    <div className="empty">
                        No commands found. Open a project with scripts, tasks, build files, or
                        common manifests.
                    </div>
                )}
                {loaded && commands.length > 0 && groups.length === 0 && (
                    <div className="empty">No commands match the current filter.</div>
                )}

                {groups.map((group) => {
                    const isExpanded = expandedGroups[group.key];
                    const mainCommands = group.commands.slice(0, 3);
                    const remainingCommands = group.commands.slice(3);

                    return (
                        <section key={group.key} className="project-card">
                            <div
                                className="project-header"
                                onClick={() => toggleGroup(group.key)}
                                style={{ cursor: 'pointer' }}
                            >
                                <div className="project-title-wrap">
                                    <div className="project-title">{group.title}</div>
                                    <div className="project-path">{group.subtitle}</div>
                                </div>
                                <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
                                    <div className="project-count">
                                        {group.commands.length} commands
                                    </div>
                                    {remainingCommands.length > 0 && (
                                        <div style={{ fontSize: '10px', color: 'var(--muted)' }}>
                                            {isExpanded ? '▲' : '▼'}
                                        </div>
                                    )}
                                </div>
                            </div>

                            <div className="main-strip">
                                <div className="section-label">Most Recent</div>
                                {mainCommands.map((command) => renderCompactCommand(command, true))}
                            </div>

                            {isExpanded && remainingCommands.length > 0 && (
                                <div className="command-list">
                                    <div className="section-label">All Commands</div>
                                    {remainingCommands.map((command) =>
                                        renderCompactCommand(command)
                                    )}
                                </div>
                            )}
                        </section>
                    );
                })}
            </div>

            <div className="statusbar">
                <span>{filteredCommands.length} shown</span>
                <span>{commands.length} total</span>
                <span>
                    {groups.length} project{groups.length === 1 ? '' : 's'}
                </span>
            </div>
        </div>
    );
}

const loadingEl = document.getElementById('loading');
if (loadingEl) loadingEl.remove();

const root = createRoot(document.getElementById('app')!);
root.render(<App />);
