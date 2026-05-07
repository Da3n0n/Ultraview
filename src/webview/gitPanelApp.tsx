import React, { useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import type {
    GitAccountState,
    GitPanelInboundMessage,
    GitPanelOutboundMessage,
    GitPanelStateMessage,
    GitStatusState,
} from './gitPanelTypes';
import type { GitProject } from '../git/types';

function getVscode() {
    return window.__vscodeApi as
        | { postMessage: (message: Record<string, unknown>) => void }
        | undefined;
}

type PanelState = Omit<GitPanelStateMessage, 'type' | 'gitStatuses'>;

const emptyState: PanelState = {
    projects: [],
    activeRepo: '',
    activeRepoName: '',
    accounts: [],
    activeAccountId: null,
    activeProjectId: null,
};

function authTone(status?: string): string {
    if (status === 'expired') return '#ff6b6b';
    if (status === 'warning') return '#ffd166';
    return '#6ee7b7';
}

function App() {
    const [state, setState] = useState<PanelState>(emptyState);
    // Stable git statuses — never wiped to empty; only merged when real data arrives
    const [gitStatuses, setGitStatuses] = useState<Record<string, GitStatusState>>({});
    // Which projects are currently being checked (background refresh in-flight)
    const [checkingIds, setCheckingIds] = useState<Set<string>>(new Set());
    // Which projects have a git operation (sync/push/pull) actively running
    const [pendingProjects, setPendingProjects] = useState<Record<string, boolean>>({});
    const [loaded, setLoaded] = useState(false);
    // Track project IDs we know are git repos so we can keep the action row visible
    const knownGitRepos = useRef<Set<string>>(new Set());

    useEffect(() => {
        const vscode = getVscode();
        vscode?.postMessage({ type: 'ready' satisfies GitPanelOutboundMessage['type'] });

        const handleMessage = (event: MessageEvent<GitPanelInboundMessage>) => {
            const msg = event.data;
            if (!msg) return;

            if (msg.type === 'state') {
                setLoaded(true);

                // Update non-status state
                setState({
                    projects: msg.projects,
                    activeRepo: msg.activeRepo,
                    activeRepoName: msg.activeRepoName,
                    accounts: msg.accounts,
                    activeAccountId: msg.activeAccountId,
                    activeProjectId: msg.activeProjectId,
                });

                const incomingStatuses = msg.gitStatuses ?? {};
                const hasStatuses = Object.keys(incomingStatuses).length > 0;

                if (msg.onlyProjectId) {
                    // Targeted update for a single project
                    if (hasStatuses) {
                        setGitStatuses((current) => ({ ...current, ...incomingStatuses }));
                        Object.entries(incomingStatuses).forEach(([id, s]) => {
                            if (s.isGitRepo) knownGitRepos.current.add(id);
                        });
                    }
                    setCheckingIds((current) => {
                        const next = new Set(current);
                        next.delete(msg.onlyProjectId!);
                        return next;
                    });
                    setPendingProjects((current) => {
                        const next = { ...current };
                        delete next[msg.onlyProjectId!];
                        return next;
                    });
                } else if (hasStatuses) {
                    // Full update with real status data — merge in
                    setGitStatuses((current) => ({ ...current, ...incomingStatuses }));
                    Object.entries(incomingStatuses).forEach(([id, s]) => {
                        if (s.isGitRepo) knownGitRepos.current.add(id);
                    });
                    // Mark all projects as no longer checking
                    setCheckingIds(new Set());
                    setPendingProjects({});
                } else {
                    // Flash message (empty statuses) — background fetch starting.
                    // Only mark projects that have no cached status yet as "checking".
                    // Known projects keep their existing badges visible.
                    setCheckingIds((currentChecking) => {
                        const next = new Set(currentChecking);
                        // Add only projects we have no data for yet
                        msg.projects.forEach((p) => {
                            if (!knownGitRepos.current.has(p.id)) {
                                next.add(p.id);
                            }
                        });
                        return next;
                    });
                }

                return;
            }

            getVscode()?.postMessage({ type: 'refresh' satisfies GitPanelOutboundMessage['type'] });
        };

        window.addEventListener('message', handleMessage as EventListener);
        return () => window.removeEventListener('message', handleMessage as EventListener);
    }, []);

    useEffect(() => {
        const activeProjectId = state.activeProjectId;
        if (!activeProjectId) return;
        const interval = window.setInterval(() => {
            getVscode()?.postMessage({
                type: 'refreshProjects' satisfies GitPanelOutboundMessage['type'],
            });
        }, 30000);
        return () => window.clearInterval(interval);
    }, [state.activeProjectId]);

    const activeAccount = useMemo(
        () => state.accounts.find((account) => account.id === state.activeAccountId) ?? null,
        [state.accounts, state.activeAccountId]
    );

    const runProjectCommand = (type: 'gitPull' | 'gitPush' | 'gitSync', id: string) => {
        setPendingProjects((current) => ({ ...current, [id]: true }));
        getVscode()?.postMessage({ type, id } satisfies GitPanelOutboundMessage);
    };

    const renderGitStatus = (project: GitProject, gitStatus?: GitStatusState) => {
        const isChecking = checkingIds.has(project.id);
        const isPending = !!pendingProjects[project.id];
        const isKnownRepo = knownGitRepos.current.has(project.id) || gitStatus?.isGitRepo;

        // If we've never seen this as a git repo and we're still loading, show nothing
        if (!isKnownRepo && !gitStatus) return null;
        // If it's definitively not a git repo, show nothing
        if (gitStatus && !gitStatus.isGitRepo && !isKnownRepo) return null;

        const chips: React.ReactNode[] = [];
        if (isPending) {
            chips.push(
                <span key="working" className="git-chip checking">
                    ⟳ Syncing…
                </span>
            );
        } else if (isChecking && !gitStatus) {
            chips.push(
                <span key="checking" className="git-chip checking">
                    Checking…
                </span>
            );
        } else if (gitStatus) {
            if (gitStatus.branch)
                chips.push(
                    <span key="branch" className="git-chip branch">
                        ⎇ {gitStatus.branch}
                    </span>
                );
            if (gitStatus.localChanges > 0)
                chips.push(
                    <span key="local" className="git-chip local">
                        ● {gitStatus.localChanges} local
                    </span>
                );
            if (gitStatus.ahead > 0)
                chips.push(
                    <span key="ahead" className="git-chip ahead">
                        ↑ {gitStatus.ahead} ahead
                    </span>
                );
            if (gitStatus.behind > 0)
                chips.push(
                    <span key="behind" className="git-chip behind">
                        ↓ {gitStatus.behind} behind
                    </span>
                );
            if (gitStatus.localChanges === 0 && gitStatus.ahead === 0 && gitStatus.behind === 0) {
                chips.push(
                    <span key="synced" className="git-chip synced">
                        ✓ synced
                    </span>
                );
            }
            if (isChecking) {
                chips.push(
                    <span key="rechecking" className="git-chip checking" style={{ opacity: 0.6 }}>
                        ↻
                    </span>
                );
            }
        }

        return (
            <>
                <div className="git-inline">{chips}</div>
                <div className="project-actions-row">
                    {gitStatus && (gitStatus.localChanges > 0 || gitStatus.ahead > 0) && (
                        <button
                            className="mini-button push"
                            disabled={isPending || isChecking}
                            onClick={() => runProjectCommand('gitPush', project.id)}
                        >
                            Push
                        </button>
                    )}
                    {gitStatus && gitStatus.behind > 0 && (
                        <button
                            className="mini-button pull"
                            disabled={isPending || isChecking}
                            onClick={() => runProjectCommand('gitPull', project.id)}
                        >
                            Pull
                        </button>
                    )}
                    <button
                        className="mini-button sync"
                        disabled={isPending}
                        onClick={() => runProjectCommand('gitSync', project.id)}
                    >
                        {isPending ? 'Syncing…' : 'Sync'}
                    </button>
                </div>
            </>
        );
    };

    return (
        <div className="git-panel-app">
            <style>{`
        :root {
          --bg: var(--vscode-sideBar-background, var(--vscode-editor-background));
          --surface: var(--vscode-editor-background, rgba(30,30,30,.5));
          --surface2: var(--vscode-list-hoverBackground, rgba(255,255,255,.05));
          --border: var(--vscode-panel-border, rgba(128,128,128,.24));
          --text: var(--vscode-editor-foreground);
          --muted: var(--vscode-descriptionForeground);
          --accent: var(--vscode-textLink-foreground, #6ee7b7);
        }
        .git-panel-app { display:flex; flex-direction:column; height:100vh; background:var(--vscode-editor-background, #1e1e1e); color:var(--text); }
        .git-toolbar { display:flex; gap:8px; padding:10px; border-bottom:1px solid var(--border); background:rgba(0,0,0,.08); backdrop-filter: blur(8px); }
        .toolbar-group { display:flex; gap:6px; flex-wrap:wrap; }
        .content { flex:1; min-height:0; overflow:auto; padding:12px; display:grid; gap:14px; }
        .section { display:grid; gap:8px; }
        .section-header { display:flex; justify-content:space-between; align-items:center; gap:8px; }
        .section-title { font-size:11px; letter-spacing:.08em; text-transform:uppercase; color:var(--muted); font-weight:700; }
        .button, .mini-button {
          border:1px solid var(--border); background:var(--surface2); color:var(--text); border-radius:8px; cursor:pointer;
          transition: transform .14s ease, background .14s ease, border-color .14s ease, opacity .14s ease;
        }
        .button { padding:6px 10px; font:inherit; font-size:11px; }
        .mini-button { padding:4px 8px; font:inherit; font-size:10px; font-weight:700; }
        .button:hover, .mini-button:hover:not(:disabled) { transform: translateY(-1px); background: color-mix(in srgb, var(--surface2) 70%, white 6%); border-color: color-mix(in srgb, var(--border) 55%, var(--accent)); }
        .button:disabled, .mini-button:disabled { opacity:.45; cursor:default; transform:none; }
        .projects-grid, .accounts-grid { display:grid; gap:8px; }
        .card {
          display:grid; gap:8px; padding:12px; border-radius:14px; border:1px solid var(--border);
          background:linear-gradient(180deg, rgba(255,255,255,.03), rgba(255,255,255,.015));
          box-shadow: inset 0 1px 0 rgba(255,255,255,.03);
          transition: transform .16s ease, border-color .16s ease, background .16s ease;
        }
        .card:hover { transform: translateY(-1px); border-color: color-mix(in srgb, var(--border) 50%, var(--accent)); background:linear-gradient(180deg, rgba(255,255,255,.045), rgba(255,255,255,.02)); }
        .card.active { border-color: rgba(110,231,183,.5); box-shadow: 0 0 0 1px rgba(110,231,183,.16), inset 0 1px 0 rgba(255,255,255,.03); }
        .project-main, .account-main { display:flex; justify-content:space-between; gap:10px; align-items:flex-start; }
        .project-meta, .account-meta { min-width:0; display:grid; gap:4px; }
        .project-name, .account-name { font-size:13px; font-weight:700; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
        .project-path, .account-sub { font-size:10px; color:var(--muted); white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
        .project-bind { font-size:10px; color:var(--accent); }
        .project-actions, .account-actions { display:flex; gap:6px; flex-wrap:wrap; }
        .git-inline { display:flex; gap:6px; flex-wrap:wrap; align-items:center; font-size:10px; color:var(--muted); min-height:22px; }
        .git-chip { padding:2px 7px; border-radius:999px; border:1px solid transparent; font-weight:700; }
        .git-chip.branch { background:rgba(148,163,184,.12); border-color:rgba(148,163,184,.2); }
        .git-chip.local { background:rgba(251,191,36,.14); border-color:rgba(251,191,36,.28); color:#fbbf24; }
        .git-chip.ahead { background:rgba(74,222,128,.14); border-color:rgba(74,222,128,.28); color:#4ade80; }
        .git-chip.behind { background:rgba(96,165,250,.14); border-color:rgba(96,165,250,.28); color:#60a5fa; }
        .git-chip.synced { background:rgba(110,231,183,.12); border-color:rgba(110,231,183,.24); color:#6ee7b7; }
        .git-chip.checking { background:rgba(148,163,184,.08); border-color:rgba(148,163,184,.16); color:var(--muted); font-weight:400; }
        .project-actions-row { display:flex; gap:6px; flex-wrap:wrap; min-height:26px; align-items:center; }
        .mini-button.push { background:rgba(251,191,36,.12); border-color:rgba(251,191,36,.28); color:#fbbf24; }
        .mini-button.pull { background:rgba(96,165,250,.12); border-color:rgba(96,165,250,.28); color:#60a5fa; }
        .mini-button.sync { background:rgba(192,132,252,.12); border-color:rgba(192,132,252,.28); color:#c084fc; }
        .status-dot { width:9px; height:9px; border-radius:999px; flex-shrink:0; margin-top:4px; }
        .account-row-top { display:flex; gap:8px; align-items:flex-start; }
        .statusbar { display:flex; gap:12px; padding:7px 12px; font-size:10px; color:var(--muted); border-top:1px solid var(--border); background:rgba(0,0,0,.08); }
        .empty { padding:18px 10px; color:var(--muted); text-align:center; border:1px dashed var(--border); border-radius:12px; }
      `}</style>

            {!loaded && (
                <div className="empty" style={{ margin: 12 }}>
                    Loading project manager...
                </div>
            )}


            <div className="content">
                <section className="section">
                    <div className="section-header">
                        <div className="section-title">Accounts</div>
                        <div className="toolbar-group">
                            <button
                                className="button"
                                title="Open as full panel"
                                onClick={() =>
                                    getVscode()?.postMessage({
                                        type: 'openPanel' satisfies GitPanelOutboundMessage['type'],
                                    })
                                }
                            >
                                &#x2B21;
                            </button>
                            <button
                                className="button"
                                onClick={() =>
                                    getVscode()?.postMessage({
                                        type: 'addAccount' satisfies GitPanelOutboundMessage['type'],
                                    })
                                }
                            >
                                + Account
                            </button>
                        </div>
                    </div>
                    <div className="accounts-grid">
                        {state.accounts.length === 0 ? (
                            <div className="empty">No accounts yet.</div>
                        ) : (
                            state.accounts.map((account: GitAccountState) => {
                                const isActive = account.id === state.activeAccountId;
                                return (
                                    <div
                                        key={account.id}
                                        className={`card${isActive ? ' active' : ''}`}
                                        onClick={(event) => {
                                            if ((event.target as HTMLElement).closest('button'))
                                                return;
                                            getVscode()?.postMessage({
                                                type: 'switchAccount',
                                                accountId: account.id,
                                            } satisfies GitPanelOutboundMessage);
                                        }}
                                    >
                                        <div className="account-row-top">
                                            <span
                                                className="status-dot"
                                                style={{ background: authTone(account.authStatus) }}
                                            />
                                            <div className="account-meta">
                                                <div className="account-name">
                                                    {account.username}
                                                </div>
                                                <div className="account-sub">
                                                    {account.provider} ·{' '}
                                                    {account.authMethod || 'unknown'} ·{' '}
                                                    {account.authStatus || 'valid'}
                                                </div>
                                            </div>
                                        </div>
                                        <div className="account-actions">
                                            {account.authMethod === 'oauth' &&
                                                account.authStatus &&
                                                account.authStatus !== 'valid' && (
                                                    <button
                                                        className="mini-button"
                                                        onClick={() =>
                                                            getVscode()?.postMessage({
                                                                type: 'reAuthAccount',
                                                                accountId: account.id,
                                                            } satisfies GitPanelOutboundMessage)
                                                        }
                                                    >
                                                        Re-auth
                                                    </button>
                                                )}
                                            <button
                                                className="mini-button"
                                                onClick={() =>
                                                    getVscode()?.postMessage({
                                                        type: 'authOptions',
                                                        accountId: account.id,
                                                    } satisfies GitPanelOutboundMessage)
                                                }
                                            >
                                                Auth
                                            </button>
                                            <button
                                                className="mini-button"
                                                onClick={() =>
                                                    getVscode()?.postMessage({
                                                        type: 'removeAccount',
                                                        accountId: account.id,
                                                    } satisfies GitPanelOutboundMessage)
                                                }
                                            >
                                                Remove
                                            </button>
                                        </div>
                                    </div>
                                );
                            })
                        )}
                    </div>
                </section>

                <section className="section">
                    <div className="section-header">
                        <div className="section-title">Projects</div>
                        <div className="toolbar-group">
                            <button
                                className="button"
                                title="Refresh"
                                onClick={() =>
                                    getVscode()?.postMessage({
                                        type: 'refreshProjects' satisfies GitPanelOutboundMessage['type'],
                                    })
                                }
                            >
                                &#x21BB;
                            </button>
                            <button
                                className="button"
                                title="Open S3 Backup panel"
                                onClick={() =>
                                    getVscode()?.postMessage({
                                        type: 'openS3Backup' satisfies GitPanelOutboundMessage['type'],
                                    })
                                }
                            >
                                ☁
                            </button>
                            <button
                                className="button"
                                onClick={() =>
                                    getVscode()?.postMessage({
                                        type: 'addRepo' satisfies GitPanelOutboundMessage['type'],
                                    })
                                }
                            >
                                + Repo
                            </button>
                            <button
                                className="button"
                                onClick={() =>
                                    getVscode()?.postMessage({
                                        type: 'addProject' satisfies GitPanelOutboundMessage['type'],
                                    })
                                }
                            >
                                + Local
                            </button>
                        </div>
                    </div>
                    <div className="projects-grid">
                        {state.projects.length === 0 ? (
                            <div className="empty">No projects yet.</div>
                        ) : (
                            state.projects.map((project) => {
                                const gitStatus = gitStatuses[project.id];
                                const boundAccount = state.accounts.find(
                                    (account) => account.id === project.accountId
                                );
                                const isActive = project.path === state.activeRepo;
                                return (
                                    <div
                                        key={project.id}
                                        className={`card${isActive ? ' active' : ''}`}
                                    >
                                        <div className="project-main">
                                            <div className="project-meta">
                                                <div className="project-name">{project.name}</div>
                                                <div className="project-path">{project.path}</div>
                                                {boundAccount && (
                                                    <div className="project-bind">
                                                        ⚡ {boundAccount.username} (
                                                        {boundAccount.provider})
                                                    </div>
                                                )}
                                            </div>
                                            <div className="project-actions">
                                                <button
                                                    className="mini-button"
                                                    onClick={() =>
                                                        getVscode()?.postMessage({
                                                            type: 'open',
                                                            id: project.id,
                                                        } satisfies GitPanelOutboundMessage)
                                                    }
                                                >
                                                    Open
                                                </button>
                                                <button
                                                    className="mini-button"
                                                    onClick={() =>
                                                        getVscode()?.postMessage({
                                                            type: 'delete',
                                                            id: project.id,
                                                        } satisfies GitPanelOutboundMessage)
                                                    }
                                                >
                                                    Remove
                                                </button>
                                                <button
                                                    className="mini-button"
                                                    title="Backup to S3"
                                                    onClick={() =>
                                                        getVscode()?.postMessage({
                                                            type: 's3BackupProject',
                                                            id: project.id,
                                                        } satisfies GitPanelOutboundMessage)
                                                    }
                                                >
                                                    ☁ Backup
                                                </button>
                                            </div>
                                        </div>
                                        {renderGitStatus(project, gitStatus)}
                                    </div>
                                );
                            })
                        )}
                    </div>
                </section>
            </div>

            <div className="statusbar">
                <span>{activeAccount ? `Account: ${activeAccount.username}` : 'No account'}</span>
                <span>
                    {state.projects.length} project{state.projects.length === 1 ? '' : 's'}
                </span>
            </div>
        </div>
    );
}

const loadingEl = document.getElementById('loading');
if (loadingEl) loadingEl.remove();

const root = createRoot(document.getElementById('app')!);
root.render(<App />);
