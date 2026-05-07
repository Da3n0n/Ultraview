import React, { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import type {
    S3BackupCredentials,
    S3BackupInboundMessage,
    S3BackupOutboundMessage,
    S3BackupPanelStateMessage,
    ProjectBackupState,
} from './s3BackupTypes';

function getVscode() {
    return window.__vscodeApi as
        | { postMessage: (message: Record<string, unknown>) => void }
        | undefined;
}

function post(msg: S3BackupOutboundMessage) {
    getVscode()?.postMessage(msg as unknown as Record<string, unknown>);
}

function fmtBytes(n: number): string {
    if (n < 1024) return `${n} B`;
    if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
    return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

function fmtKey(key?: string): string {
    if (!key) return '';
    const parts = key.split('/');
    return parts[parts.length - 1] ?? key;
}

function CredentialsForm({
    initial,
    onSave,
}: {
    initial?: Omit<S3BackupCredentials, 'secretAccessKey'>;
    onSave: (creds: S3BackupCredentials) => void;
}) {
    const [endpoint, setEndpoint] = useState(initial?.endpoint ?? 'https://gateway.storjshare.io');
    const [accessKeyId, setAccessKeyId] = useState(initial?.accessKeyId ?? '');
    const [secretAccessKey, setSecretAccessKey] = useState('');
    const [bucket, setBucket] = useState(initial?.bucket ?? '');
    const [showSecret, setShowSecret] = useState(false);

    const canSave = endpoint.trim() && accessKeyId.trim() && secretAccessKey.trim() && bucket.trim();

    return (
        <div className="creds-form">
            <div className="field">
                <label>Endpoint</label>
                <input
                    value={endpoint}
                    onChange={(e) => setEndpoint(e.target.value)}
                    placeholder="https://gateway.storjshare.io"
                />
            </div>
            <div className="field">
                <label>Access Key ID</label>
                <input
                    value={accessKeyId}
                    onChange={(e) => setAccessKeyId(e.target.value)}
                    placeholder="Access key ID"
                />
            </div>
            <div className="field">
                <label>Secret Access Key</label>
                <div className="secret-row">
                    <input
                        type={showSecret ? 'text' : 'password'}
                        value={secretAccessKey}
                        onChange={(e) => setSecretAccessKey(e.target.value)}
                        placeholder="Secret key"
                    />
                    <button className="mini-button" onClick={() => setShowSecret((v) => !v)}>
                        {showSecret ? 'Hide' : 'Show'}
                    </button>
                </div>
            </div>
            <div className="field">
                <label>Bucket Name</label>
                <input
                    value={bucket}
                    onChange={(e) => setBucket(e.target.value)}
                    placeholder="my-backup-bucket"
                />
            </div>
            <div className="field-row">
                <button
                    className="button primary"
                    disabled={!canSave}
                    onClick={() =>
                        onSave({ endpoint: endpoint.trim(), accessKeyId: accessKeyId.trim(), secretAccessKey: secretAccessKey.trim(), bucket: bucket.trim() })
                    }
                >
                    Save Credentials
                </button>
            </div>
        </div>
    );
}

function StatusBadge({ status, error }: { status: ProjectBackupState['status']; error?: string }) {
    if (status === 'backing-up')
        return <span className="badge backing-up">⟳ Backing up…</span>;
    if (status === 'success')
        return <span className="badge success">✓ Backed up</span>;
    if (status === 'error')
        return <span className="badge error" title={error}>✕ Error</span>;
    return <span className="badge idle">–</span>;
}

function App() {
    const [state, setState] = useState<S3BackupPanelStateMessage | null>(null);
    const [connectionResult, setConnectionResult] = useState<{ ok: boolean; error?: string } | null>(null);
    const [showCredsForm, setShowCredsForm] = useState(false);
    const [loaded, setLoaded] = useState(false);

    useEffect(() => {
        post({ type: 'ready' });

        const handle = (event: MessageEvent<S3BackupInboundMessage>) => {
            const msg = event.data;
            if (!msg) return;
            if (msg.type === 'state') {
                setState(msg);
                setLoaded(true);
                setShowCredsForm(false);
            } else if (msg.type === 'progress') {
                setState((prev) => {
                    if (!prev) return prev;
                    return {
                        ...prev,
                        projects: prev.projects.map((p) =>
                            p.projectId === msg.projectId
                                ? {
                                    ...p,
                                    status: msg.status,
                                    lastBackupKey: msg.lastBackupKey ?? p.lastBackupKey,
                                    lastBackupSize: msg.lastBackupSize ?? p.lastBackupSize,
                                    error: msg.error,
                                }
                                : p
                        ),
                    };
                });
            } else if (msg.type === 'connectionResult') {
                setConnectionResult({ ok: msg.ok, error: msg.error });
            }
        };

        window.addEventListener('message', handle as EventListener);
        return () => window.removeEventListener('message', handle as EventListener);
    }, []);

    const isBusy = state?.projects.some((p) => p.status === 'backing-up') ?? false;

    return (
        <div className="s3backup-app">
            <style>{`
        :root {
          --bg: var(--vscode-sideBar-background, var(--vscode-editor-background));
          --surface: var(--vscode-editor-background, rgba(30,30,30,.5));
          --surface2: var(--vscode-list-hoverBackground, rgba(255,255,255,.05));
          --border: var(--vscode-panel-border, rgba(128,128,128,.24));
          --text: var(--vscode-editor-foreground);
          --muted: var(--vscode-descriptionForeground);
          --accent: var(--vscode-textLink-foreground, #6ee7b7);
          --input-bg: var(--vscode-input-background, rgba(255,255,255,.06));
          --input-border: var(--vscode-input-border, rgba(128,128,128,.3));
        }
        * { box-sizing: border-box; margin: 0; padding: 0; }
        .s3backup-app { display:flex; flex-direction:column; height:100vh; background:var(--vscode-editor-background,#1e1e1e); color:var(--text); font:13px/1.5 -apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif; }
        .toolbar { display:flex; gap:8px; padding:10px; border-bottom:1px solid var(--border); background:rgba(0,0,0,.08); flex-wrap:wrap; align-items:center; }
        .toolbar-title { font-weight:700; font-size:12px; letter-spacing:.04em; color:var(--muted); text-transform:uppercase; flex:1; }
        .content { flex:1; overflow:auto; padding:12px; display:grid; gap:14px; align-content:start; }
        .section { display:grid; gap:8px; }
        .section-header { display:flex; justify-content:space-between; align-items:center; }
        .section-title { font-size:11px; letter-spacing:.08em; text-transform:uppercase; color:var(--muted); font-weight:700; }
        .button, .mini-button { border:1px solid var(--border); background:var(--surface2); color:var(--text); border-radius:8px; cursor:pointer; transition: transform .14s ease, background .14s ease, border-color .14s ease, opacity .14s ease; font:inherit; }
        .button { padding:6px 10px; font-size:11px; }
        .mini-button { padding:4px 8px; font-size:10px; font-weight:700; }
        .button.primary { background:rgba(110,231,183,.14); border-color:rgba(110,231,183,.32); color:#6ee7b7; }
        .button:hover:not(:disabled), .mini-button:hover:not(:disabled) { transform:translateY(-1px); background:color-mix(in srgb, var(--surface2) 70%, white 6%); border-color:color-mix(in srgb, var(--border) 55%, var(--accent)); }
        .button:disabled, .mini-button:disabled { opacity:.45; cursor:default; transform:none; }
        .card { display:grid; gap:8px; padding:12px; border-radius:14px; border:1px solid var(--border); background:linear-gradient(180deg,rgba(255,255,255,.03),rgba(255,255,255,.015)); box-shadow:inset 0 1px 0 rgba(255,255,255,.03); transition:transform .16s ease,border-color .16s ease; }
        .card:hover { transform:translateY(-1px); border-color:color-mix(in srgb,var(--border) 50%,var(--accent)); }
        .project-main { display:flex; justify-content:space-between; gap:10px; align-items:flex-start; }
        .project-meta { min-width:0; display:grid; gap:3px; }
        .project-name { font-size:13px; font-weight:700; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
        .project-path { font-size:10px; color:var(--muted); white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
        .project-last { font-size:10px; color:var(--accent); }
        .project-actions { display:flex; gap:6px; flex-wrap:wrap; }
        .badge { padding:2px 8px; border-radius:999px; border:1px solid transparent; font-size:10px; font-weight:700; }
        .badge.idle { background:rgba(148,163,184,.1); border-color:rgba(148,163,184,.2); color:var(--muted); }
        .badge.backing-up { background:rgba(192,132,252,.14); border-color:rgba(192,132,252,.3); color:#c084fc; }
        .badge.success { background:rgba(74,222,128,.14); border-color:rgba(74,222,128,.3); color:#4ade80; }
        .badge.error { background:rgba(248,113,113,.14); border-color:rgba(248,113,113,.3); color:#f87171; cursor:help; }
        .creds-card { padding:14px; border:1px solid var(--border); border-radius:14px; background:rgba(255,255,255,.02); display:grid; gap:10px; }
        .creds-info { display:grid; gap:4px; }
        .creds-row { display:flex; gap:8px; align-items:center; flex-wrap:wrap; }
        .creds-label { font-size:10px; color:var(--muted); }
        .creds-value { font-size:11px; font-family:monospace; }
        .creds-form { display:grid; gap:10px; }
        .field { display:grid; gap:4px; }
        .field label { font-size:10px; font-weight:700; color:var(--muted); text-transform:uppercase; letter-spacing:.06em; }
        .field input { background:var(--input-bg); border:1px solid var(--input-border); color:var(--text); border-radius:6px; padding:6px 8px; font:inherit; font-size:12px; outline:none; width:100%; }
        .field input:focus { border-color:var(--accent); }
        .field-row { display:flex; gap:8px; }
        .secret-row { display:flex; gap:6px; }
        .secret-row input { flex:1; }
        .conn-result { font-size:11px; padding:4px 8px; border-radius:6px; }
        .conn-result.ok { color:#4ade80; }
        .conn-result.fail { color:#f87171; }
        .empty { padding:18px 10px; color:var(--muted); text-align:center; border:1px dashed var(--border); border-radius:12px; font-size:12px; }
      `}</style>

            <div className="toolbar">
                <span className="toolbar-title">S3 Backup</span>
                <button
                    className="mini-button"
                    onClick={() => post({ type: 'refresh' })}
                    title="Refresh"
                >
                    ↻
                </button>
                {state?.hasCredentials && (
                    <button
                        className="button primary"
                        disabled={isBusy}
                        onClick={() => post({ type: 'backupAll' })}
                    >
                        {isBusy ? 'Backing up…' : 'Backup All'}
                    </button>
                )}
                <button
                    className="mini-button"
                    onClick={() => setShowCredsForm((v) => !v)}
                    title="Configure S3 credentials"
                >
                    ⚙
                </button>
            </div>

            {!loaded && (
                <div className="empty" style={{ margin: 12 }}>
                    Loading…
                </div>
            )}

            {loaded && (
                <div className="content">
                    {/* Credentials section */}
                    <section className="section">
                        <div className="section-header">
                            <div className="section-title">Credentials</div>
                        </div>
                        {showCredsForm ? (
                            <div className="creds-card">
                                <CredentialsForm
                                    initial={state?.credentials}
                                    onSave={(creds) => post({ type: 'saveCredentials', credentials: creds as unknown as S3BackupCredentials })}
                                />
                            </div>
                        ) : state?.hasCredentials ? (
                            <div className="creds-card">
                                <div className="creds-info">
                                    <div className="creds-label">Endpoint</div>
                                    <div className="creds-value">{state.credentials?.endpoint}</div>
                                    <div className="creds-label" style={{ marginTop: 6 }}>Bucket</div>
                                    <div className="creds-value">{state.credentials?.bucket}</div>
                                    <div className="creds-label" style={{ marginTop: 6 }}>Access Key ID</div>
                                    <div className="creds-value">{state.credentials?.accessKeyId?.slice(0, 8)}…</div>
                                </div>
                                <div className="creds-row">
                                    <button
                                        className="mini-button"
                                        onClick={() => {
                                            setConnectionResult(null);
                                            post({ type: 'testConnection' });
                                        }}
                                    >
                                        Test Connection
                                    </button>
                                    <button
                                        className="mini-button"
                                        onClick={() => post({ type: 'clearCredentials' })}
                                    >
                                        Clear
                                    </button>
                                    {connectionResult && (
                                        <span className={`conn-result ${connectionResult.ok ? 'ok' : 'fail'}`}>
                                            {connectionResult.ok ? '✓ Connected' : `✕ ${connectionResult.error ?? 'Failed'}`}
                                        </span>
                                    )}
                                </div>
                            </div>
                        ) : (
                            <div className="empty">
                                No credentials configured.
                                <br />
                                <button
                                    className="button"
                                    style={{ marginTop: 10 }}
                                    onClick={() => setShowCredsForm(true)}
                                >
                                    Configure S3 / Storj
                                </button>
                            </div>
                        )}
                    </section>

                    {/* Projects section */}
                    {state?.hasCredentials && (
                        <section className="section">
                            <div className="section-header">
                                <div className="section-title">Projects</div>
                            </div>
                            {state.projects.length === 0 ? (
                                <div className="empty">No projects found. Add projects in the Project Manager.</div>
                            ) : (
                                state.projects.map((p) => (
                                    <div key={p.projectId} className="card">
                                        <div className="project-main">
                                            <div className="project-meta">
                                                <div className="project-name">{p.projectName}</div>
                                                <div className="project-path">{p.projectPath}</div>
                                                {p.lastBackupKey && (
                                                    <div className="project-last">
                                                        Last: {fmtKey(p.lastBackupKey)}
                                                        {p.lastBackupSize ? ` (${fmtBytes(p.lastBackupSize)})` : ''}
                                                    </div>
                                                )}
                                            </div>
                                            <div className="project-actions">
                                                <StatusBadge status={p.status} error={p.error} />
                                                <button
                                                    className="mini-button"
                                                    disabled={isBusy}
                                                    onClick={() => post({ type: 'backupProject', projectId: p.projectId })}
                                                >
                                                    Backup
                                                </button>
                                            </div>
                                        </div>
                                        {p.status === 'error' && p.error && (
                                            <div style={{ fontSize: 10, color: '#f87171', paddingTop: 2 }}>{p.error}</div>
                                        )}
                                    </div>
                                ))
                            )}
                        </section>
                    )}
                </div>
            )}
        </div>
    );
}

const loadingEl = document.getElementById('loading');
if (loadingEl) loadingEl.remove();

const root = createRoot(document.getElementById('app')!);
root.render(<App />);
