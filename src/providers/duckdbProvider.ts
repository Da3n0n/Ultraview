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

    panel.webview.html = buildDbHtml(this.ctx.extensionPath, panel.webview, 'DuckDB');

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
        db = new duckdb.Database(filePath, { access_mode: 'READ_ONLY' });
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

    panel.webview.onDidReceiveMessage(async (msg) => {
      try {
        switch (msg.type) {
          case 'ready': {
            const tables = await query(`SELECT table_name as name FROM information_schema.tables WHERE table_schema = 'main'`) as { name: string }[];
            const tableInfos = await Promise.all(tables.map(async (t) => {
              const cols = await query(`SELECT column_name as name, data_type as type FROM information_schema.columns WHERE table_name='${t.name}' AND table_schema='main'`);
              return { name: t.name, rowCount: null, columns: cols };
            }));
            const dbSize = fs.statSync(filePath).size;
            panel.webview.postMessage({ type: 'schema', tables: tableInfos, dbSize, sourceLabel: filePath, dbType: 'DuckDB' });
            break;
          }
          case 'getTableData': {
            const cnt = await query(`SELECT COUNT(*) as c FROM "${msg.table}"`);
            const rowCount = (cnt[0] as { c: number }).c;
            const offset = (msg.page ?? 0) * (msg.pageSize ?? 200);
            const rows = await query(`SELECT * FROM "${msg.table}" LIMIT ${msg.pageSize ?? 200} OFFSET ${offset}`);
            const cols = rows.length > 0 ? Object.keys(rows[0] as object) : [];
            panel.webview.postMessage({ type: 'tableData', table: msg.table, columns: cols, rows, page: msg.page ?? 0, rowCount });
            break;
          }
          case 'runQuery': {
            const rows = await query(msg.sql);
            const cols = rows.length > 0 ? Object.keys(rows[0] as object) : [];
            panel.webview.postMessage({ type: 'queryResult', columns: cols, rows });
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
