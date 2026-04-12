import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { buildDbHtml } from '../webview/dbHtml';

interface IndexColumn {
  name: string;
  type: string;
  pk: number;
  notnull: number;
}

interface IndexTable {
  name: string;
  rowCount: number;
  columns: IndexColumn[];
}

const TEXT_LINE_LIMIT = 11854;
const BINARY_ROW_LIMIT = 5000;
const BINARY_CHUNK_SIZE = 32;

export class IndexProvider implements vscode.CustomReadonlyEditorProvider {
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

    let tables: IndexTable[] = [];
    let tableRows = new Map<string, Record<string, unknown>[]>();
    let dbType = 'Index File';

    const initialize = () => {
      const data = fs.readFileSync(filePath);
      const parsed = parseIndexFile(data);
      dbType = parsed.dbType;
      tables = parsed.tables;
      tableRows = parsed.rowsByTable;
    };

    panel.webview.html = buildDbHtml(this.ctx.extensionPath, panel.webview, 'Index File');

    panel.webview.onDidReceiveMessage(async (msg) => {
      try {
        switch (msg.type) {
          case 'ready': {
            initialize();
            const dbSize = fs.statSync(filePath).size;
            panel.webview.postMessage({ type: 'schema', tables, dbSize, filePath, dbType });
            break;
          }
          case 'getTableData': {
            const tableName = String(msg.table ?? '');
            const allRows = tableRows.get(tableName) ?? [];
            const pageSize = Number(msg.pageSize ?? 200);
            const page = Number(msg.page ?? 0);
            const offset = page * pageSize;
            const rows = allRows.slice(offset, offset + pageSize);
            const cols = tables.find((t) => t.name === tableName)?.columns.map((c) => c.name) ?? [];
            panel.webview.postMessage({ type: 'tableData', table: tableName, columns: cols, rows, page });
            break;
          }
          case 'runQuery': {
            panel.webview.postMessage({ type: 'error', message: 'Queries are not supported for index-file previews.' });
            break;
          }
        }
      } catch (err) {
        panel.webview.postMessage({ type: 'error', message: String(err) });
      }
    });
  }
}

function parseIndexFile(data: Buffer): {
  dbType: string;
  tables: IndexTable[];
  rowsByTable: Map<string, Record<string, unknown>[]>;
} {
  if (looksLikeText(data)) {
    const text = data.toString('utf8');
    const allLines = text.split(/\r?\n/);
    const truncated = allLines.length > TEXT_LINE_LIMIT;
    const lines = allLines.slice(0, TEXT_LINE_LIMIT);

    const lineRows = lines.map((line, index) => ({
      line: index + 1,
      content: line
    }));

    const rowsByTable = new Map<string, Record<string, unknown>[]>();
    rowsByTable.set('lines', lineRows);
    return {
      dbType: truncated ? 'Index File (text, truncated preview)' : 'Index File (text)',
      tables: [
        {
          name: 'lines',
          rowCount: lineRows.length,
          columns: [
            { name: 'line', type: 'INTEGER', pk: 1, notnull: 1 },
            { name: 'content', type: 'TEXT', pk: 0, notnull: 0 }
          ]
        }
      ],
      rowsByTable
    };
  }

  const totalRows = Math.ceil(data.length / BINARY_CHUNK_SIZE);
  const visibleRows = Math.min(totalRows, BINARY_ROW_LIMIT);
  const rows: Record<string, unknown>[] = [];

  for (let index = 0; index < visibleRows; index++) {
    const start = index * BINARY_CHUNK_SIZE;
    const end = Math.min(start + BINARY_CHUNK_SIZE, data.length);
    const chunk = data.subarray(start, end);

    const hex = Array.from(chunk)
      .map((value) => value.toString(16).padStart(2, '0'))
      .join(' ');

    const ascii = Array.from(chunk)
      .map((value) => (value >= 32 && value <= 126 ? String.fromCharCode(value) : '.'))
      .join('');

    rows.push({
      offset: `0x${start.toString(16).toUpperCase().padStart(8, '0')}`,
      hex,
      ascii
    });
  }

  const rowsByTable = new Map<string, Record<string, unknown>[]>();
  rowsByTable.set('chunks', rows);
  return {
    dbType: totalRows > BINARY_ROW_LIMIT ? 'Index File (binary, truncated preview)' : 'Index File (binary)',
    tables: [
      {
        name: 'chunks',
        rowCount: rows.length,
        columns: [
          { name: 'offset', type: 'TEXT', pk: 1, notnull: 1 },
          { name: 'hex', type: 'TEXT', pk: 0, notnull: 1 },
          { name: 'ascii', type: 'TEXT', pk: 0, notnull: 1 }
        ]
      }
    ],
    rowsByTable
  };
}

function looksLikeText(data: Buffer): boolean {
  const sampleSize = Math.min(data.length, 4096);
  if (sampleSize === 0) {
    return true;
  }

  let suspicious = 0;
  for (let index = 0; index < sampleSize; index++) {
    const value = data[index];
    const isCommonWhitespace = value === 9 || value === 10 || value === 13;
    const isControlChar = value < 32 && !isCommonWhitespace;
    if (isControlChar || value === 0) {
      suspicious++;
    }
  }

  return suspicious / sampleSize < 0.1;
}
