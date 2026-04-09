import * as vscode from 'vscode';
import * as fs from 'fs';
import { buildDbHtml } from '../webview/ultraview';

interface ParsedTable {
  name: string;
  columns: { name: string; type: string; pk: number; notnull: number }[];
  rows: Record<string, unknown>[];
}

/** Very lightweight SQL dump parser — handles pg_dump / mysqldump / sqlite .sql */
function parseSqlDump(sql: string): ParsedTable[] {
  const tables = new Map<string, ParsedTable>();

  // Match CREATE TABLE statements
  const createRe = /CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?["'`]?(\w+)["'`]?\s*\(([^;]+)\)/gim;
  let m: RegExpExecArray | null;
  while ((m = createRe.exec(sql)) !== null) {
    const name = m[1];
    const body = m[2];
    const cols = body
      .split(/,(?![^()]*\))/)
      .map((c) => c.trim())
      .filter((c) => !c.match(/^\s*(PRIMARY|UNIQUE|KEY|INDEX|CONSTRAINT|CHECK|FOREIGN)/i))
      .map((c) => {
        const parts = c.trim().split(/\s+/);
        const colName = parts[0].replace(/["'`]/g, '');
        const colType = parts[1] ?? 'TEXT';
        return { name: colName, type: colType, pk: 0, notnull: 0 };
      })
      .filter((c) => c.name.length > 0);
    tables.set(name, { name, columns: cols, rows: [] });
  }

  // Match INSERT INTO statements (values style)
  const insertRe = /INSERT\s+INTO\s+["'`]?(\w+)["'`]?\s*(?:\(([^)]+)\))?\s*VALUES\s*((?:\([^)]+\)\s*,?\s*)+)/gim;
  while ((m = insertRe.exec(sql)) !== null) {
    const name = m[1];
    if (!tables.has(name)) { tables.set(name, { name, columns: [], rows: [] }); }
    const tbl = tables.get(name)!;
    const colNames = m[2]
      ? m[2].split(',').map((c) => c.trim().replace(/["'`]/g, ''))
      : tbl.columns.map((c) => c.name);

    const valBlockRe = /\(([^)]+)\)/g;
    let vm: RegExpExecArray | null;
    while ((vm = valBlockRe.exec(m[3])) !== null) {
      const vals = vm[1].split(/,(?=(?:[^']*'[^']*')*[^']*$)/).map((v) =>
        v.trim().replace(/^'(.*)'$/, '$1').replace(/^"(.*)"$/, '$1')
      );
      const row: Record<string, unknown> = {};
      colNames.forEach((c, i) => { row[c] = vals[i] ?? null; });
      tbl.rows.push(row);
    }
  }

  return Array.from(tables.values());
}

export class SqlDumpProvider implements vscode.CustomReadonlyEditorProvider {
  constructor(private readonly ctx: vscode.ExtensionContext) {}

  openCustomDocument(uri: vscode.Uri): vscode.CustomDocument {
    return { uri, dispose: () => {} };
  }

  async resolveCustomEditor(
    document: vscode.CustomDocument,
    panel: vscode.WebviewPanel
  ): Promise<void> {
    panel.webview.options = { enableScripts: true };
    const filePath = document.uri.fsPath;

    let parsed: ParsedTable[] | null = null;
    const getParsed = async () => {
      if (!parsed) {
        const sql = await fs.promises.readFile(filePath, 'utf8');
        parsed = parseSqlDump(sql);
      }
      return parsed;
    };

    panel.webview.html = buildDbHtml(panel.webview, this.ctx.extensionUri, 'SQL Dump');

    panel.webview.onDidReceiveMessage(async (msg) => {
      try {
        const tables = await getParsed();
        switch (msg.type) {
          case 'ready': {
            const schema = tables.map((t) => ({
              name: t.name,
              rowCount: t.rows.length,
              columns: t.columns
            }));
            const dbSize = fs.statSync(filePath).size;
            panel.webview.postMessage({ type: 'schema', tables: schema, dbSize, filePath, dbType: 'SQL Dump' });
            break;
          }
          case 'getTableData': {
            const tbl = tables.find((t) => t.name === msg.table);
            if (!tbl) { break; }
            const pageSize = msg.pageSize ?? 200;
            const offset = (msg.page ?? 0) * pageSize;
            const rows = tbl.rows.slice(offset, offset + pageSize);
            const cols = tbl.columns.length > 0 ? tbl.columns.map((c) => c.name) : rows.length > 0 ? Object.keys(rows[0]) : [];
            panel.webview.postMessage({ type: 'tableData', table: msg.table, columns: cols, rows, page: msg.page ?? 0 });
            break;
          }
          case 'runQuery': {
            panel.webview.postMessage({ type: 'error', message: 'SQL queries cannot be run against static dump files. Browse tables instead.' });
            break;
          }
        }
      } catch (err) {
        panel.webview.postMessage({ type: 'error', message: String(err) });
      }
    });
  }
}
