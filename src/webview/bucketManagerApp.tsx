import React, { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import type {
    BucketConfigPayload,
    BucketItem,
    BucketManagerInboundMessage,
    BucketManagerOutboundMessage,
    BucketProfile,
} from './bucketManagerTypes';

// ── Utilities ─────────────────────────────────────────────────────────────

function getVscode() {
    return window.__vscodeApi as
        | { postMessage: (msg: Record<string, unknown>) => void }
        | undefined;
}

function post(msg: BucketManagerOutboundMessage) {
    getVscode()?.postMessage(msg as unknown as Record<string, unknown>);
}

function fmtBytes(n?: number): string {
    if (n === undefined) return '';
    if (n < 1024) return `${n} B`;
    if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
    if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
    return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

function fmtDate(iso?: string): string {
    if (!iso) return '';
    try {
        const d = new Date(iso);
        return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: '2-digit' });
    } catch { return ''; }
}

function parseBreadcrumb(prefix: string): { label: string; prefix: string }[] {
    const crumbs: { label: string; prefix: string }[] = [{ label: '/', prefix: '' }];
    const parts = prefix.split('/').filter(Boolean);
    let acc = '';
    for (const p of parts) {
        acc += p + '/';
        crumbs.push({ label: p, prefix: acc });
    }
    return crumbs;
}

// ── Add/Edit Bucket Form ──────────────────────────────────────────────────

function BucketForm({
    initial,
    onSave,
    onCancel,
}: {
    initial?: BucketProfile;
    onSave: (c: BucketConfigPayload) => void;
    onCancel: () => void;
}) {
    const [name, setName] = useState(initial?.name ?? '');
    const [endpoint, setEndpoint] = useState(initial?.endpoint ?? 'https://gateway.storjshare.io');
    const [accessKeyId, setAccessKeyId] = useState(initial?.accessKeyId ?? '');
    const [secretAccessKey, setSecretAccessKey] = useState('');
    const [bucket, setBucket] = useState(initial?.bucket ?? '');
    const [showSecret, setShowSecret] = useState(false);

    const isEdit = !!initial;
    const canSave = name.trim() && endpoint.trim() && accessKeyId.trim() && (isEdit || secretAccessKey.trim()) && bucket.trim();

    function handleSave() {
        if (!canSave) return;
        onSave({
            id: initial?.id,
            name: name.trim(),
            endpoint: endpoint.trim(),
            accessKeyId: accessKeyId.trim(),
            secretAccessKey: secretAccessKey.trim(),
            bucket: bucket.trim(),
        });
    }

    return (
        <div className="form-card">
            <div className="form-title">{isEdit ? 'Edit Bucket' : 'Add Bucket'}</div>
            <div className="field">
                <label>Name</label>
                <input value={name} onChange={(e) => setName(e.target.value)} placeholder="My Backup Bucket" />
            </div>
            <div className="field">
                <label>Endpoint</label>
                <input value={endpoint} onChange={(e) => setEndpoint(e.target.value)} placeholder="https://gateway.storjshare.io" />
            </div>
            <div className="field">
                <label>Access Key ID</label>
                <input value={accessKeyId} onChange={(e) => setAccessKeyId(e.target.value)} placeholder="Access key ID" />
            </div>
            <div className="field">
                <label>Secret Key{isEdit ? ' (leave blank to keep existing)' : ''}</label>
                <div className="secret-row">
                    <input
                        type={showSecret ? 'text' : 'password'}
                        value={secretAccessKey}
                        onChange={(e) => setSecretAccessKey(e.target.value)}
                        placeholder={isEdit ? '(unchanged)' : 'Secret key'}
                    />
                    <button className="mini-button" onClick={() => setShowSecret((v) => !v)}>
                        {showSecret ? 'Hide' : 'Show'}
                    </button>
                </div>
            </div>
            <div className="field">
                <label>Bucket Name</label>
                <input value={bucket} onChange={(e) => setBucket(e.target.value)} placeholder="my-bucket" />
            </div>
            <div className="form-actions">
                <button className="button primary" disabled={!canSave} onClick={handleSave}>
                    {isEdit ? 'Save' : 'Add Bucket'}
                </button>
                <button className="button" onClick={onCancel}>Cancel</button>
            </div>
        </div>
    );
}

// ── File Browser ──────────────────────────────────────────────────────────

interface BrowserState {
    bucketId: string;
    prefix: string;
    folders: BucketItem[];
    files: BucketItem[];
    loading: boolean;
    error?: string;
}

function FileBrowser({
    state,
    onNavigate,
    onDownload,
    onDownloadFolder,
    onUpload,
    onRefresh,
}: {
    state: BrowserState;
    onNavigate: (prefix: string) => void;
    onDownload: (key: string) => void;
    onDownloadFolder: (prefix: string) => void;
    onUpload: () => void;
    onRefresh: () => void;
}) {
    const crumbs = parseBreadcrumb(state.prefix);
    const hasContent = state.folders.length > 0 || state.files.length > 0;

    return (
        <div className="browser">
            {/* Breadcrumb */}
            <div className="breadcrumb-row">
                <div className="breadcrumb">
                    {crumbs.map((c, i) => (
                        <React.Fragment key={c.prefix}>
                            {i > 0 && <span className="crumb-sep">›</span>}
                            <button
                                className={`crumb${i === crumbs.length - 1 ? ' active' : ''}`}
                                onClick={() => c.prefix !== state.prefix && onNavigate(c.prefix)}
                            >
                                {c.label}
                            </button>
                        </React.Fragment>
                    ))}
                </div>
                <div className="browser-actions">
                    {state.prefix !== '' && (
                        <button
                            className="mini-button"
                            title="Up one level"
                            onClick={() => {
                                const parts = state.prefix.replace(/\/$/, '').split('/');
                                parts.pop();
                                onNavigate(parts.length ? parts.join('/') + '/' : '');
                            }}
                        >
                            ↑
                        </button>
                    )}
                    <button className="mini-button upload-btn" onClick={onUpload} title="Upload files">
                        ↑ Upload
                    </button>
                    <button className="mini-button" onClick={onRefresh} title="Refresh">↻</button>
                </div>
            </div>

            {/* Content */}
            {state.loading ? (
                <div className="browser-empty">Loading…</div>
            ) : state.error ? (
                <div className="browser-empty error-text">{state.error}</div>
            ) : !hasContent ? (
                <div className="browser-empty">This folder is empty.</div>
            ) : (
                <div className="file-list">
                    {state.folders.map((f) => (
                        <div
                            key={f.key}
                            className="file-row folder-row"
                            onClick={() => onNavigate(f.key)}
                        >
                            <span className="file-icon">📁</span>
                            <span className="file-name">{f.name}</span>
                            <span className="file-meta">–</span>
                            <button
                                className="mini-button dl-btn"
                                title="Download folder"
                                onClick={(e) => { e.stopPropagation(); onDownloadFolder(f.key); }}
                            >
                                ↓
                            </button>
                        </div>
                    ))}
                    {state.files.map((f) => (
                        <div key={f.key} className="file-row">
                            <span className="file-icon">📄</span>
                            <span className="file-name">{f.name}</span>
                            <span className="file-meta">
                                {fmtBytes(f.size)}
                                {f.lastModified ? ` · ${fmtDate(f.lastModified)}` : ''}
                            </span>
                            <button
                                className="mini-button dl-btn"
                                title="Download"
                                onClick={(e) => { e.stopPropagation(); onDownload(f.key); }}
                            >
                                ↓
                            </button>
                        </div>
                    ))}
                </div>
            )}
        </div>
    );
}

// ── Main App ──────────────────────────────────────────────────────────────

function App() {
    const [buckets, setBuckets] = useState<BucketProfile[]>([]);
    const [loaded, setLoaded] = useState(false);
    const [showForm, setShowForm] = useState(false);
    const [editingId, setEditingId] = useState<string | null>(null);
    const [testResults, setTestResults] = useState<Record<string, { ok: boolean; error?: string }>>({});
    const [activeBucketId, setActiveBucketId] = useState<string | null>(null);
    const [browser, setBrowser] = useState<BrowserState | null>(null);

    useEffect(() => {
        post({ type: 'ready' });

        const handle = (event: MessageEvent<BucketManagerInboundMessage>) => {
            const msg = event.data;
            if (!msg) return;
            if (msg.type === 'state') {
                setBuckets(msg.buckets);
                setLoaded(true);
                setShowForm(false);
                setEditingId(null);
            } else if (msg.type === 'listResult') {
                setBrowser((prev) => {
                    if (prev?.bucketId !== msg.bucketId) return prev;
                    return { ...prev, prefix: msg.prefix, folders: msg.folders, files: msg.files, loading: false, error: undefined };
                });
            } else if (msg.type === 'listError') {
                setBrowser((prev) => {
                    if (prev?.bucketId !== msg.bucketId) return prev;
                    return { ...prev, loading: false, error: msg.error };
                });
            } else if (msg.type === 'testResult') {
                setTestResults((r) => ({ ...r, [msg.bucketId]: { ok: msg.ok, error: msg.error } }));
            } else if (msg.type === 'uploadDone') {
                // Refresh the listing
                if (browser?.bucketId === msg.bucketId) {
                    triggerList(msg.bucketId, browser.prefix);
                }
            }
        };

        window.addEventListener('message', handle as EventListener);
        return () => window.removeEventListener('message', handle as EventListener);
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    // Keep browser ref up to date for the uploadDone handler
    const browserRef = useRef(browser);
    browserRef.current = browser;

    function triggerList(id: string, prefix: string) {
        setBrowser((prev) => ({
            bucketId: id,
            prefix,
            folders: prev?.bucketId === id && prev.prefix === prefix ? prev.folders : [],
            files: prev?.bucketId === id && prev.prefix === prefix ? prev.files : [],
            loading: true,
        }));
        post({ type: 'listBucket', id, prefix });
    }

    function openBucket(id: string) {
        setActiveBucketId(id);
        triggerList(id, '');
    }

    const editingBucket = editingId ? buckets.find((b) => b.id === editingId) : undefined;

    return (
        <div className="bm-app">
            <style>{`
        :root {
          --bg: var(--vscode-sideBar-background, var(--vscode-editor-background));
          --surface2: var(--vscode-list-hoverBackground, rgba(255,255,255,.05));
          --border: var(--vscode-panel-border, rgba(128,128,128,.24));
          --text: var(--vscode-editor-foreground);
          --muted: var(--vscode-descriptionForeground);
          --accent: var(--vscode-textLink-foreground, #6ee7b7);
          --input-bg: var(--vscode-input-background, rgba(255,255,255,.06));
          --input-border: var(--vscode-input-border, rgba(128,128,128,.3));
        }
        * { box-sizing:border-box; margin:0; padding:0; }
        .bm-app { display:flex; flex-direction:column; height:100vh; background:var(--vscode-sideBar-background, var(--vscode-editor-background,#1e1e1e)); color:var(--text); font:13px/1.5 -apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif; }
        .toolbar { display:flex; gap:8px; padding:10px; border-bottom:1px solid var(--border); background:rgba(0,0,0,.08); backdrop-filter:blur(8px); align-items:center; justify-content:flex-end; flex-wrap:wrap; }
        .content { flex:1; overflow:auto; padding:12px; display:grid; gap:14px; align-content:start; }
        .section { display:grid; gap:8px; }
        .section-header { display:flex; justify-content:space-between; align-items:center; gap:8px; }
        .section-title { font-size:11px; letter-spacing:.08em; text-transform:uppercase; color:var(--muted); font-weight:700; }
        .button, .mini-button { border:1px solid var(--border); background:var(--surface2); color:var(--text); border-radius:8px; cursor:pointer; font:inherit; transition: transform .14s ease,background .14s ease,border-color .14s ease,opacity .14s ease; }
        .button { padding:6px 10px; font-size:11px; }
        .mini-button { padding:4px 8px; font-size:10px; font-weight:700; }
        .button.primary { background:rgba(110,231,183,.14); border-color:rgba(110,231,183,.32); color:#6ee7b7; }
        .button:hover:not(:disabled), .mini-button:hover:not(:disabled) { transform:translateY(-1px); background:color-mix(in srgb,var(--surface2) 70%,white 6%); border-color:color-mix(in srgb,var(--border) 55%,var(--accent)); }
        .button:disabled, .mini-button:disabled { opacity:.45; cursor:default; transform:none; }
        .card { display:grid; gap:8px; padding:12px; border-radius:14px; border:1px solid var(--border); background:linear-gradient(180deg,rgba(255,255,255,.03),rgba(255,255,255,.015)); box-shadow:inset 0 1px 0 rgba(255,255,255,.03); transition:transform .16s ease,border-color .16s ease,background .16s ease; }
        .card:hover { transform:translateY(-1px); border-color:color-mix(in srgb,var(--border) 50%,var(--accent)); }
        .card.active { border-color:rgba(110,231,183,.5); box-shadow:0 0 0 1px rgba(110,231,183,.16),inset 0 1px 0 rgba(255,255,255,.03); }
        .bucket-main { display:flex; justify-content:space-between; gap:10px; align-items:flex-start; }
        .bucket-meta { min-width:0; display:grid; gap:3px; flex:1; }
        .bucket-name { font-size:13px; font-weight:700; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
        .bucket-sub { font-size:10px; color:var(--muted); white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
        .bucket-sub b { color:var(--accent); font-weight:600; }
        .bucket-actions { display:flex; gap:6px; flex-wrap:wrap; align-items:flex-start; flex-shrink:0; }
        .test-result { font-size:10px; font-weight:700; padding:2px 7px; border-radius:999px; }
        .test-result.ok { color:#4ade80; }
        .test-result.fail { color:#f87171; }
        .empty { padding:18px 10px; color:var(--muted); text-align:center; border:1px dashed var(--border); border-radius:12px; font-size:12px; }
        .form-card { padding:14px; border:1px solid var(--border); border-radius:14px; background:rgba(255,255,255,.02); display:grid; gap:10px; }
        .form-title { font-size:12px; font-weight:700; color:var(--accent); }
        .field { display:grid; gap:4px; }
        .field label { font-size:10px; font-weight:700; color:var(--muted); text-transform:uppercase; letter-spacing:.06em; }
        .field input { background:var(--input-bg); border:1px solid var(--input-border); color:var(--text); border-radius:6px; padding:6px 8px; font:inherit; font-size:12px; outline:none; width:100%; }
        .field input:focus { border-color:var(--accent); }
        .secret-row { display:flex; gap:6px; }
        .secret-row input { flex:1; }
        .form-actions { display:flex; gap:8px; }
        .browser { display:grid; gap:6px; }
        .breadcrumb-row { display:flex; justify-content:space-between; align-items:center; gap:8px; flex-wrap:wrap; border:1px solid var(--border); border-radius:10px; padding:7px 10px; background:rgba(0,0,0,.06); }
        .breadcrumb { display:flex; align-items:center; gap:2px; flex-wrap:wrap; min-width:0; }
        .crumb { background:none; border:none; color:var(--muted); cursor:pointer; font:inherit; font-size:11px; padding:2px 4px; border-radius:4px; }
        .crumb:hover { color:var(--text); background:var(--surface2); }
        .crumb.active { color:var(--text); font-weight:700; cursor:default; }
        .crumb-sep { color:var(--muted); font-size:10px; margin:0 1px; }
        .browser-actions { display:flex; gap:6px; flex-shrink:0; }
        .browser-empty { padding:18px 10px; color:var(--muted); text-align:center; font-size:12px; }
        .error-text { color:#f87171; }
        .file-list { display:grid; gap:1px; border:1px solid var(--border); border-radius:10px; overflow:hidden; }
        .file-row { display:flex; align-items:center; gap:8px; padding:7px 10px; background:rgba(255,255,255,.015); font-size:12px; cursor:default; border-bottom:1px solid rgba(128,128,128,.08); }
        .file-row:last-child { border-bottom:none; }
        .file-row:hover { background:var(--surface2); }
        .folder-row { cursor:pointer; }
        .folder-row:hover .file-name { color:var(--accent); }
        .file-icon { font-size:14px; flex-shrink:0; }
        .file-name { flex:1; min-width:0; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
        .file-meta { font-size:10px; color:var(--muted); white-space:nowrap; flex-shrink:0; }
        .dl-btn { padding:2px 7px; font-size:11px; flex-shrink:0; }
        .upload-btn { background:rgba(110,231,183,.1); border-color:rgba(110,231,183,.24); color:#6ee7b7; }
      `}</style>

            <div className="toolbar">
                <button className="mini-button" onClick={() => post({ type: 'refresh' })} title="Refresh">↻</button>
                <button
                    className="button primary"
                    onClick={() => { setShowForm(true); setEditingId(null); }}
                >
                    + Add Bucket
                </button>
            </div>

            {!loaded && <div className="empty" style={{ margin: 12 }}>Loading…</div>}

            {loaded && (
                <div className="content">
                    {/* Add / Edit form */}
                    {showForm && (
                        <BucketForm
                            initial={editingBucket}
                            onSave={(config) => post({ type: 'addBucket', config })}
                            onCancel={() => { setShowForm(false); setEditingId(null); }}
                        />
                    )}

                    {/* Buckets section */}
                    <section className="section">
                        {buckets.length === 0 && !showForm ? (
                            <div className="empty">
                                No buckets yet.
                                <br />
                                <button className="button" style={{ marginTop: 10 }} onClick={() => setShowForm(true)}>
                                    Add your first bucket
                                </button>
                            </div>
                        ) : (
                            buckets.map((b) => {
                                const isActive = b.id === activeBucketId;
                                const tr = testResults[b.id];
                                return (
                                    <div key={b.id} className={`card${isActive ? ' active' : ''}`}>
                                        <div className="bucket-main">
                                            <div className="bucket-meta">
                                                <div className="bucket-name">{b.name}</div>
                                                <div className="bucket-sub">
                                                    <b>{b.bucket}</b> · {b.endpoint.replace('https://', '')}
                                                </div>
                                                {tr && (
                                                    <div className={`test-result ${tr.ok ? 'ok' : 'fail'}`}>
                                                        {tr.ok ? '✓ Connected' : `✕ ${tr.error ?? 'Failed'}`}
                                                    </div>
                                                )}
                                            </div>
                                            <div className="bucket-actions">
                                                <button
                                                    className="mini-button"
                                                    style={isActive ? { borderColor: 'rgba(110,231,183,.5)', color: '#6ee7b7' } : {}}
                                                    onClick={() => openBucket(b.id)}
                                                >
                                                    {isActive ? '▶ Open' : 'Browse'}
                                                </button>
                                                <button
                                                    className="mini-button"
                                                    onClick={() => {
                                                        setTestResults((r) => { const n = { ...r }; delete n[b.id]; return n; });
                                                        post({ type: 'testBucket', id: b.id });
                                                    }}
                                                >
                                                    Test
                                                </button>
                                                <button
                                                    className="mini-button"
                                                    onClick={() => { setEditingId(b.id); setShowForm(true); }}
                                                >
                                                    Edit
                                                </button>
                                                <button
                                                    className="mini-button"
                                                    onClick={() => {
                                                        post({ type: 'removeBucket', id: b.id });
                                                        if (activeBucketId === b.id) {
                                                            setActiveBucketId(null);
                                                            setBrowser(null);
                                                        }
                                                    }}
                                                >
                                                    Remove
                                                </button>
                                            </div>
                                        </div>
                                    </div>
                                );
                            })
                        )}
                    </section>

                    {/* File browser section */}
                    {browser && activeBucketId && (
                        <section className="section">
                            <div className="section-header">
                                <div className="section-title">
                                    {buckets.find((b) => b.id === activeBucketId)?.name ?? 'Browser'}
                                </div>
                            </div>
                            <FileBrowser
                                state={browser}
                                onNavigate={(prefix) => triggerList(activeBucketId, prefix)}
                                onDownload={(key) => post({ type: 'downloadFile', id: activeBucketId, key })}
                                onDownloadFolder={(prefix) => post({ type: 'downloadFolder', id: activeBucketId, prefix })}
                                onUpload={() => post({ type: 'uploadFiles', id: activeBucketId, prefix: browser.prefix })}
                                onRefresh={() => triggerList(activeBucketId, browser.prefix)}
                            />
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
