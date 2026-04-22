export interface DbInitialState {
  dbType: string;
  sourceLabel?: string;
  dbName?: string;
  canEditData?: boolean;
  canEditSchema?: boolean;
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
  dbName?: string;
  canEditData?: boolean;
  canEditSchema?: boolean;
}

export interface DbTableDataMessage {
  type: 'tableData';
  table: string;
  columns: string[];
  rows: Record<string, unknown>[];
  page: number;
  rowCount?: number;
  rowIds?: string[];
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

export interface DbActionMessage {
  type: 'actionComplete';
  message: string;
}

export type DbInboundMessage =
  | DbSchemaMessage
  | DbTableDataMessage
  | DbQueryResultMessage
  | DbErrorMessage
  | DbActionMessage;

export type DbOutboundMessage =
  | { type: 'ready' }
  | { type: 'getTableData'; table: string; page: number; pageSize: number }
  | { type: 'runQuery'; sql: string }
  | { type: 'updateCell'; table: string; rowId: string; column: string; value: unknown }
  | { type: 'insertRow'; table: string; values: Record<string, unknown> }
  | { type: 'deleteRow'; table: string; rowId: string }
  | { type: 'createTable'; tableName: string; columns: Array<{ name: string; type: string; notnull?: boolean; primaryKey?: boolean; defaultValue?: string }> }
  | { type: 'deleteTable'; table: string }
  | { type: 'addColumn'; table: string; column: { name: string; type: string; notnull?: boolean; defaultValue?: string } }
  | { type: 'deleteColumn'; table: string; column: string };
