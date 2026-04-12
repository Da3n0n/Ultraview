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

    panel.webview.html = buildDbHtml(this.ctx.extensionPath, panel.webview, 'SQLite');

    panel.webview.onDidReceiveMessage(async (msg) => {
      try {
        switch (msg.type) {
          case 'ready': {
            const d = await openDb();
            const tableRes = d.exec(`SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name`);
            const tableNames = tableRes.length > 0 ? tableRes[0].values.map(r => String(r[0])) : [];
            const tables = tableNames.map((name) => {
              const colsRes = d.exec(`PRAGMA table_info("${name}")`);
              const cols: ColInfo[] = colsRes.length > 0
                ? colsRes[0].values.map(r => ({ name: String(r[1]), type: String(r[2]), pk: Number(r[5]), notnull: Number(r[3]) }))
                : [];
              return { name, rowCount: null, columns: cols };
            });
            const dbSize = fs.statSync(filePath).size;
            panel.webview.postMessage({ type: 'schema', tables, dbSize, filePath, dbType: 'SQLite' });
            break;
          }
          case 'getTableData': {
            const d = await openDb();
            const pageSize = msg.pageSize ?? 200;
            const offset = (msg.page ?? 0) * pageSize;

            // Fetch row count for this table specifically to update the UI
            const cntRes = d.exec(`SELECT COUNT(*) FROM "${msg.table}"`);
            const rowCount = cntRes.length > 0 ? Number(cntRes[0].values[0][0]) : 0;

            const res = d.exec(`SELECT * FROM "${msg.table}" LIMIT ${pageSize} OFFSET ${offset}`);
            if (res.length === 0) {
              panel.webview.postMessage({ type: 'tableData', table: msg.table, columns: [], rows: [], page: msg.page ?? 0, rowCount });
              break;
            }
            const { columns, values } = res[0];
            const rows = values.map(row => {
              const obj: Record<string, unknown> = {};
              columns.forEach((c, i) => { obj[c] = row[i]; });
              return obj;
            });
            panel.webview.postMessage({ type: 'tableData', table: msg.table, columns, rows, page: msg.page ?? 0, rowCount });
            break;
          }
          case 'runQuery': {
            const d = await openDb();
            const results = d.exec(msg.sql);
            if (results.length === 0) {
              panel.webview.postMessage({ type: 'queryResult', columns: [], rows: [], changes: 0 });
            } else {
              const { columns, values } = results[0];
              const rows = values.map(row => {
                const obj: Record<string, unknown> = {};
                columns.forEach((c, i) => { obj[c] = row[i]; });
                return obj;
              });
              panel.webview.postMessage({ type: 'queryResult', columns, rows });
            }
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
