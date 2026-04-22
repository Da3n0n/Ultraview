import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { buildDbHtml } from '../webview/dbHtml';

 
const MDBReader = require('mdb-reader');

export class AccessProvider implements vscode.CustomReadonlyEditorProvider {
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

    let reader: typeof MDBReader | null = null;
    const getReader = () => {
      if (!reader) {
        const buf = fs.readFileSync(filePath);
        reader = new MDBReader(buf);
      }
      return reader;
    };

    panel.webview.html = buildDbHtml(this.ctx.extensionPath, panel.webview, 'Access DB', filePath, path.basename(filePath));

    panel.webview.onDidReceiveMessage(async (msg) => {
      try {
        const r = getReader();
        switch (msg.type) {
          case 'ready': {
            const tableNames: string[] = r.getTableNames();
            const tables = tableNames.map((name: string) => {
              const tbl = r.getTable(name);
              const cols = tbl.getColumnNames().map((c: string) => ({ name: c, type: 'text', pk: 0, notnull: 0 }));
              return { name, rowCount: tbl.getData().length, columns: cols };
            });
            const dbSize = fs.statSync(filePath).size;
            panel.webview.postMessage({ type: 'schema', tables, dbSize, sourceLabel: filePath, dbType: 'Access DB (.mdb/.accdb)', dbName: path.basename(filePath) });
            break;
          }
          case 'getTableData': {
            const tbl = r.getTable(msg.table);
            const allRows = tbl.getData();
            const pageSize = msg.pageSize ?? 200;
            const offset = (msg.page ?? 0) * pageSize;
            const rows = allRows.slice(offset, offset + pageSize);
            const cols = tbl.getColumnNames() as string[];
            const rowsAsObj = rows.map((row: unknown[]) =>
              Object.fromEntries(cols.map((c: string, i: number) => [c, row[i]]))
            );
            panel.webview.postMessage({ type: 'tableData', table: msg.table, columns: cols, rows: rowsAsObj, page: msg.page ?? 0 });
            break;
          }
          case 'runQuery': {
            panel.webview.postMessage({ type: 'error', message: 'SQL queries are not supported for Access DB files. Browse tables instead.' });
            break;
          }
        }
      } catch (err) {
        panel.webview.postMessage({ type: 'error', message: String(err) });
      }
    });
  }
}
