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

function authToneClass(status?: string): string {
    if (status === 'expired') return 'status-dot-expired';
    if (status === 'warning') return 'status-dot-warning';
    return 'status-dot-valid';
}

function sameGitStatus(left?: GitStatusState, right?: GitStatusState): boolean {
    return left?.isGitRepo === right?.isGitRepo
        && left?.localChanges === right?.localChanges
        && left?.ahead === right?.ahead
        && left?.behind === right?.behind
        && left?.branch === right?.branch
        && left?.branchWorkBase === right?.branchWorkBase
        && left?.unmergedBranches === right?.unmergedBranches;
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
    // Each refresh arrives in cached/local/remote passes. Their metadata is
    // identical, so avoid rerendering the whole project list three times.
    const metadataSignature = useRef('');

    useEffect(() => {
        const vscode = getVscode();
        vscode?.postMessage({ type: 'ready' satisfies GitPanelOutboundMessage['type'] });

        const handleMessage = (event: MessageEvent<GitPanelInboundMessage>) => {
            const msg = event.data;
            if (!msg) return;

            if (msg.type === 'gitOpDone') {
                setPendingProjects((current) => {
                    const next = { ...current };
                    delete next[msg.projectId];
                    return next;
                });
                return;
            }

            if (msg.type === 'state') {
                setLoaded(true);

                const nextState: PanelState = {
                    projects: msg.projects,
                    activeRepo: msg.activeRepo,
                    activeRepoName: msg.activeRepoName,
                    accounts: msg.accounts,
                    activeAccountId: msg.activeAccountId,
                    activeProjectId: msg.activeProjectId,
                };
                const nextMetadataSignature = JSON.stringify(nextState);
                if (nextMetadataSignature !== metadataSignature.current) {
                    metadataSignature.current = nextMetadataSignature;
                    setState(nextState);
                }

                const incomingStatuses = msg.gitStatuses ?? {};
                const hasStatuses = Object.keys(incomingStatuses).length > 0;

                if (msg.onlyProjectId) {
                    // Targeted update for a single project
                    if (hasStatuses) {
                        setGitStatuses((current) => {
                            const changed = Object.entries(incomingStatuses)
                                .some(([id, status]) => !sameGitStatus(current[id], status));
                            return changed ? { ...current, ...incomingStatuses } : current;
                        });
                        Object.entries(incomingStatuses).forEach(([id, s]) => {
                            if (s.isGitRepo) knownGitRepos.current.add(id);
                        });
                    }
                    setCheckingIds((current) => {
                        if (!current.has(msg.onlyProjectId!)) return current;
                        const next = new Set(current);
                        next.delete(msg.onlyProjectId!);
                        return next;
                    });
                } else if (hasStatuses) {
                    // Full update with real status data — merge in
                    setGitStatuses((current) => {
                        const changed = Object.entries(incomingStatuses)
                            .some(([id, status]) => !sameGitStatus(current[id], status));
                        return changed ? { ...current, ...incomingStatuses } : current;
                    });
                    Object.entries(incomingStatuses).forEach(([id, s]) => {
                        if (s.isGitRepo) knownGitRepos.current.add(id);
                    });
                    // Mark all projects as no longer checking
                    setCheckingIds((current) => current.size ? new Set() : current);
                } else {
                    // Flash message (empty statuses) — background fetch starting.
                    // Only mark projects that have no cached status yet as "checking".
                    // Known projects keep their existing badges visible.
                    setCheckingIds((currentChecking) => {
                        const next = new Set(currentChecking);
                        let changed = false;
                        // Add only projects we have no data for yet
                        msg.projects.forEach((p) => {
                            if (!knownGitRepos.current.has(p.id)) {
                                next.add(p.id);
                                changed = changed || !currentChecking.has(p.id);
                            }
                        });
                        return changed ? next : currentChecking;
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
            if (document.hidden) return;
            if (Object.keys(pendingProjects).length > 0) return;
            getVscode()?.postMessage({
                type: 'refreshProjects' satisfies GitPanelOutboundMessage['type'],
            });
        }, 30000);
        return () => window.clearInterval(interval);
    }, [state.activeProjectId, pendingProjects]);

    const activeAccount = useMemo(
        () => state.accounts.find((account) => account.id === state.activeAccountId) ?? null,
        [state.accounts, state.activeAccountId]
    );
    const pendingCount = useMemo(() => Object.keys(pendingProjects).length, [pendingProjects]);

    const runProjectCommand = (type: 'gitSync', id: string) => {
        if (pendingProjects[id]) return;
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
            chips.push(
                <span key="branch" className="git-chip branch" title="Current branch">
                    ⎇ {gitStatus.branch || 'detached HEAD'}
                </span>
            );
            if (gitStatus.localChanges > 0 || gitStatus.ahead > 0) {
                const localDetails = [
                    gitStatus.localChanges > 0
                        ? `${gitStatus.localChanges} changed ${gitStatus.localChanges === 1 ? 'file' : 'files'}`
                        : '',
                    gitStatus.ahead > 0
                        ? `${gitStatus.ahead} ${gitStatus.ahead === 1 ? 'commit' : 'commits'} to upload`
                        : '',
                ].filter(Boolean).join(' · ');
                chips.push(
                    <span key="local" className="git-chip local" title="Sync commits changed files and uploads local commits to the remote.">
                        ↑ Local: {localDetails}
                    </span>
                );
            }
            if (gitStatus.behind > 0)
                chips.push(
                    <span key="behind" className="git-chip behind" title="Sync downloads these remote commits into the current branch.">
                        ↓ Remote: {gitStatus.behind} {gitStatus.behind === 1 ? 'commit' : 'commits'} to download
                    </span>
                );
            if (gitStatus.localChanges === 0 && gitStatus.ahead === 0 && gitStatus.behind === 0) {
                chips.push(
                    <span key="synced" className="git-chip synced" title="The current branch matches its remote, with no uncommitted changes.">
                        ✓ Synced
                    </span>
                );
            }
        }

        return (
            <>
                <div className="project-sync-row">
                    <div className="git-inline" role="status">{chips}</div>
                    <button
                        className="mini-button sync"
                        disabled={isPending}
                        onClick={() => runProjectCommand('gitSync', project.id)}
                        title={`Sync ${gitStatus?.branch || 'the current branch'}: upload local changes and download remote changes.`}
                    >
                        {isPending ? '⟳ Syncing…' : '⟲ Sync'}
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
          background:rgba(255,255,255,.025); isolation:isolate; contain:paint;
          box-shadow: inset 0 1px 0 rgba(255,255,255,.03);
          transition: transform .16s ease, border-color .16s ease, background .16s ease;
        }
        .card:hover { transform: translateY(-1px); border-color: color-mix(in srgb, var(--border) 50%, var(--accent)); background:rgba(255,255,255,.04); }
        .card.active { border-color: rgba(110,231,183,.5); box-shadow: 0 0 0 1px rgba(110,231,183,.16), inset 0 1px 0 rgba(255,255,255,.03); }
        .projects-grid .card, .accounts-grid .card { position:relative; padding-right:36px; cursor:pointer; }
        .projects-grid .card:focus-visible { outline:2px solid var(--accent); outline-offset:2px; }
        .card-remove { position:absolute; top:7px; right:7px; width:22px; height:22px; display:flex; align-items:center; justify-content:center; padding:0; border:0; border-radius:5px; background:transparent; color:var(--muted); font:18px/1 sans-serif; cursor:pointer; }
        .card-remove:hover:not(:disabled) { color:var(--vscode-errorForeground, #ff6b6b); background:var(--surface2); }
        .card-remove:focus-visible { outline:2px solid var(--accent); outline-offset:2px; }
        .card-remove:disabled { opacity:.45; cursor:default; }
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
        .git-chip.behind { background:rgba(96,165,250,.14); border-color:rgba(96,165,250,.28); color:#60a5fa; }
        .git-chip.synced { background:rgba(110,231,183,.12); border-color:rgba(110,231,183,.24); color:#6ee7b7; }
        .git-chip.checking { background:rgba(148,163,184,.08); border-color:rgba(148,163,184,.16); color:var(--muted); font-weight:400; }
        .project-sync-row { display:flex; gap:8px; flex-wrap:wrap; align-items:center; justify-content:space-between; }
        .project-sync-row .mini-button.sync { margin-left:auto; flex-shrink:0; }
        .mini-button.sync { background:rgba(192,132,252,.12); border-color:rgba(192,132,252,.28); color:#c084fc; }
        .status-dot { width:9px; height:9px; border-radius:999px; flex-shrink:0; margin-top:4px; }
        .status-dot-valid { background:#6ee7b7; }
        .status-dot-warning { background:#ffd166; }
        .status-dot-expired { background:#ff6b6b; }
        .account-row-top { display:flex; gap:8px; align-items:flex-start; }
        .statusbar { display:flex; gap:12px; padding:7px 12px; font-size:10px; color:var(--muted); border-top:1px solid var(--border); background:rgba(0,0,0,.08); }
        .empty { padding:18px 10px; color:var(--muted); text-align:center; border:1px dashed var(--border); border-radius:12px; }
        .empty-loading { margin:12px; }
      `}</style>

            {!loaded && (
                <div className="empty empty-loading">
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
                                        <button
                                            type="button"
                                            className="card-remove"
                                            title="Remove account"
                                            aria-label={`Remove account ${account.username}`}
                                            onClick={(event) => {
                                                event.stopPropagation();
                                                getVscode()?.postMessage({
                                                    type: 'removeAccount',
                                                    accountId: account.id,
                                                } satisfies GitPanelOutboundMessage);
                                            }}
                                        >
                                            ×
                                        </button>
                                        <div className="account-row-top">
                                            <span
                                                className={`status-dot ${authToneClass(account.authStatus)}`}
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
                                            {/* Show "Re-auth" for ANY oauth account (valid or not) so the user
                                                can refresh the token / add new scopes at any time. The button
                                                goes directly to the browser OAuth flow (no menu). */}
                                            {(account.authMethod === 'oauth' ||
                                                account.provider === 'github' ||
                                                account.provider === 'gitlab' ||
                                                account.provider === 'azure') && (
                                                <button
                                                    className="mini-button"
                                                    title={
                                                        account.authMethod === 'oauth'
                                                            ? 'Re-authenticate via browser (adds new scopes like workflow)'
                                                            : 'Sign in via browser (OAuth)'
                                                    }
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
                                                title="Manage SSH key, token, or browser re-auth"
                                                onClick={() =>
                                                    getVscode()?.postMessage({
                                                        type: 'authOptions',
                                                        accountId: account.id,
                                                    } satisfies GitPanelOutboundMessage)
                                                }
                                            >
                                                Auth…
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
                                disabled={pendingCount > 0}
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
                                        role="group"
                                        tabIndex={0}
                                        aria-label={`${project.name}. Click or press Enter to open project.`}
                                        aria-keyshortcuts="Enter"
                                        title="Click to open project"
                                        onClick={(event) => {
                                            if ((event.target as HTMLElement).closest('button')) return;
                                            if (pendingProjects[project.id]) return;
                                            getVscode()?.postMessage({ type: 'open', id: project.id } satisfies GitPanelOutboundMessage);
                                        }}
                                        onKeyDown={(event) => {
                                            if (event.target !== event.currentTarget || event.key !== 'Enter' || event.repeat) return;
                                            event.preventDefault();
                                            if (pendingProjects[project.id]) return;
                                            getVscode()?.postMessage({ type: 'open', id: project.id } satisfies GitPanelOutboundMessage);
                                        }}
                                    >
                                        <button
                                            type="button"
                                            className="card-remove"
                                            title="Remove project"
                                            aria-label={`Remove project ${project.name}`}
                                            disabled={!!pendingProjects[project.id]}
                                            onClick={() => getVscode()?.postMessage({
                                                type: 'delete',
                                                id: project.id,
                                            } satisfies GitPanelOutboundMessage)}
                                        >
                                            ×
                                        </button>
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
                                                    title="Project commands"
                                                    onClick={() =>
                                                        getVscode()?.postMessage({
                                                            type: 'projectCommands',
                                                            id: project.id,
                                                        } satisfies GitPanelOutboundMessage)
                                                    }
                                                >
                                                    &gt;_
                                                </button>
                                                <button
                                                    className="mini-button"
                                                    title="Refresh status (force fresh fetch + rev-list)"
                                                    onClick={() =>
                                                        getVscode()?.postMessage({
                                                            type: 'refreshSingleProject',
                                                            id: project.id,
                                                        } satisfies GitPanelOutboundMessage)
                                                    }
                                                >
                                                    ↻
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
                <span>Working: {pendingCount}</span>
            </div>
        </div>
    );
}

const loadingEl = document.getElementById('loading');
if (loadingEl) loadingEl.remove();

const root = createRoot(document.getElementById('app')!);
root.render(<App />);
