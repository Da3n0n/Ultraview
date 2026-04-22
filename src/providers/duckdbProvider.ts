import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { buildDbHtml } from '../webview/dbHtml';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function tryLoadDuckDb(): { duckdb: any } | null {
  try {
     
    const duckdb = require('duckdb');
    return { duckdb };
  } catch {
    return null;
  }
}

function quoteIdentifier(value: string): string {
  return `"${value.replace(/"/g, '""')}"`;
}

function asDuckDbLiteral(value: unknown): string {
  if (value === '__UV_NULL__' || value === null || value === undefined) {
    return 'NULL';
  }
  if (typeof value === 'number') {
    return Number.isFinite(value) ? String(value) : 'NULL';
  }
  if (typeof value === 'boolean') {
    return value ? 'TRUE' : 'FALSE';
  }
  if (typeof value === 'object') {
    return `'${JSON.stringify(value).replace(/'/g, "''")}'`;
  }
  return `'${String(value).replace(/'/g, "''")}'`;
}

export class DuckDbProvider implements vscode.CustomReadonlyEditorProvider {
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

    const mod = tryLoadDuckDb();

    panel.webview.html = buildDbHtml(this.ctx.extensionPath, panel.webview, 'DuckDB', filePath, path.basename(filePath));

    if (!mod) {
      // DuckDB native module not installed — show install instructions
      panel.webview.onDidReceiveMessage((msg) => {
        if (msg.type === 'ready') {
          panel.webview.postMessage({
            type: 'error',
            message:
              'DuckDB native module is not available in this environment.\n\n' +
              'To enable DuckDB support, run in the extension folder:\n' +
              '  npm install duckdb\n\n' +
              'Alternatively, export your DuckDB data to SQLite or a CSV/SQL dump first.'
          });
        }
      });
      return;
    }

    const { duckdb } = mod;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let db: any = null;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let conn: any = null;

    const openDb = () => {
      if (!db) {
        db = new duckdb.Database(filePath);
        conn = db.connect();
      }
    };

    const query = (sql: string): Promise<unknown[]> =>
      new Promise((resolve, reject) => {
        openDb();
        conn.all(sql, (err: Error, rows: unknown[]) => {
          if (err) { reject(err); } else { resolve(rows); }
        });
      });

    const execute = (sql: string): Promise<void> =>
      new Promise((resolve, reject) => {
        openDb();
        const runner = typeof conn.run === 'function' ? conn.run.bind(conn) : conn.all.bind(conn);
        runner(sql, (err: Error) => {
          if (err) { reject(err); } else { resolve(); }
        });
      });

    const loadTables = async () => {
      const tables = await query(`SELECT table_name as name FROM information_schema.tables WHERE table_schema = 'main'`) as { name: string }[];
      return Promise.all(tables.map(async (t) => {
        const cols = await query(`SELECT column_name as name, data_type as type, column_default as defaultValue FROM information_schema.columns WHERE table_name='${t.name.replace(/'/g, "''")}' AND table_schema='main'`) as Array<{ name: string; type: string; defaultValue?: string | null }>;
        return {
          name: t.name,
          rowCount: null,
          columns: cols.map((column) => ({ ...column, pk: 0, notnull: 0 })),
        };
      }));
    };

    const postSchema = async () => {
      const tableInfos = await loadTables();
      const dbSize = fs.statSync(filePath).size;
      panel.webview.postMessage({
        type: 'schema',
        tables: tableInfos,
        dbSize,
        sourceLabel: filePath,
        dbType: 'DuckDB',
        dbName: path.basename(filePath),
        canEditData: true,
        canEditSchema: true,
      });
    };

    panel.webview.onDidReceiveMessage(async (msg) => {
      try {
        switch (msg.type) {
          case 'ready': {
            await postSchema();
            break;
          }
          case 'getTableData': {
            const cnt = await query(`SELECT COUNT(*) as c FROM "${msg.table}"`);
            const rowCount = (cnt[0] as { c: number }).c;
            const offset = (msg.page ?? 0) * (msg.pageSize ?? 200);
            const rows = await query(`SELECT rowid AS __uv_row_id, * FROM ${quoteIdentifier(String(msg.table))} LIMIT ${msg.pageSize ?? 200} OFFSET ${offset}`) as Record<string, unknown>[];
            const cols = rows.length > 0 ? Object.keys(rows[0] as object).filter((column) => column !== '__uv_row_id') : [];
            const rowIds = rows.map((row) => JSON.stringify({ kind: 'rowid', value: row.__uv_row_id }));
            const cleanRows = rows.map((row) => {
              const next = { ...row };
              delete next.__uv_row_id;
              return next;
            });
            panel.webview.postMessage({ type: 'tableData', table: msg.table, columns: cols, rows: cleanRows, page: msg.page ?? 0, rowCount, rowIds });
            break;
          }
          case 'runQuery': {
            const rows = await query(msg.sql);
            const cols = rows.length > 0 ? Object.keys(rows[0] as object) : [];
            panel.webview.postMessage({ type: 'queryResult', columns: cols, rows });
            break;
          }
          case 'updateCell': {
            const selector = JSON.parse(String(msg.rowId)) as { value: unknown };
            await execute(
              `UPDATE ${quoteIdentifier(String(msg.table))} SET ${quoteIdentifier(String(msg.column))} = ${asDuckDbLiteral(msg.value)} WHERE rowid = ${asDuckDbLiteral(selector.value)}`
            );
            panel.webview.postMessage({ type: 'actionComplete', message: 'Cell updated.' });
            break;
          }
          case 'insertRow': {
            const entries = Object.entries(msg.values || {});
            if (entries.length === 0) {
              await execute(`INSERT INTO ${quoteIdentifier(String(msg.table))} DEFAULT VALUES`);
            } else {
              const columns = entries.map(([column]) => quoteIdentifier(column)).join(', ');
              const values = entries.map(([, value]) => asDuckDbLiteral(value)).join(', ');
              await execute(`INSERT INTO ${quoteIdentifier(String(msg.table))} (${columns}) VALUES (${values})`);
            }
            panel.webview.postMessage({ type: 'actionComplete', message: 'Row added.' });
            break;
          }
          case 'deleteRow': {
            const selector = JSON.parse(String(msg.rowId)) as { value: unknown };
            await execute(`DELETE FROM ${quoteIdentifier(String(msg.table))} WHERE rowid = ${asDuckDbLiteral(selector.value)}`);
            panel.webview.postMessage({ type: 'actionComplete', message: 'Row deleted.' });
            break;
          }
          case 'createTable': {
            const tableName = String(msg.tableName || '').trim();
            const columns: Array<{ name: string; type: string; notnull?: boolean; primaryKey?: boolean; defaultValue?: string }> = Array.isArray(msg.columns) ? msg.columns : [];
            if (!tableName || columns.length === 0) {
              throw new Error('Table name and at least one column are required.');
            }
            const columnSql = columns.map((column) => {
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
            await execute(`CREATE TABLE ${quoteIdentifier(tableName)} (${columnSql})`);
            await postSchema();
            panel.webview.postMessage({ type: 'actionComplete', message: 'Table created.' });
            break;
          }
          case 'deleteTable': {
            await execute(`DROP TABLE ${quoteIdentifier(String(msg.table))}`);
            await postSchema();
            panel.webview.postMessage({ type: 'actionComplete', message: 'Table deleted.' });
            break;
          }
          case 'addColumn': {
            const column = msg.column;
            if (!column?.name || !column?.type) {
              throw new Error('Column name and type are required.');
            }
            const parts = [
              `ALTER TABLE ${quoteIdentifier(String(msg.table))}`,
              `ADD COLUMN ${quoteIdentifier(String(column.name))} ${String(column.type).trim()}`,
            ];
            if (column.notnull) {
              parts.push('NOT NULL');
            }
            if (column.defaultValue?.trim()) {
              parts.push(`DEFAULT ${column.defaultValue.trim()}`);
            }
            await execute(parts.join(' '));
            await postSchema();
            panel.webview.postMessage({ type: 'actionComplete', message: 'Column added.' });
            break;
          }
          case 'deleteColumn': {
            await execute(`ALTER TABLE ${quoteIdentifier(String(msg.table))} DROP COLUMN ${quoteIdentifier(String(msg.column))}`);
            await postSchema();
            panel.webview.postMessage({ type: 'actionComplete', message: 'Column removed.' });
            break;
          }
          case 'updateColumn': {
            const next = msg.next;
            if (!next?.name || !next?.type) {
              throw new Error('Column name and type are required.');
            }
            let currentName = String(msg.column);
            if (currentName !== next.name) {
              await execute(`ALTER TABLE ${quoteIdentifier(String(msg.table))} RENAME COLUMN ${quoteIdentifier(currentName)} TO ${quoteIdentifier(next.name)}`);
              currentName = next.name;
            }
            await execute(`ALTER TABLE ${quoteIdentifier(String(msg.table))} ALTER COLUMN ${quoteIdentifier(currentName)} TYPE ${String(next.type).trim()}`);
            if (next.defaultValue?.trim()) {
              await execute(`ALTER TABLE ${quoteIdentifier(String(msg.table))} ALTER COLUMN ${quoteIdentifier(currentName)} SET DEFAULT ${next.defaultValue.trim()}`);
            } else {
              await execute(`ALTER TABLE ${quoteIdentifier(String(msg.table))} ALTER COLUMN ${quoteIdentifier(currentName)} DROP DEFAULT`);
            }
            await execute(`ALTER TABLE ${quoteIdentifier(String(msg.table))} ALTER COLUMN ${quoteIdentifier(currentName)} ${next.notnull ? 'SET' : 'DROP'} NOT NULL`);
            await postSchema();
            panel.webview.postMessage({ type: 'actionComplete', message: 'Column updated.' });
            break;
          }
        }
      } catch (err) {
        panel.webview.postMessage({ type: 'error', message: String(err) });
      }
    });

    panel.onDidDispose(() => { try { conn?.close(); db?.close(); } catch { /* ignore */ } });
  }
}
