import React, { useEffect, useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';
import type {
  DbInboundMessage,
  DbInitialState,
  DbOutboundMessage,
  DbTable,
} from './dbTypes';

type TabKey = 'data' | 'structure' | 'query' | 'stats';

interface QueryState {
  columns: string[];
  rows: Record<string, unknown>[];
  changes?: number;
  error?: string;
}

interface SchemaState {
  tables: DbTable[];
  dbSize: number;
  sourceLabel: string;
  dbType: string;
}

function getInitialState(): DbInitialState {
  return (window as unknown as { __ultraviewWebviewState?: DbInitialState }).__ultraviewWebviewState ?? { dbType: 'Database' };
}

function getVscode() {
  return window.__vscodeApi as { postMessage: (message: DbOutboundMessage) => void } | undefined;
}

function formatBytes(bytes?: number): string {
  if (!bytes || bytes < 0) return '-';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

function formatValue(value: unknown): React.ReactNode {
  if (value === null || value === undefined) {
    return <span className="db-null">NULL</span>;
  }

  if (typeof value === 'boolean') {
    return <span className="db-bool">{String(value)}</span>;
  }

  if (typeof value === 'number') {
    return <span className="db-num">{value}</span>;
  }

  if (React.isValidElement(value)) {
    return value;
  }

  if (typeof value === 'object') {
    try {
      return JSON.stringify(value);
    } catch {
      return String(value);
    }
  }

  return String(value);
}

function App() {
  const initialState = getInitialState();
  const [schema, setSchema] = useState<SchemaState | null>(null);
  const [activeTableName, setActiveTableName] = useState<string>('');
  const [activeTab, setActiveTab] = useState<TabKey>('data');
  const [page, setPage] = useState(0);
  const [pageSize] = useState(200);
  const [tableRows, setTableRows] = useState<Record<string, unknown>[]>([]);
  const [tableColumns, setTableColumns] = useState<string[]>([]);
  const [tableRowCount, setTableRowCount] = useState<number | null>(null);
  const [tableError, setTableError] = useState<string>('');
  const [queryText, setQueryText] = useState('SELECT * FROM ');
  const [queryState, setQueryState] = useState<QueryState | null>(null);
  const [loadingSchema, setLoadingSchema] = useState(true);
  const [loadingTable, setLoadingTable] = useState(false);
  const [runningQuery, setRunningQuery] = useState(false);

  const activeTable = useMemo(
    () => schema?.tables.find((table) => table.name === activeTableName) ?? null,
    [schema, activeTableName]
  );

  useEffect(() => {
    getVscode()?.postMessage({ type: 'ready' });
  }, []);

  useEffect(() => {
    const handleMessage = (event: MessageEvent<DbInboundMessage>) => {
      const message = event.data;
      if (!message) return;

      if (message.type === 'schema') {
        const nextSchema: SchemaState = {
          tables: message.tables,
          dbSize: message.dbSize,
          sourceLabel: message.sourceLabel,
          dbType: message.dbType,
        };

        setSchema(nextSchema);
        setLoadingSchema(false);
        setTableError('');
        setQueryState(null);

        if (message.tables.length > 0) {
          const firstTable = message.tables[0].name;
          setActiveTableName((current) => current || firstTable);
          setQueryText((current) => (current === 'SELECT * FROM ' ? `SELECT * FROM "${firstTable}" LIMIT 100` : current));
        }
        return;
      }

      if (message.type === 'tableData') {
        setLoadingTable(false);
        setTableColumns(message.columns);
        setTableRows(message.rows);
        setTableRowCount(message.rowCount ?? null);
        setTableError('');
        return;
      }

      if (message.type === 'queryResult') {
        setRunningQuery(false);
        setQueryState({
          columns: message.columns ?? [],
          rows: message.rows ?? [],
          changes: message.changes,
        });
        return;
      }

      if (message.type === 'error') {
        setLoadingTable(false);
        setRunningQuery(false);
        if (activeTab === 'query') {
          setQueryState({
            columns: [],
            rows: [],
            error: message.message,
          });
        } else {
          setTableError(message.message);
        }
      }
    };

    window.addEventListener('message', handleMessage as EventListener);
    return () => window.removeEventListener('message', handleMessage as EventListener);
  }, [activeTab]);

  useEffect(() => {
    if (!schema || !activeTableName) return;
    setLoadingTable(true);
    setTableError('');
    getVscode()?.postMessage({
      type: 'getTableData',
      table: activeTableName,
      page,
      pageSize,
    });
  }, [schema, activeTableName, page, pageSize]);

  const totalPages = useMemo(() => {
    if (!tableRowCount || tableRowCount <= 0) return null;
    return Math.max(1, Math.ceil(tableRowCount / pageSize));
  }, [tableRowCount, pageSize]);

  const stats = useMemo(() => {
    const tables = schema?.tables ?? [];
    const knownRows = tables.reduce((sum, table) => sum + (table.rowCount ?? 0), 0);
    const knownTableCount = tables.filter((table) => typeof table.rowCount === 'number').length;
    return {
      tableCount: tables.length,
      knownRows,
      knownTableCount,
    };
  }, [schema]);

  const runQuery = () => {
    setActiveTab('query');
    setRunningQuery(true);
    setQueryState(null);
    getVscode()?.postMessage({ type: 'runQuery', sql: queryText });
  };

  const selectTable = (tableName: string) => {
    setActiveTableName(tableName);
    setPage(0);
    setTableRows([]);
    setTableColumns([]);
    setTableRowCount(null);
    setTableError('');
    setQueryText(`SELECT * FROM "${tableName}" LIMIT 100`);
  };

  const renderDataTable = (columns: string[], rows: Record<string, unknown>[]) => {
    if (rows.length === 0) {
      return <div className="db-empty">No rows to show.</div>;
    }

    const resolvedColumns = columns.length > 0 ? columns : Object.keys(rows[0] ?? {});

    return (
      <div className="db-table-scroll">
        <table className="db-table">
          <thead>
            <tr>
              {resolvedColumns.map((column) => (
                <th key={column}>{column}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row, rowIndex) => (
              <tr key={rowIndex}>
                {resolvedColumns.map((column) => (
                  <td key={`${rowIndex}-${column}`}>{formatValue(row[column])}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    );
  };

  return (
    <div className="db-app">
      <style>{`
        :root {
          --bg: var(--vscode-editor-background);
          --surface: var(--vscode-sideBar-background, color-mix(in srgb, var(--bg) 92%, black));
          --surface2: var(--vscode-list-hoverBackground, rgba(255,255,255,.05));
          --surface3: rgba(255,255,255,.03);
          --border: var(--vscode-panel-border, rgba(128,128,128,.24));
          --text: var(--vscode-editor-foreground);
          --muted: var(--vscode-descriptionForeground);
          --accent: var(--vscode-textLink-foreground, #7dd3fc);
          --success: var(--vscode-terminal-ansiGreen, #4ade80);
          --warn: var(--vscode-terminal-ansiYellow, #fbbf24);
          --danger: var(--vscode-errorForeground, #f87171);
          --code: var(--vscode-input-background, rgba(0,0,0,.16));
        }
        .db-app {
          display: grid;
          grid-template-columns: 260px minmax(0, 1fr);
          height: 100vh;
          background:
            radial-gradient(circle at top left, rgba(125,211,252,.08), transparent 34%),
            linear-gradient(180deg, color-mix(in srgb, var(--bg) 94%, black), var(--bg));
          color: var(--text);
        }
        .db-sidebar {
          display: flex;
          flex-direction: column;
          min-width: 0;
          border-right: 1px solid var(--border);
          background: linear-gradient(180deg, rgba(255,255,255,.03), rgba(255,255,255,.015));
        }
        .db-sidebar-header {
          padding: 14px 16px 12px;
          border-bottom: 1px solid var(--border);
          display: grid;
          gap: 6px;
        }
        .db-overline {
          font-size: 11px;
          letter-spacing: .09em;
          text-transform: uppercase;
          color: var(--muted);
          font-weight: 700;
        }
        .db-title {
          font-size: 15px;
          font-weight: 700;
        }
        .db-meta {
          display: grid;
          gap: 4px;
          padding: 12px 16px;
          font-size: 11px;
          color: var(--muted);
          border-bottom: 1px solid var(--border);
          background: rgba(255,255,255,.02);
        }
        .db-meta strong {
          color: var(--text);
          font-weight: 700;
        }
        .db-table-list {
          flex: 1;
          overflow: auto;
          padding: 8px;
          display: grid;
          gap: 6px;
        }
        .db-table-button {
          display: grid;
          grid-template-columns: minmax(0, 1fr) auto;
          gap: 8px;
          align-items: center;
          width: 100%;
          border: 1px solid transparent;
          border-radius: 12px;
          padding: 10px 12px;
          background: transparent;
          color: var(--text);
          cursor: pointer;
          text-align: left;
          transition: transform .14s ease, background .14s ease, border-color .14s ease;
        }
        .db-table-button:hover {
          background: var(--surface2);
          border-color: rgba(125,211,252,.2);
          transform: translateX(1px);
        }
        .db-table-button.active {
          background: linear-gradient(180deg, rgba(125,211,252,.14), rgba(125,211,252,.07));
          border-color: rgba(125,211,252,.35);
        }
        .db-table-name {
          min-width: 0;
          font-size: 12px;
          font-weight: 700;
          white-space: nowrap;
          overflow: hidden;
          text-overflow: ellipsis;
        }
        .db-table-count {
          font-size: 10px;
          color: var(--muted);
          padding: 2px 7px;
          border-radius: 999px;
          background: rgba(255,255,255,.05);
          border: 1px solid var(--border);
        }
        .db-main {
          display: flex;
          flex-direction: column;
          min-width: 0;
          min-height: 0;
        }
        .db-tabs {
          display: flex;
          gap: 4px;
          padding: 10px 12px 0;
          border-bottom: 1px solid var(--border);
          background: rgba(0,0,0,.08);
        }
        .db-tab {
          border: 1px solid transparent;
          border-bottom: none;
          border-radius: 12px 12px 0 0;
          padding: 9px 14px;
          background: transparent;
          color: var(--muted);
          cursor: pointer;
          font: inherit;
          font-size: 12px;
          transition: color .14s ease, background .14s ease, border-color .14s ease;
        }
        .db-tab:hover {
          color: var(--text);
          background: rgba(255,255,255,.03);
        }
        .db-tab.active {
          color: var(--accent);
          background: var(--bg);
          border-color: var(--border);
        }
        .db-pane {
          flex: 1;
          min-height: 0;
          display: flex;
          flex-direction: column;
        }
        .db-toolbar {
          display: flex;
          align-items: center;
          gap: 10px;
          padding: 10px 14px;
          border-bottom: 1px solid var(--border);
          background: rgba(255,255,255,.02);
        }
        .db-toolbar-title {
          font-size: 12px;
          font-weight: 700;
        }
        .db-toolbar-meta {
          margin-left: auto;
          color: var(--muted);
          font-size: 11px;
        }
        .db-button {
          border: 1px solid var(--border);
          border-radius: 10px;
          padding: 6px 10px;
          background: var(--surface2);
          color: var(--text);
          cursor: pointer;
          font: inherit;
          font-size: 11px;
          transition: transform .14s ease, border-color .14s ease, background .14s ease;
        }
        .db-button:hover:not(:disabled) {
          transform: translateY(-1px);
          background: color-mix(in srgb, var(--surface2) 75%, white 5%);
          border-color: rgba(125,211,252,.35);
        }
        .db-button:disabled {
          opacity: .45;
          cursor: default;
        }
        .db-content {
          flex: 1;
          min-height: 0;
          overflow: auto;
        }
        .db-table-scroll {
          overflow: auto;
          height: 100%;
        }
        .db-table {
          width: 100%;
          border-collapse: collapse;
          font-size: 12px;
        }
        .db-table thead th {
          position: sticky;
          top: 0;
          z-index: 1;
          background: color-mix(in srgb, var(--surface) 82%, var(--bg));
          color: var(--accent);
          text-align: left;
          padding: 9px 12px;
          border-bottom: 1px solid var(--border);
          white-space: nowrap;
        }
        .db-table tbody tr:nth-child(even) {
          background: var(--surface3);
        }
        .db-table tbody tr:hover {
          background: rgba(125,211,252,.06);
        }
        .db-table td {
          padding: 8px 12px;
          border-bottom: 1px solid var(--border);
          max-width: 360px;
          white-space: nowrap;
          overflow: hidden;
          text-overflow: ellipsis;
          vertical-align: top;
        }
        .db-pagination {
          display: flex;
          align-items: center;
          gap: 10px;
          padding: 10px 14px;
          border-top: 1px solid var(--border);
          background: rgba(0,0,0,.08);
          color: var(--muted);
          font-size: 11px;
        }
        .db-pagination-spacer {
          flex: 1;
        }
        .db-panel {
          padding: 16px;
          overflow: auto;
          display: grid;
          gap: 14px;
        }
        .db-card {
          border: 1px solid var(--border);
          border-radius: 16px;
          background: linear-gradient(180deg, rgba(255,255,255,.03), rgba(255,255,255,.015));
          padding: 14px;
          display: grid;
          gap: 10px;
        }
        .db-card-title {
          font-size: 12px;
          font-weight: 700;
          color: var(--muted);
          text-transform: uppercase;
          letter-spacing: .08em;
        }
        .db-grid {
          display: grid;
          gap: 14px;
          grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
        }
        .db-stat-value {
          font-size: 24px;
          font-weight: 800;
          color: var(--accent);
        }
        .db-stat-sub {
          font-size: 11px;
          color: var(--muted);
        }
        .db-query-area {
          width: 100%;
          min-height: 120px;
          resize: vertical;
          border: none;
          border-top: 1px solid var(--border);
          border-bottom: 1px solid var(--border);
          padding: 14px;
          background: var(--code);
          color: var(--text);
          font: 12px/1.6 Consolas, 'Cascadia Code', monospace;
          outline: none;
        }
        .db-status {
          padding: 10px 14px;
          font-size: 11px;
          color: var(--muted);
          border-bottom: 1px solid var(--border);
        }
        .db-status.error {
          color: var(--danger);
        }
        .db-status.success {
          color: var(--success);
        }
        .db-empty {
          margin: 18px;
          padding: 20px;
          text-align: center;
          color: var(--muted);
          border: 1px dashed var(--border);
          border-radius: 14px;
        }
        .db-null {
          color: var(--muted);
          font-style: italic;
        }
        .db-num {
          color: var(--accent);
        }
        .db-bool {
          color: var(--success);
        }
        .db-badges {
          display: flex;
          gap: 6px;
          flex-wrap: wrap;
        }
        .db-badge {
          padding: 2px 8px;
          border-radius: 999px;
          font-size: 10px;
          font-weight: 700;
          border: 1px solid transparent;
        }
        .db-badge.pk {
          color: var(--accent);
          background: rgba(125,211,252,.12);
          border-color: rgba(125,211,252,.28);
        }
        .db-badge.nn {
          color: var(--danger);
          background: rgba(248,113,113,.12);
          border-color: rgba(248,113,113,.26);
        }
      `}</style>

      <aside className="db-sidebar">
        <div className="db-sidebar-header">
          <div className="db-overline">Ultraview Data</div>
          <div className="db-title">{schema?.dbType ?? initialState.dbType}</div>
        </div>

        <div className="db-meta">
          <div>Size: <strong>{formatBytes(schema?.dbSize)}</strong></div>
          <div>Tables: <strong>{schema?.tables.length ?? 0}</strong></div>
        </div>

        <div className="db-table-list">
          {loadingSchema && <div className="db-empty">Loading schema...</div>}
          {!loadingSchema && (schema?.tables.length ?? 0) === 0 && <div className="db-empty">No tables available.</div>}
          {schema?.tables.map((table) => (
            <button
              key={table.name}
              className={`db-table-button${table.name === activeTableName ? ' active' : ''}`}
              onClick={() => selectTable(table.name)}
            >
              <span className="db-table-name">{table.name}</span>
              <span className="db-table-count">{table.rowCount ?? '-'}</span>
            </button>
          ))}
        </div>
      </aside>

      <main className="db-main">
        <div className="db-tabs">
          {(['data', 'structure', 'query', 'stats'] as TabKey[]).map((tab) => (
            <button
              key={tab}
              className={`db-tab${tab === activeTab ? ' active' : ''}`}
              onClick={() => setActiveTab(tab)}
            >
              {tab === 'data' ? 'Data' : tab === 'structure' ? 'Structure' : tab === 'query' ? 'Query' : 'Stats'}
            </button>
          ))}
        </div>

        {activeTab === 'data' && (
          <section className="db-pane">
            <div className="db-toolbar">
              <div className="db-toolbar-title">{activeTableName || 'Select a table'}</div>
              <div className="db-toolbar-meta">
                {tableRowCount !== null ? `${tableRowCount} rows` : activeTable?.rowCount ?? 0} total
              </div>
            </div>
            <div className="db-content">
              {tableError ? (
                <div className="db-empty">{tableError}</div>
              ) : loadingTable ? (
                <div className="db-empty">Loading rows...</div>
              ) : !activeTableName ? (
                <div className="db-empty">Select a table to begin.</div>
              ) : (
                renderDataTable(tableColumns, tableRows)
              )}
            </div>
            <div className="db-pagination">
              <span>Page {page + 1}{totalPages ? ` of ${totalPages}` : ''}</span>
              <span className="db-pagination-spacer" />
              <button className="db-button" disabled={page <= 0 || loadingTable} onClick={() => setPage((current) => Math.max(0, current - 1))}>Prev</button>
              <button
                className="db-button"
                disabled={loadingTable || (totalPages !== null ? page + 1 >= totalPages : tableRows.length < pageSize)}
                onClick={() => setPage((current) => current + 1)}
              >
                Next
              </button>
            </div>
          </section>
        )}

        {activeTab === 'structure' && (
          <section className="db-pane">
            <div className="db-panel">
              {!activeTable ? (
                <div className="db-empty">Select a table to inspect its structure.</div>
              ) : (
                <div className="db-card">
                  <div className="db-card-title">{activeTable.name} Columns</div>
                  {activeTable.columns.length === 0 ? (
                    <div className="db-empty" style={{ margin: 0 }}>No column metadata available.</div>
                  ) : (
                    renderDataTable(
                      ['name', 'type', 'flags'],
                      activeTable.columns.map((column) => ({
                        name: column.name,
                        type: column.type || 'TEXT',
                        flags: (
                          <div className="db-badges">
                            {column.pk ? <span className="db-badge pk">PK</span> : null}
                            {column.notnull ? <span className="db-badge nn">NOT NULL</span> : null}
                          </div>
                        ),
                      }))
                    )
                  )}
                </div>
              )}
            </div>
          </section>
        )}

        {activeTab === 'query' && (
          <section className="db-pane">
            <div className="db-toolbar">
              <div className="db-toolbar-title">SQL Query</div>
              <button className="db-button" onClick={runQuery} disabled={runningQuery || !queryText.trim()}>
                {runningQuery ? 'Running...' : 'Run Query'}
              </button>
            </div>
            <textarea
              className="db-query-area"
              value={queryText}
              onChange={(event) => setQueryText(event.target.value)}
              onKeyDown={(event) => {
                if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {
                  event.preventDefault();
                  runQuery();
                }
              }}
              spellCheck={false}
            />
            {queryState && (
              <div className={`db-status${queryState.error ? ' error' : ' success'}`}>
                {queryState.error
                  ? queryState.error
                  : queryState.changes !== undefined
                    ? `Query completed. ${queryState.changes} change(s).`
                    : `Returned ${queryState.rows.length} row(s).`}
              </div>
            )}
            <div className="db-content">
              {!queryState ? (
                <div className="db-empty">Run a query to inspect results here.</div>
              ) : queryState.error ? (
                <div className="db-empty">{queryState.error}</div>
              ) : (
                renderDataTable(queryState.columns, queryState.rows)
              )}
            </div>
          </section>
        )}

        {activeTab === 'stats' && (
          <section className="db-pane">
            <div className="db-panel">
              <div className="db-grid">
                <div className="db-card">
                  <div className="db-card-title">Database</div>
                  <div className="db-stat-value">{schema?.dbType ?? initialState.dbType}</div>
                  <div className="db-stat-sub">Current viewer type</div>
                </div>
                <div className="db-card">
                  <div className="db-card-title">Tables</div>
                  <div className="db-stat-value">{stats.tableCount}</div>
                  <div className="db-stat-sub">Detected tables or preview groups</div>
                </div>
                <div className="db-card">
                  <div className="db-card-title">Known Rows</div>
                  <div className="db-stat-value">{stats.knownRows}</div>
                  <div className="db-stat-sub">
                    {stats.knownTableCount === stats.tableCount ? 'Based on all tables' : 'Only tables with available counts'}
                  </div>
                </div>
                <div className="db-card">
                  <div className="db-card-title">Source Size</div>
                  <div className="db-stat-value">{formatBytes(schema?.dbSize)}</div>
                  <div className="db-stat-sub">Available when the source reports a size</div>
                </div>
              </div>

              <div className="db-card">
                <div className="db-card-title">Source</div>
                <div>{schema?.sourceLabel ?? initialState.sourceLabel ?? 'Loading...'}</div>
              </div>
            </div>
          </section>
        )}
      </main>
    </div>
  );
}

const loadingEl = document.getElementById('loading');
if (loadingEl) {
  loadingEl.remove();
}

const root = createRoot(document.getElementById('app')!);
root.render(<App />);
