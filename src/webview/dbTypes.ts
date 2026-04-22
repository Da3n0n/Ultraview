export interface DbInitialState {
  dbType: string;
  sourceLabel?: string;
}

export interface DbColumn {
  name: string;
  type: string;
  pk?: number;
  notnull?: number;
}

export interface DbTable {
  name: string;
  rowCount: number | null;
  columns: DbColumn[];
}

export interface DbSchemaMessage {
  type: 'schema';
  tables: DbTable[];
  dbSize: number;
  sourceLabel: string;
  dbType: string;
}

export interface DbTableDataMessage {
  type: 'tableData';
  table: string;
  columns: string[];
  rows: Record<string, unknown>[];
  page: number;
  rowCount?: number;
}

export interface DbQueryResultMessage {
  type: 'queryResult';
  columns?: string[];
  rows?: Record<string, unknown>[];
  changes?: number;
}

export interface DbErrorMessage {
  type: 'error';
  message: string;
}

export type DbInboundMessage =
  | DbSchemaMessage
  | DbTableDataMessage
  | DbQueryResultMessage
  | DbErrorMessage;

export type DbOutboundMessage =
  | { type: 'ready' }
  | { type: 'getTableData'; table: string; page: number; pageSize: number }
  | { type: 'runQuery'; sql: string };
