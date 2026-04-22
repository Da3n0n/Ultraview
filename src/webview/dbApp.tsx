import React, { useEffect, useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';
import type {
  DbInboundMessage,
  DbInitialState,
  DbOutboundMessage,
  DbTable,
} from './dbTypes';

type TabKey = 'data' | 'structure' | 'query';

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
  dbName?: string;
  canEditData?: boolean;
  canEditSchema?: boolean;
}

interface CreateColumnDraft {
  name: string;
  type: string;
  notnull: boolean;
  primaryKey: boolean;
  defaultValue: string;
}

interface ColumnDraft extends CreateColumnDraft {
  originalName: string;
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

function stringifyEditorValue(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function parseInputValue(value: string): unknown {
  const trimmed = value.trim();
  if (!trimmed) return '';
  if (trimmed.toUpperCase() === 'NULL') return '__UV_NULL__';
  if (trimmed === 'true') return true;
  if (trimmed === 'false') return false;
  if (!Number.isNaN(Number(trimmed)) && trimmed !== '') return Number(trimmed);
  if ((trimmed.startsWith('{') && trimmed.endsWith('}')) || (trimmed.startsWith('[') && trimmed.endsWith(']'))) {
    try {
      return JSON.parse(trimmed);
    } catch {
      return value;
    }
  }
  return value;
}

function deriveDbName(dbType: string, sourceLabel?: string): string {
  if (!sourceLabel) return dbType;
  const normalized = sourceLabel.replace(/\\/g, '/').trim();
  const parts = normalized.split('/').map((part) => part.trim()).filter(Boolean);
  return parts[parts.length - 1] || normalized || dbType;
}

function emptyColumnDraft(): CreateColumnDraft {
  return {
    name: '',
    type: 'text',
    notnull: false,
    primaryKey: false,
    defaultValue: '',
  };
}

function makeColumnDraft(column: DbTable['columns'][number]): ColumnDraft {
  return {
    originalName: column.name,
    name: column.name,
    type: column.type || 'text',
    notnull: !!column.notnull,
    primaryKey: !!column.pk,
    defaultValue: column.defaultValue ? String(column.defaultValue) : '',
  };
}

const COMMON_COLUMN_TYPES = ['text', 'integer', 'bigint', 'numeric', 'real', 'boolean', 'date', 'timestamp', 'json', 'jsonb', 'uuid', 'varchar(255)'];

function App() {
  const initialState = getInitialState();
  const [schema, setSchema] = useState<SchemaState | null>(null);
  const [activeTableName, setActiveTableName] = useState<string>('');
  const [activeTab, setActiveTab] = useState<TabKey>('data');
  const [pageSize] = useState(200);
  const [requestedPage, setRequestedPage] = useState(0);
  const [loadedPages, setLoadedPages] = useState<number[]>([]);
  const [tableRows, setTableRows] = useState<Record<string, unknown>[]>([]);
  const [tableColumns, setTableColumns] = useState<string[]>([]);
  const [tableRowIds, setTableRowIds] = useState<string[]>([]);
  const [tableRowCount, setTableRowCount] = useState<number | null>(null);
  const [tableError, setTableError] = useState<string>('');
  const [queryText, setQueryText] = useState('SELECT * FROM ');
  const [queryState, setQueryState] = useState<QueryState | null>(null);
  const [loadingSchema, setLoadingSchema] = useState(true);
  const [loadingTable, setLoadingTable] = useState(false);
  const [runningQuery, setRunningQuery] = useState(false);
  const [savingAction, setSavingAction] = useState(false);
  const [actionMessage, setActionMessage] = useState<string>('');
  const [editingCell, setEditingCell] = useState<{ rowIndex: number; column: string } | null>(null);
  const [editingValue, setEditingValue] = useState('');
  const [newRowValues, setNewRowValues] = useState<Record<string, string>>({});
  const [showCreateTable, setShowCreateTable] = useState(false);
  const [createTableName, setCreateTableName] = useState('');
  const [createTableColumns, setCreateTableColumns] = useState<CreateColumnDraft[]>([emptyColumnDraft()]);
  const [columnDrafts, setColumnDrafts] = useState<ColumnDraft[]>([]);
  const [newColumnDraft, setNewColumnDraft] = useState<CreateColumnDraft>(emptyColumnDraft());

  const activeTable = useMemo(
    () => schema?.tables.find((table) => table.name === activeTableName) ?? null,
    [schema, activeTableName]
  );
  const dbName =
    schema?.dbName ??
    initialState.dbName ??
    deriveDbName(
      schema?.dbType ?? initialState.dbType,
      schema?.sourceLabel ?? initialState.sourceLabel
    );
  const canEditData = schema?.canEditData ?? initialState.canEditData ?? false;
  const canEditSchema = schema?.canEditSchema ?? initialState.canEditSchema ?? false;

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
          dbName: message.dbName,
          canEditData: message.canEditData,
          canEditSchema: message.canEditSchema,
        };

        setSchema(nextSchema);
        setLoadingSchema(false);
        setTableError('');
        setQueryState(null);

        if (message.tables.length > 0) {
          const firstTable = message.tables[0].name;
          setActiveTableName((current) =>
            current && message.tables.some((table) => table.name === current) ? current : firstTable
          );
          setQueryText((current) => (current === 'SELECT * FROM ' ? `SELECT * FROM "${firstTable}" LIMIT 100` : current));
        } else {
          setActiveTableName('');
        }
        setShowCreateTable(false);
        return;
      }

      if (message.type === 'tableData') {
        setLoadingTable(false);
        setSavingAction(false);
        setTableColumns((current) => (message.page === 0 || current.length === 0 ? message.columns : current));
        if (message.page === 0) {
          setTableRows(message.rows);
          setTableRowIds(message.rowIds ?? []);
          setLoadedPages([0]);
        } else {
          setTableRows((current) => [...current, ...message.rows]);
          setTableRowIds((current) => [...current, ...(message.rowIds ?? [])]);
          setLoadedPages((current) => (current.includes(message.page) ? current : [...current, message.page]));
        }
        setTableRowCount(message.rowCount ?? null);
        setTableError('');
        setEditingCell(null);
        return;
      }

      if (message.type === 'queryResult') {
        setRunningQuery(false);
        setSavingAction(false);
        setQueryState({
          columns: message.columns ?? [],
          rows: message.rows ?? [],
          changes: message.changes,
        });
        return;
      }

      if (message.type === 'actionComplete') {
        setSavingAction(false);
        setActionMessage(message.message);
        if (activeTableName) {
          setLoadingTable(true);
          setRequestedPage(0);
          setLoadedPages([]);
          setTableRows([]);
          setTableRowIds([]);
          setTableColumns([]);
          getVscode()?.postMessage({
            type: 'getTableData',
            table: activeTableName,
            page: 0,
            pageSize,
          });
        }
        return;
      }

      if (message.type === 'error') {
        setLoadingTable(false);
        setRunningQuery(false);
        setSavingAction(false);
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
  }, [activeTab, activeTableName, pageSize]);

  useEffect(() => {
    if (!schema || !activeTableName) return;
    setLoadingTable(true);
    setTableError('');
    if (requestedPage === 0) {
      setTableRows([]);
      setTableColumns([]);
      setTableRowIds([]);
      setLoadedPages([]);
    }
    getVscode()?.postMessage({
      type: 'getTableData',
      table: activeTableName,
      page: requestedPage,
      pageSize,
    });
  }, [schema, activeTableName, requestedPage, pageSize]);

  useEffect(() => {
    setNewRowValues({});
    setEditingCell(null);
    setEditingValue('');
  }, [activeTableName]);

  useEffect(() => {
    setColumnDrafts(activeTable?.columns.map(makeColumnDraft) ?? []);
    setNewColumnDraft(emptyColumnDraft());
  }, [activeTable]);

  useEffect(() => {
    if (!actionMessage) return;
    const timer = window.setTimeout(() => setActionMessage(''), 2600);
    return () => window.clearTimeout(timer);
  }, [actionMessage]);

  const totalPages = useMemo(() => {
    if (!tableRowCount || tableRowCount <= 0) return null;
    return Math.max(1, Math.ceil(tableRowCount / pageSize));
  }, [tableRowCount, pageSize]);

  const hasMoreRows = useMemo(() => {
    if (tableRowCount === null) {
      return tableRows.length >= pageSize;
    }
    return tableRows.length < tableRowCount;
  }, [pageSize, tableRowCount, tableRows.length]);

  const runQuery = () => {
    setActiveTab('query');
    setRunningQuery(true);
    setQueryState(null);
    setActionMessage('');
    getVscode()?.postMessage({ type: 'runQuery', sql: queryText });
  };

  const loadMoreRows = () => {
    if (loadingTable || !activeTableName || !hasMoreRows) {
      return;
    }
    setRequestedPage((current) => current + 1);
  };

  const selectTable = (tableName: string) => {
    setActiveTableName(tableName);
    setShowCreateTable(false);
    setRequestedPage(0);
    setLoadedPages([]);
    setTableRows([]);
    setTableColumns([]);
    setTableRowIds([]);
    setTableRowCount(null);
    setTableError('');
    setActionMessage('');
    setQueryText(`SELECT * FROM "${tableName}" LIMIT 100`);
  };

  const beginCellEdit = (rowIndex: number, column: string, value: unknown) => {
    if (!canEditData) return;
    setEditingCell({ rowIndex, column });
    setEditingValue(stringifyEditorValue(value));
  };

  const saveCellEdit = () => {
    if (!editingCell || !activeTableName) return;
    const rowId = tableRowIds[editingCell.rowIndex];
    if (!rowId) return;
    setSavingAction(true);
    setActionMessage('');
    getVscode()?.postMessage({
      type: 'updateCell',
      table: activeTableName,
      rowId,
      column: editingCell.column,
      value: parseInputValue(editingValue),
    });
  };

  const deleteRow = (rowIndex: number) => {
    if (!activeTableName) return;
    const rowId = tableRowIds[rowIndex];
    if (!rowId) return;
    setSavingAction(true);
    setActionMessage('');
    getVscode()?.postMessage({
      type: 'deleteRow',
      table: activeTableName,
      rowId,
    });
  };

  const insertRow = () => {
    if (!activeTableName) return;
    const values = Object.fromEntries(
      Object.entries(newRowValues)
        .filter(([, value]) => value.trim() !== '')
        .map(([column, value]) => [column, parseInputValue(value)])
    );
    setSavingAction(true);
    setActionMessage('');
    getVscode()?.postMessage({
      type: 'insertRow',
      table: activeTableName,
      values,
    });
    setNewRowValues({});
  };

  const createTable = () => {
    const tableName = createTableName.trim();
    const columns = createTableColumns
      .filter((column) => column.name.trim() && column.type.trim())
      .map((column) => ({
        name: column.name.trim(),
        type: column.type.trim(),
        notnull: column.notnull,
        primaryKey: column.primaryKey,
        defaultValue: column.defaultValue.trim(),
      }));

    if (!tableName || columns.length === 0) {
      setTableError('Provide a table name and at least one column.');
      return;
    }

    setSavingAction(true);
    setActionMessage('');
    getVscode()?.postMessage({
      type: 'createTable',
      tableName,
      columns,
    });
    setShowCreateTable(false);
    setCreateTableName('');
    setCreateTableColumns([emptyColumnDraft()]);
  };

  const addColumn = () => {
    if (!activeTableName) return;
    if (!newColumnDraft.name.trim() || !newColumnDraft.type.trim()) {
      setTableError('Column name and type are required.');
      return;
    }
    setSavingAction(true);
    setActionMessage('');
    getVscode()?.postMessage({
      type: 'addColumn',
      table: activeTableName,
      column: {
        name: newColumnDraft.name.trim(),
        type: newColumnDraft.type.trim(),
        notnull: newColumnDraft.notnull,
        defaultValue: newColumnDraft.defaultValue.trim(),
      },
    });
    setNewColumnDraft(emptyColumnDraft());
  };

  const updateColumn = (draft: ColumnDraft) => {
    if (!activeTableName) return;
    if (!draft.name.trim() || !draft.type.trim()) {
      setTableError('Column name and type are required.');
      return;
    }
    setSavingAction(true);
    setActionMessage('');
    getVscode()?.postMessage({
      type: 'updateColumn',
      table: activeTableName,
      column: draft.originalName,
      next: {
        name: draft.name.trim(),
        type: draft.type.trim(),
        notnull: draft.notnull,
        defaultValue: draft.defaultValue.trim(),
      },
    });
  };

  const renderDataTable = (columns: string[], rows: Record<string, unknown>[], editable = false) => {
    if (rows.length === 0 && !editable) {
      return <div className="db-empty">No rows to show.</div>;
    }
    if (rows.length === 0 && editable && columns.length === 0) {
      return <div className="db-empty">No columns to show.</div>;
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
              {editable ? <th className="db-actions-col">Actions</th> : null}
            </tr>
          </thead>
          <tbody>
            {rows.map((row, rowIndex) => (
              <tr key={tableRowIds[rowIndex] || rowIndex}>
                {resolvedColumns.map((column) => {
                  const isEditing = editingCell?.rowIndex === rowIndex && editingCell?.column === column;
                  return (
                    <td
                      key={`${rowIndex}-${column}`}
                      className={editable ? 'db-cell-editable' : ''}
                      onDoubleClick={() => beginCellEdit(rowIndex, column, row[column])}
                    >
                      {isEditing ? (
                        <div className="db-inline-edit">
                          <input
                            className="db-input"
                            value={editingValue}
                            onChange={(event) => setEditingValue(event.target.value)}
                            autoFocus
                            onKeyDown={(event) => {
                              if (event.key === 'Enter') {
                                event.preventDefault();
                                saveCellEdit();
                              }
                              if (event.key === 'Escape') {
                                setEditingCell(null);
                              }
                            }}
                          />
                          <button className="db-button" onClick={saveCellEdit} disabled={savingAction}>Save</button>
                          <button className="db-button" onClick={() => setEditingCell(null)} disabled={savingAction}>Cancel</button>
                        </div>
                      ) : (
                        formatValue(row[column])
                      )}
                    </td>
                  );
                })}
                {editable ? (
                  <td className="db-actions-cell">
                    <button className="db-button danger" onClick={() => deleteRow(rowIndex)} disabled={savingAction}>
                      Delete
                    </button>
                  </td>
                ) : null}
              </tr>
            ))}
            {editable ? (
              <tr className="db-new-row">
                {resolvedColumns.map((column) => (
                  <td key={`new-${column}`}>
                    <input
                      className="db-input db-inline-input"
                      value={newRowValues[column] ?? ''}
                      onChange={(event) =>
                        setNewRowValues((current) => ({ ...current, [column]: event.target.value }))
                      }
                      placeholder="NULL / value"
                    />
                  </td>
                ))}
                <td className="db-actions-cell">
                  <button className="db-button" onClick={insertRow} disabled={savingAction}>
                    Add
                  </button>
                </td>
              </tr>
            ) : null}
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
          --surface: var(--vscode-sideBar-background, var(--bg));
          --surface2: var(--vscode-sideBar-background, var(--surface));
          --surface3: var(--vscode-sideBar-background, var(--surface));
          --border: var(--vscode-panel-border, rgba(128,128,128,.24));
          --text: var(--vscode-editor-foreground);
          --muted: var(--vscode-descriptionForeground);
          --accent: var(--vscode-foreground, var(--text));
          --success: var(--vscode-foreground, var(--text));
          --warn: var(--vscode-foreground, var(--text));
          --danger: var(--vscode-errorForeground, var(--text));
          --code: var(--vscode-input-background, rgba(0,0,0,.16));
        }
        .db-app {
          display: grid;
          grid-template-columns: 260px minmax(0, 1fr);
          height: 100vh;
          background: var(--bg);
          color: var(--text);
        }
        .db-sidebar {
          display: flex;
          flex-direction: column;
          min-width: 0;
          min-height: 0;
          border-right: 1px solid var(--border);
          background: var(--vscode-sideBar-background, var(--surface));
        }
        .db-sidebar-header {
          padding: 14px 16px 12px;
          border-bottom: 1px solid var(--border);
          display: grid;
          gap: 6px;
          background: var(--vscode-sideBar-background, var(--surface));
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
          background: var(--vscode-sideBarSectionHeader-background, var(--vscode-sideBar-background, var(--surface)));
        }
        .db-meta strong {
          color: var(--text);
          font-weight: 700;
        }
        .db-table-list {
          flex: 1;
          min-height: 0;
          overflow: auto;
          padding: 8px;
          display: grid;
          align-content: start;
          gap: 6px;
        }
        .db-sidebar-footer {
          padding: 10px 8px 12px;
          border-top: 1px solid var(--border);
          display: grid;
          gap: 8px;
          background: var(--vscode-sideBar-background, var(--surface));
        }
        .db-table-button {
          display: grid;
          grid-template-columns: minmax(0, 1fr) auto auto;
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
          background: var(--vscode-list-hoverBackground, var(--surface2));
          border-color: var(--border);
          transform: translateX(1px);
        }
        .db-table-button.active {
          background: var(--vscode-list-activeSelectionBackground, var(--surface2));
          border-color: var(--border);
          color: var(--vscode-list-activeSelectionForeground, var(--text));
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
        .db-table-delete {
          opacity: .7;
          border: none;
          background: transparent;
          color: var(--muted);
          cursor: pointer;
          padding: 2px 4px;
          border-radius: 8px;
          font-size: 12px;
          line-height: 1;
        }
        .db-table-delete:hover {
          opacity: 1;
          color: var(--danger);
          background: rgba(248,113,113,.08);
        }
        .db-main {
          display: flex;
          flex-direction: column;
          min-width: 0;
          min-height: 0;
          background: var(--bg);
        }
        .db-tabs {
          display: flex;
          gap: 4px;
          padding: 10px 12px 0;
          border-bottom: 1px solid var(--border);
          background: var(--bg);
        }
        .db-tab {
          position: relative;
          border: 1px solid transparent;
          border-bottom: none;
          border-radius: 8px 8px 0 0;
          padding: 7px 12px;
          min-height: 34px;
          background: var(--vscode-tab-inactiveBackground, var(--surface));
          color: var(--vscode-tab-inactiveForeground, var(--text));
          cursor: pointer;
          font: inherit;
          font-size: 12px;
          font-weight: 600;
          transition: all .16s ease;
        }
        .db-tab::after {
          content: '';
          position: absolute;
          left: 0;
          right: 0;
          bottom: -1px;
          height: 1px;
          background: var(--vscode-editorGroupHeader-tabsBackground, var(--surface));
        }
        .db-tab:hover {
          background: var(--vscode-tab-hoverBackground, var(--vscode-tab-inactiveBackground, var(--surface)));
          color: var(--vscode-tab-hoverForeground, var(--vscode-tab-inactiveForeground, var(--text)));
        }
        .db-tab.active {
          color: var(--vscode-tab-activeForeground, var(--text));
          background: var(--bg);
          border-color: var(--vscode-tab-border, var(--border));
          border-bottom-color: var(--vscode-tab-activeBackground, var(--bg));
        }
        .db-tab.active::before {
          content: '';
          position: absolute;
          left: 0;
          right: 0;
          top: 0;
          height: 2px;
          background: var(--vscode-tab-activeBorderTop, var(--vscode-tab-activeBorder, transparent));
          border-radius: 8px 8px 0 0;
        }
        .db-tab.active::after {
          display: none;
        }
        .db-pane {
          flex: 1;
          min-height: 0;
          display: flex;
          flex-direction: column;
        }
        .db-button {
          border: 1px solid var(--border);
          border-radius: 10px;
          padding: 6px 10px;
          background: var(--surface);
          color: var(--text);
          cursor: pointer;
          font: inherit;
          font-size: 11px;
          transition: transform .14s ease, border-color .14s ease, background .14s ease;
        }
        .db-button:hover:not(:disabled) {
          transform: translateY(-1px);
          background: var(--surface);
          border-color: var(--border);
        }
        .db-button:disabled {
          opacity: .45;
          cursor: default;
        }
        .db-button.danger:hover:not(:disabled) {
          border-color: var(--border);
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
          background: var(--surface);
          color: var(--text);
          text-align: left;
          padding: 9px 12px;
          border-bottom: 1px solid var(--border);
          white-space: nowrap;
        }
        .db-table tbody tr:nth-child(even) {
          background: var(--surface);
        }
        .db-table tbody tr:hover {
          background: var(--surface);
        }
        .db-table tbody tr.db-new-row {
          background: var(--surface);
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
        .db-actions-col,
        .db-actions-cell {
          width: 1%;
          white-space: nowrap;
        }
        .db-cell-editable {
          cursor: text;
        }
        .db-inline-edit {
          display: flex;
          gap: 8px;
          align-items: center;
        }
        .db-inline-input {
          min-width: 120px;
        }
        .db-new-row .db-input {
          background: transparent;
          border-color: transparent;
          box-shadow: none;
        }
        .db-new-row .db-input::placeholder {
          color: transparent;
        }
        .db-new-row .db-input:hover,
        .db-new-row .db-input:focus {
          background: var(--surface);
          border-color: var(--border);
        }
        .db-new-row .db-input:focus::placeholder {
          color: var(--muted);
        }
        .db-new-row .db-button {
          opacity: 0;
          pointer-events: none;
        }
        .db-new-row:focus-within .db-button {
          opacity: 1;
          pointer-events: auto;
        }
        .db-pagination {
          display: flex;
          align-items: center;
          flex-wrap: wrap;
          gap: 10px;
          padding: 10px 14px;
          border-top: 1px solid var(--border);
          background: var(--surface);
          color: var(--muted);
          font-size: 11px;
        }
        .db-pagination-count {
          color: var(--text);
          font-weight: 600;
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
          background: var(--surface);
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
          color: var(--text);
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
          background: var(--surface);
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
          color: var(--text);
        }
        .db-bool {
          color: var(--text);
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
          color: var(--text);
          background: var(--vscode-badge-background, var(--surface2));
          border-color: var(--border);
        }
        .db-badge.nn {
          color: var(--text);
          background: var(--vscode-badge-background, var(--surface2));
          border-color: var(--border);
        }
        .db-form-grid {
          display: grid;
          gap: 10px;
          grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
        }
        .db-form-grid.compact {
          grid-template-columns: repeat(auto-fit, minmax(130px, 1fr));
        }
        .db-field {
          display: grid;
          gap: 6px;
        }
        .db-field-label {
          font-size: 11px;
          color: var(--muted);
          font-weight: 600;
        }
        .db-input {
          width: 100%;
          box-sizing: border-box;
          border: 1px solid var(--border);
          border-radius: 10px;
          padding: 8px 10px;
          background: var(--surface);
          color: var(--text);
          font: inherit;
        }
        .db-select {
          width: 100%;
          box-sizing: border-box;
          border: 1px solid var(--border);
          border-radius: 10px;
          padding: 8px 10px;
          background: var(--surface);
          color: var(--text);
          font: inherit;
        }
        .db-check-row {
          display: flex;
          gap: 12px;
          flex-wrap: wrap;
          align-items: center;
        }
        .db-check {
          display: inline-flex;
          align-items: center;
          gap: 6px;
          font-size: 11px;
          color: var(--muted);
        }
        .db-stack {
          display: grid;
          gap: 10px;
        }
        .db-column-draft {
          border: 1px solid var(--border);
          border-radius: 12px;
          padding: 12px;
          background: var(--surface);
          display: grid;
          gap: 10px;
        }
        @media (max-height: 780px) {
          .db-sidebar-header {
            padding: 12px 14px 10px;
          }
          .db-meta {
            padding: 10px 14px;
          }
          .db-table-list {
            padding: 6px;
            gap: 4px;
          }
          .db-table-button {
            padding: 8px 10px;
            border-radius: 10px;
          }
        }
        @media (max-width: 900px) {
          .db-app {
            grid-template-columns: 220px minmax(0, 1fr);
          }
        }
        @media (max-width: 700px) {
          .db-app {
            grid-template-columns: 180px minmax(0, 1fr);
          }
          .db-sidebar-header {
            padding: 10px 12px 8px;
          }
          .db-title {
            font-size: 13px;
          }
          .db-overline {
            font-size: 10px;
          }
          .db-meta {
            padding: 8px 12px;
            font-size: 10px;
          }
          .db-table-button {
            padding: 8px 9px;
          }
          .db-table-name {
            font-size: 11px;
          }
        }
      `}</style>

      <aside className="db-sidebar">
        <div className="db-sidebar-header">
          <div className="db-title">{dbName}</div>
          <div className="db-overline">{schema?.dbType ?? initialState.dbType}</div>
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
              {canEditSchema ? (
                <span
                  className="db-table-delete"
                  onClick={(event) => {
                    event.stopPropagation();
                    setSavingAction(true);
                    setActionMessage('');
                    getVscode()?.postMessage({ type: 'deleteTable', table: table.name });
                  }}
                  role="button"
                  aria-label={`Delete ${table.name}`}
                >
                  ×
                </span>
              ) : null}
            </button>
          ))}
        </div>
        {canEditSchema ? (
          <div className="db-sidebar-footer">
            <button
              className="db-button"
              onClick={() => {
                setShowCreateTable((current) => !current);
                setActiveTableName('');
                setActionMessage('');
                setTableError('');
              }}
            >
              {showCreateTable ? 'Close' : '+ Add Table'}
            </button>
          </div>
        ) : null}
      </aside>

      <main className="db-main">
        <div className="db-tabs">
          {(['data', 'structure', 'query'] as TabKey[]).map((tab) => (
            <button
              key={tab}
              className={`db-tab${tab === activeTab ? ' active' : ''}`}
              onClick={() => setActiveTab(tab)}
            >
              {tab === 'data' ? 'Data' : tab === 'structure' ? 'Structure' : 'Query'}
            </button>
          ))}
        </div>

        {(tableError || actionMessage) && activeTab !== 'query' ? (
          <div className={`db-status${tableError ? ' error' : ' success'}`}>{tableError || actionMessage}</div>
        ) : null}

        {activeTab === 'data' && (
          <section className="db-pane">
            <div className="db-content">
              {tableError ? (
                <div className="db-empty">{tableError}</div>
              ) : loadingTable ? (
                <div className="db-empty">Loading rows...</div>
              ) : showCreateTable && canEditSchema ? (
                <div className="db-panel">
                  <div className="db-card">
                    <div className="db-card-title">Create Table</div>
                    <label className="db-field">
                      <span className="db-field-label">Table Name</span>
                      <input
                        className="db-input"
                        value={createTableName}
                        onChange={(event) => setCreateTableName(event.target.value)}
                        placeholder="public.my_table or my_table"
                      />
                    </label>
                    <div className="db-stack">
                      {createTableColumns.map((column, index) => (
                        <div key={index} className="db-column-draft">
                          <div className="db-form-grid compact">
                            <label className="db-field">
                              <span className="db-field-label">Name</span>
                              <input
                                className="db-input"
                                value={column.name}
                                onChange={(event) =>
                                  setCreateTableColumns((current) =>
                                    current.map((item, itemIndex) =>
                                      itemIndex === index ? { ...item, name: event.target.value } : item
                                    )
                                  )
                                }
                              />
                            </label>
                            <label className="db-field">
                              <span className="db-field-label">Type</span>
                              <input
                                className="db-input"
                                value={column.type}
                                onChange={(event) =>
                                  setCreateTableColumns((current) =>
                                    current.map((item, itemIndex) =>
                                      itemIndex === index ? { ...item, type: event.target.value } : item
                                    )
                                  )
                                }
                              />
                            </label>
                            <label className="db-field">
                              <span className="db-field-label">Default</span>
                              <input
                                className="db-input"
                                value={column.defaultValue}
                                onChange={(event) =>
                                  setCreateTableColumns((current) =>
                                    current.map((item, itemIndex) =>
                                      itemIndex === index ? { ...item, defaultValue: event.target.value } : item
                                    )
                                  )
                                }
                              />
                            </label>
                          </div>
                          <div className="db-check-row">
                            <label className="db-check">
                              <input
                                type="checkbox"
                                checked={column.notnull}
                                onChange={(event) =>
                                  setCreateTableColumns((current) =>
                                    current.map((item, itemIndex) =>
                                      itemIndex === index ? { ...item, notnull: event.target.checked } : item
                                    )
                                  )
                                }
                              />
                              Not Null
                            </label>
                            <label className="db-check">
                              <input
                                type="checkbox"
                                checked={column.primaryKey}
                                onChange={(event) =>
                                  setCreateTableColumns((current) =>
                                    current.map((item, itemIndex) =>
                                      itemIndex === index ? { ...item, primaryKey: event.target.checked } : item
                                    )
                                  )
                                }
                              />
                              Primary Key
                            </label>
                            <button
                              className="db-button danger"
                              onClick={() =>
                                setCreateTableColumns((current) =>
                                  current.length > 1 ? current.filter((_, itemIndex) => itemIndex !== index) : current
                                )
                              }
                              disabled={createTableColumns.length <= 1}
                            >
                              Remove
                            </button>
                          </div>
                        </div>
                      ))}
                    </div>
                    <div className="db-check-row">
                      <button className="db-button" onClick={() => setCreateTableColumns((current) => [...current, emptyColumnDraft()])}>
                        Add Column
                      </button>
                      <button className="db-button" onClick={createTable} disabled={savingAction}>
                        Create Table
                      </button>
                    </div>
                  </div>
                </div>
              ) : !activeTableName ? (
                <div className="db-empty">Select a table to begin.</div>
              ) : (
                renderDataTable(tableColumns, tableRows, canEditData)
              )}
            </div>
            <div className="db-pagination">
              <span className="db-pagination-count">
                {tableRows.length}{tableRowCount !== null ? ` of ${tableRowCount}` : '+'} rows
              </span>
              <span>
                {totalPages ? `${loadedPages.length} of ${totalPages} chunks loaded` : 'Continuous list'}
              </span>
              <span className="db-pagination-spacer" />
              <button
                className="db-button"
                disabled={loadingTable || !hasMoreRows}
                onClick={loadMoreRows}
              >
                {loadingTable && tableRows.length > 0 ? 'Loading...' : hasMoreRows ? 'Load More' : 'All Rows Loaded'}
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
                <>
                  <div className="db-card">
                    <div className="db-card-title">{activeTable.name} Columns</div>
                    {activeTable.columns.length === 0 ? (
                      <div className="db-empty" style={{ margin: 0 }}>No column metadata available.</div>
                    ) : (
                      <div className="db-table-scroll">
                        <table className="db-table">
                          <thead>
                            <tr>
                              <th>Name</th>
                              <th>Type</th>
                              <th>Flags</th>
                              <th>Default</th>
                              {canEditSchema ? <th className="db-actions-col">Actions</th> : null}
                            </tr>
                          </thead>
                          <tbody>
                            {columnDrafts.map((column, index) => (
                              <tr key={column.originalName}>
                                <td>
                                  {canEditSchema ? (
                                    <input
                                      className="db-input"
                                      value={column.name}
                                      onChange={(event) =>
                                        setColumnDrafts((current) =>
                                          current.map((item, itemIndex) =>
                                            itemIndex === index ? { ...item, name: event.target.value } : item
                                          )
                                        )
                                      }
                                    />
                                  ) : column.name}
                                </td>
                                <td>
                                  {canEditSchema ? (
                                    <>
                                      <input
                                        className="db-input"
                                        list="db-column-types"
                                        value={column.type}
                                        onChange={(event) =>
                                          setColumnDrafts((current) =>
                                            current.map((item, itemIndex) =>
                                              itemIndex === index ? { ...item, type: event.target.value } : item
                                            )
                                          )
                                        }
                                      />
                                      <datalist id="db-column-types">
                                        {COMMON_COLUMN_TYPES.map((type) => (
                                          <option key={type} value={type} />
                                        ))}
                                      </datalist>
                                    </>
                                  ) : (column.type || 'TEXT')}
                                </td>
                                <td>
                                  {canEditSchema ? (
                                    <div className="db-check-row">
                                      <label className="db-check">
                                        <input
                                          type="checkbox"
                                          checked={column.notnull}
                                          onChange={(event) =>
                                            setColumnDrafts((current) =>
                                              current.map((item, itemIndex) =>
                                                itemIndex === index ? { ...item, notnull: event.target.checked } : item
                                              )
                                            )
                                          }
                                        />
                                        Not Null
                                      </label>
                                      <label className="db-check">
                                        <input type="checkbox" checked={column.primaryKey} disabled />
                                        PK
                                      </label>
                                    </div>
                                  ) : (
                                    <div className="db-badges">
                                      {column.primaryKey ? <span className="db-badge pk">PK</span> : null}
                                      {column.notnull ? <span className="db-badge nn">NOT NULL</span> : null}
                                    </div>
                                  )}
                                </td>
                                <td>
                                  {canEditSchema ? (
                                    <input
                                      className="db-input"
                                      value={column.defaultValue}
                                      onChange={(event) =>
                                        setColumnDrafts((current) =>
                                          current.map((item, itemIndex) =>
                                            itemIndex === index ? { ...item, defaultValue: event.target.value } : item
                                          )
                                        )
                                      }
                                      placeholder="Optional"
                                    />
                                  ) : (column.defaultValue || '-')}
                                </td>
                                {canEditSchema ? (
                                  <td className="db-actions-cell">
                                    <button
                                      className="db-button"
                                      onClick={() => updateColumn(column)}
                                      disabled={savingAction}
                                    >
                                      Save
                                    </button>
                                    <button
                                      className="db-button danger"
                                      onClick={() => {
                                        setSavingAction(true);
                                        setActionMessage('');
                                        getVscode()?.postMessage({
                                          type: 'deleteColumn',
                                          table: activeTable.name,
                                          column: column.originalName,
                                        });
                                      }}
                                      disabled={savingAction}
                                    >
                                      Drop Column
                                    </button>
                                  </td>
                                ) : null}
                              </tr>
                            ))}
                            {canEditSchema ? (
                              <tr className="db-new-row">
                                <td>
                                  <input
                                    className="db-input"
                                    value={newColumnDraft.name}
                                    onChange={(event) => setNewColumnDraft((current) => ({ ...current, name: event.target.value }))}
                                    placeholder="new_column"
                                  />
                                </td>
                                <td>
                                  <input
                                    className="db-input"
                                    list="db-column-types"
                                    value={newColumnDraft.type}
                                    onChange={(event) => setNewColumnDraft((current) => ({ ...current, type: event.target.value }))}
                                  />
                                </td>
                                <td>
                                  <div className="db-check-row">
                                    <label className="db-check">
                                      <input
                                        type="checkbox"
                                        checked={newColumnDraft.notnull}
                                        onChange={(event) => setNewColumnDraft((current) => ({ ...current, notnull: event.target.checked }))}
                                      />
                                      Not Null
                                    </label>
                                  </div>
                                </td>
                                <td>
                                  <input
                                    className="db-input"
                                    value={newColumnDraft.defaultValue}
                                    onChange={(event) => setNewColumnDraft((current) => ({ ...current, defaultValue: event.target.value }))}
                                    placeholder="Optional"
                                  />
                                </td>
                                <td className="db-actions-cell">
                                  <button className="db-button" onClick={addColumn} disabled={savingAction}>
                                    Add
                                  </button>
                                </td>
                              </tr>
                            ) : null}
                          </tbody>
                        </table>
                      </div>
                    )}
                  </div>
                </>
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
