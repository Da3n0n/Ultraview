import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { buildDbHtml } from '../webview/dbHtml';
import type { SqlJsStatic, Database } from 'sql.js';

let SQL: SqlJsStatic | null = null;

async function getSqlJs(extUri: vscode.Uri): Promise<SqlJsStatic> {
  if (SQL) { return SQL; }
   
  const initSqlJsFn = require('sql.js') as (cfg?: object) => Promise<SqlJsStatic>;
  const wasmPath = path.join(extUri.fsPath, 'dist', 'sql-wasm.wasm');
  SQL = await initSqlJsFn({ locateFile: () => wasmPath });
  return SQL!;
}

interface ColInfo { name: string; type: string; pk: number; notnull: number; }
type SqliteBindValue = number | string | Uint8Array | null;

interface SqliteRowSelectorRowId {
  kind: 'rowid';
  value: number;
}

interface SqliteRowSelectorPk {
  kind: 'pk';
  values: Record<string, unknown>;
}

type SqliteRowSelector = SqliteRowSelectorRowId | SqliteRowSelectorPk;

function quoteIdentifier(value: string): string {
  return `"${value.replace(/"/g, '""')}"`;
}

function parseTableReference(value: string): { schema?: string; table: string } {
  const separator = value.indexOf('.');
  if (separator <= 0 || separator === value.length - 1) {
    return { table: value };
  }
  return {
    schema: value.slice(0, separator),
    table: value.slice(separator + 1),
  };
}

function quoteTableReference(value: string): string {
  const { schema, table } = parseTableReference(value);
  return schema ? `${quoteIdentifier(schema)}.${quoteIdentifier(table)}` : quoteIdentifier(table);
}

function asSqliteValue(value: unknown): SqliteBindValue {
  if (value === '__UV_NULL__') {
    return null;
  }
  if (typeof value === 'boolean') {
    return value ? 1 : 0;
  }
  if (typeof value === 'number' || typeof value === 'string' || value instanceof Uint8Array || value === null) {
    return value;
  }
  return String(value);
}

function buildSqliteSelector(table: { columns: ColInfo[] }, row: Record<string, unknown>): string {
  const pkColumns = table.columns.filter((column) => column.pk);
  if (pkColumns.length > 0) {
    return JSON.stringify({
      kind: 'pk',
      values: Object.fromEntries(pkColumns.map((column) => [column.name, row[column.name]])),
    } satisfies SqliteRowSelectorPk);
  }
  return JSON.stringify({
    kind: 'rowid',
    value: Number(row.__uv_row_id ?? 0),
  } satisfies SqliteRowSelectorRowId);
}

function parseSqliteSelector(raw: string): SqliteRowSelector {
  const parsed = JSON.parse(raw) as Partial<SqliteRowSelector>;
  if (parsed.kind === 'pk' && parsed.values && typeof parsed.values === 'object') {
    return { kind: 'pk', values: parsed.values as Record<string, unknown> };
  }
  if (parsed.kind === 'rowid') {
    return { kind: 'rowid', value: Number(parsed.value ?? 0) };
  }
  throw new Error('Unable to resolve SQLite row identity.');
}

export class SqliteProvider implements vscode.CustomReadonlyEditorProvider {
  constructor(private readonly ctx: vscode.ExtensionContext) {}

  openCustomDocument(uri: vscode.Uri): vscode.CustomDocument {
    return { uri, dispose: () => {} };
  }

  async resolveCustomEditor(
    document: vscode.CustomDocument,
    panel: vscode.WebviewPanel
  ): Promise<void> {
    panel.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.file(path.join(this.ctx.extensionPath, 'dist'))],
    };
    const filePath = document.uri.fsPath;
    let db: Database | null = null;

    const openDb = async () => {
      if (!db) {
        const sql = await getSqlJs(this.ctx.extensionUri);
        const buf = await fs.promises.readFile(filePath);
        db = new sql.Database(buf);
      }
      return db!;
    };

    const persistDb = async () => {
      if (!db) {
        return;
      }
      const data = db.export();
      await fs.promises.writeFile(filePath, Buffer.from(data));
    };

    const loadTables = (d: Database) => {
      const tableRes = d.exec(`SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name`);
      const tableNames = tableRes.length > 0 ? tableRes[0].values.map((r) => String(r[0])) : [];
      return tableNames.map((name) => {
        const colsRes = d.exec(`PRAGMA table_info(${quoteIdentifier(name)})`);
        const cols: ColInfo[] = colsRes.length > 0
          ? colsRes[0].values.map((r) => ({ name: String(r[1]), type: String(r[2]), pk: Number(r[5]), notnull: Number(r[3]) }))
          : [];
        return { name, rowCount: null, columns: cols };
      });
    };

    const postSchema = async () => {
      const d = await openDb();
      const tables = loadTables(d);
      const dbSize = fs.statSync(filePath).size;
      panel.webview.postMessage({
        type: 'schema',
        tables,
        dbSize,
        sourceLabel: filePath,
        dbType: 'SQLite',
        dbName: path.basename(filePath),
        canEditData: true,
        canEditSchema: true,
      });
      return tables;
    };

    panel.webview.html = buildDbHtml(this.ctx.extensionPath, panel.webview, 'SQLite', filePath, path.basename(filePath));

    panel.webview.onDidReceiveMessage(async (msg) => {
      try {
        switch (msg.type) {
          case 'ready': {
            await postSchema();
            break;
          }
          case 'getTableData': {
            const d = await openDb();
            const pageSize = msg.pageSize ?? 200;
            const offset = (msg.page ?? 0) * pageSize;
            const tables = loadTables(d);
            const tableMeta = tables.find((table) => table.name === msg.table);
            if (!tableMeta) {
              throw new Error(`Table not found: ${msg.table}`);
            }

            // Fetch row count for this table specifically to update the UI
            const cntRes = d.exec(`SELECT COUNT(*) FROM ${quoteTableReference(String(msg.table))}`);
            const rowCount = cntRes.length > 0 ? Number(cntRes[0].values[0][0]) : 0;

            const selectIdentity = tableMeta.columns.some((column) => column.pk)
              ? '*'
              : 'rowid AS __uv_row_id, *';
            const res = d.exec(`SELECT ${selectIdentity} FROM ${quoteTableReference(String(msg.table))} LIMIT ${pageSize} OFFSET ${offset}`);
            if (res.length === 0) {
              panel.webview.postMessage({ type: 'tableData', table: msg.table, columns: [], rows: [], page: msg.page ?? 0, rowCount, rowIds: [] });
              break;
            }
            const { columns, values } = res[0];
            const rows = values.map((row) => {
              const obj: Record<string, unknown> = {};
              columns.forEach((c, i) => { obj[c] = row[i]; });
              return obj;
            });
            const rowIds = rows.map((row) => buildSqliteSelector(tableMeta, row));
            const cleanRows = rows.map((row) => {
              const next = { ...row };
              delete next.__uv_row_id;
              return next;
            });
            const visibleColumns = columns.filter((column) => column !== '__uv_row_id');
            panel.webview.postMessage({ type: 'tableData', table: msg.table, columns: visibleColumns, rows: cleanRows, page: msg.page ?? 0, rowCount, rowIds });
            break;
          }
          case 'runQuery': {
            const d = await openDb();
            const results = d.exec(msg.sql);
            if (results.length === 0) {
              const changes = d.getRowsModified();
              if (changes > 0 || /^\s*(insert|update|delete|create|drop|alter|replace|vacuum|pragma)\b/i.test(String(msg.sql))) {
                await persistDb();
              }
              if (/^\s*(create|drop|alter)\b/i.test(String(msg.sql))) {
                await postSchema();
              }
              panel.webview.postMessage({ type: 'queryResult', columns: [], rows: [], changes });
            } else {
              const { columns, values } = results[0];
              const rows = values.map((row) => {
                const obj: Record<string, unknown> = {};
                columns.forEach((c, i) => { obj[c] = row[i]; });
                return obj;
              });
              panel.webview.postMessage({ type: 'queryResult', columns, rows });
            }
            break;
          }
          case 'updateCell': {
            const d = await openDb();
            const tables = loadTables(d);
            const tableMeta = tables.find((table) => table.name === msg.table);
            if (!tableMeta) {
              throw new Error(`Table not found: ${msg.table}`);
            }
            const selector = parseSqliteSelector(String(msg.rowId));
            let sql = `UPDATE ${quoteTableReference(String(msg.table))} SET ${quoteIdentifier(String(msg.column))} = ?`;
            const params: SqliteBindValue[] = [asSqliteValue(msg.value)];
            if (selector.kind === 'pk') {
              const whereParts = Object.keys(selector.values).map((column) => `${quoteIdentifier(column)} IS ?`);
              sql += ` WHERE ${whereParts.join(' AND ')}`;
              params.push(...Object.values(selector.values).map(asSqliteValue));
            } else {
              sql += ' WHERE rowid = ?';
              params.push(selector.value);
            }
            d.run(sql, params);
            await persistDb();
            panel.webview.postMessage({ type: 'actionComplete', message: 'Cell updated.' });
            break;
          }
          case 'insertRow': {
            const d = await openDb();
            const entries = Object.entries(msg.values || {});
            if (entries.length === 0) {
              d.run(`INSERT INTO ${quoteTableReference(String(msg.table))} DEFAULT VALUES`);
            } else {
              const columns = entries.map(([column]) => quoteIdentifier(column)).join(', ');
              const placeholders = entries.map(() => '?').join(', ');
              d.run(
                `INSERT INTO ${quoteTableReference(String(msg.table))} (${columns}) VALUES (${placeholders})`,
                entries.map(([, value]) => asSqliteValue(value))
              );
            }
            await persistDb();
            panel.webview.postMessage({ type: 'actionComplete', message: 'Row added.' });
            break;
          }
          case 'deleteRow': {
            const d = await openDb();
            const selector = parseSqliteSelector(String(msg.rowId));
            let sql = `DELETE FROM ${quoteTableReference(String(msg.table))}`;
            const params: SqliteBindValue[] = [];
            if (selector.kind === 'pk') {
              const whereParts = Object.keys(selector.values).map((column) => `${quoteIdentifier(column)} IS ?`);
              sql += ` WHERE ${whereParts.join(' AND ')}`;
              params.push(...Object.values(selector.values).map(asSqliteValue));
            } else {
              sql += ' WHERE rowid = ?';
              params.push(selector.value);
            }
            d.run(sql, params);
            await persistDb();
            panel.webview.postMessage({ type: 'actionComplete', message: 'Row deleted.' });
            break;
          }
          case 'createTable': {
            const d = await openDb();
            const tableName = String(msg.tableName || '').trim();
            const columns = Array.isArray(msg.columns) ? msg.columns : [];
            if (!tableName || columns.length === 0) {
              throw new Error('Table name and at least one column are required.');
            }
            const columnSql = columns.map((column: { name: string; type: string; notnull?: boolean; primaryKey?: boolean; defaultValue?: string }) => {
              const parts = [quoteIdentifier(String(column.name)), String(column.type || 'TEXT').trim()];
              if (column.notnull) {
                parts.push('NOT NULL');
              }
              if (column.primaryKey) {
                parts.push('PRIMARY KEY');
              }
              if (column.defaultValue?.trim()) {
                parts.push(`DEFAULT ${column.defaultValue.trim()}`);
              }
              return parts.join(' ');
            }).join(', ');
            d.run(`CREATE TABLE ${quoteTableReference(tableName)} (${columnSql})`);
            await persistDb();
            await postSchema();
            panel.webview.postMessage({ type: 'actionComplete', message: 'Table created.' });
            break;
          }
          case 'deleteTable': {
            const d = await openDb();
            d.run(`DROP TABLE ${quoteTableReference(String(msg.table))}`);
            await persistDb();
            await postSchema();
            panel.webview.postMessage({ type: 'actionComplete', message: 'Table deleted.' });
            break;
          }
          case 'addColumn': {
            const d = await openDb();
            const column = msg.column;
            if (!column?.name || !column?.type) {
              throw new Error('Column name and type are required.');
            }
            const parts = [
              `ALTER TABLE ${quoteTableReference(String(msg.table))}`,
              `ADD COLUMN ${quoteIdentifier(String(column.name))} ${String(column.type).trim()}`,
            ];
            if (column.notnull) {
              parts.push('NOT NULL');
            }
            if (column.defaultValue?.trim()) {
              parts.push(`DEFAULT ${column.defaultValue.trim()}`);
            }
            d.run(parts.join(' '));
            await persistDb();
            await postSchema();
            panel.webview.postMessage({ type: 'actionComplete', message: 'Column added.' });
            break;
          }
          case 'deleteColumn': {
            const d = await openDb();
            d.run(
              `ALTER TABLE ${quoteTableReference(String(msg.table))} DROP COLUMN ${quoteIdentifier(String(msg.column))}`
            );
            await persistDb();
            await postSchema();
            panel.webview.postMessage({ type: 'actionComplete', message: 'Column removed.' });
            break;
          }
        }
      } catch (err) {
        panel.webview.postMessage({ type: 'error', message: String(err) });
      }
    });

    panel.onDidDispose(() => { try { db?.close(); } catch { /* ignore */ } });
  }
}
