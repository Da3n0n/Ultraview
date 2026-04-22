import * as vscode from 'vscode';
import * as path from 'path';
import { buildDbHtml } from '../webview/dbHtml';

interface PostgresField {
    name: string;
}

interface PostgresQueryResult<T = Record<string, unknown>> {
    rows: T[];
    rowCount: number | null;
    fields: PostgresField[];
}

interface PostgresClient {
    connect(): Promise<void>;
    end(): Promise<void>;
    query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<PostgresQueryResult<T>>;
}

const { Client } = require('pg') as {
    Client: new (config: Record<string, unknown>) => PostgresClient;
};

interface PostgresConnectionConfig {
    host: string;
    port: number;
    database: string;
    user: string;
    password: string;
    ssl?: boolean;
    label?: string;
}

interface OpenPostgresPanelOptions {
    onConnected?: (config: PostgresConnectionConfig) => Thenable<void> | Promise<void> | void;
}

interface PostgresColumnInfo {
    name: string;
    type: string;
    pk?: number;
    notnull?: number;
}

interface PostgresTableColumnRow {
    schema_name: string;
    table_name: string;
    column_name: string;
    data_type: string;
    is_nullable: 'YES' | 'NO';
}

function looksLikePostgresConnectionString(value?: string): boolean {
    return !!value && /^postgres(?:ql)?:\/\//i.test(value.trim());
}

function parsePostgresConnectionString(value: string): Partial<PostgresConnectionConfig> | undefined {
    if (!looksLikePostgresConnectionString(value)) {
        return undefined;
    }

    try {
        const url = new URL(value.trim());
        return {
            host: url.hostname || undefined,
            port: url.port ? Number(url.port) : 5432,
            database: url.pathname.replace(/^\/+/, '') || undefined,
            user: url.username ? decodeURIComponent(url.username) : undefined,
            password: url.password ? decodeURIComponent(url.password) : undefined,
            ssl:
                url.searchParams.get('sslmode') === 'require' ||
                url.searchParams.get('ssl') === 'true' ||
                undefined,
        };
    } catch {
        return undefined;
    }
}

function normalizeConnectionHint(
    hint: Partial<PostgresConnectionConfig>
): Partial<PostgresConnectionConfig> {
    const merged: Partial<PostgresConnectionConfig> = { ...hint };

    for (const key of ['host', 'database', 'user', 'password'] as const) {
        const rawValue = hint[key];
        if (typeof rawValue !== 'string' || !looksLikePostgresConnectionString(rawValue)) {
            continue;
        }

        const parsed = parsePostgresConnectionString(rawValue);
        if (!parsed) {
            continue;
        }

        Object.assign(merged, parsed);
        if (key === 'password' && parsed.password) {
            merged.password = parsed.password;
        }
    }

    return merged;
}

function quoteIdentifier(value: string): string {
    return `"${value.replace(/"/g, '""')}"`;
}

function quoteTableReference(value: string): string {
    const { schema, table } = parseTableReference(value);
    return `${quoteIdentifier(schema)}.${quoteIdentifier(table)}`;
}

function asNullableValue(value: unknown): unknown {
    if (value === '__UV_NULL__') {
        return null;
    }
    return value;
}

function parseTableReference(value: string): { schema: string; table: string } {
    const separator = value.indexOf('.');
    if (separator <= 0 || separator === value.length - 1) {
        return { schema: 'public', table: value };
    }

    return {
        schema: value.slice(0, separator),
        table: value.slice(separator + 1),
    };
}

async function promptForValue(
    prompt: string,
    placeHolder: string,
    value = '',
    password = false,
    validateInput?: (value: string) => string | undefined
): Promise<string | undefined> {
    const input = await vscode.window.showInputBox({
        prompt,
        placeHolder,
        value,
        password,
        ignoreFocusOut: true,
        validateInput,
    });

    const trimmed = input?.trim();
    return trimmed ? trimmed : undefined;
}

async function resolveConnectionConfig(
    hint: Partial<PostgresConnectionConfig>
): Promise<PostgresConnectionConfig | undefined> {
    const normalizedHint = normalizeConnectionHint(hint);
    const parsedHint =
        parsePostgresConnectionString(normalizedHint.host || '') ||
        parsePostgresConnectionString(normalizedHint.database || '') ||
        parsePostgresConnectionString(normalizedHint.user || '') ||
        parsePostgresConnectionString(normalizedHint.password || '') ||
        undefined;
    const mergedHint: Partial<PostgresConnectionConfig> = {
        ...normalizedHint,
        ...parsedHint,
    };

    const host =
        mergedHint.host ||
        (await promptForValue(
            'Enter the PostgreSQL host or paste the full PostgreSQL URL',
            'db.example.com, 127.0.0.1, or postgresql://user:pass@host:5432/db',
            mergedHint.host
        ));
    if (!host) {
        return undefined;
    }

    const parsedHostValue = parsePostgresConnectionString(host);
    const finalHint: Partial<PostgresConnectionConfig> = {
        ...mergedHint,
        ...parsedHostValue,
        host: parsedHostValue?.host || host,
    };

    if (looksLikePostgresConnectionString(finalHint.host)) {
        const parsedFinalHost = parsePostgresConnectionString(finalHint.host || '');
        if (parsedFinalHost?.host) {
            Object.assign(finalHint, parsedFinalHost);
            finalHint.host = parsedFinalHost.host;
        }
    }

    const portText =
        (finalHint.port ? String(finalHint.port) : '') ||
        (await promptForValue(
            'Enter the PostgreSQL port',
            '5432',
            finalHint.port ? String(finalHint.port) : '5432',
            false,
            (value) => {
                if (!value.trim()) {
                    return 'Port is required.';
                }
                const port = Number(value);
                return Number.isInteger(port) && port > 0 && port <= 65535
                    ? undefined
                    : 'Enter a valid port number.';
            }
        ));
    if (!portText) {
        return undefined;
    }

    const database =
        finalHint.database ||
        (await promptForValue(
            'Enter the PostgreSQL database name',
            'postgres',
            finalHint.database
        ));
    if (!database) {
        return undefined;
    }

    const user =
        finalHint.user ||
        (await promptForValue(
            'Enter the PostgreSQL username',
            'postgres',
            finalHint.user
        ));
    if (!user) {
        return undefined;
    }

    const password =
        finalHint.password ||
        (await promptForValue(
            'Enter the PostgreSQL password',
            'Password for this database user',
            finalHint.password || '',
            true,
            (value) => (value.trim() ? undefined : 'Password is required.')
        ));
    if (!password) {
        return undefined;
    }

    const port = Number(portText);
    if (!Number.isInteger(port) || port <= 0 || port > 65535) {
        vscode.window.showErrorMessage('Invalid PostgreSQL port.');
        return undefined;
    }

    return {
        host: finalHint.host || host,
        port,
        database,
        user,
        password,
        ssl: finalHint.ssl,
        label: finalHint.label,
    };
}

async function queryRows<T extends Record<string, unknown>>(
    client: PostgresClient,
    sql: string,
    params: unknown[] = []
): Promise<T[]> {
    const result = await client.query<T>(sql, params);
    return result.rows;
}

async function loadSchema(client: PostgresClient): Promise<{
    tables: Array<{ name: string; rowCount: null; columns: PostgresColumnInfo[] }>;
}> {
    const tables = await queryRows<{
        schema_name: string;
        table_name: string;
    }>(
        client,
        `SELECT table_schema AS schema_name, table_name
         FROM information_schema.tables
         WHERE table_type = 'BASE TABLE'
           AND table_schema NOT IN ('pg_catalog', 'information_schema')
         ORDER BY table_schema, table_name`
    );

    const columns = await queryRows<PostgresTableColumnRow>(
        client,
        `SELECT table_schema AS schema_name,
                table_name,
                column_name,
                data_type,
                is_nullable
         FROM information_schema.columns
         WHERE table_schema NOT IN ('pg_catalog', 'information_schema')
         ORDER BY table_schema, table_name, ordinal_position`
    );

    const primaryKeys = await queryRows<{
        schema_name: string;
        table_name: string;
        column_name: string;
    }>(
        client,
        `SELECT kcu.table_schema AS schema_name,
                kcu.table_name,
                kcu.column_name
         FROM information_schema.table_constraints tc
         JOIN information_schema.key_column_usage kcu
           ON tc.constraint_name = kcu.constraint_name
          AND tc.table_schema = kcu.table_schema
         WHERE tc.constraint_type = 'PRIMARY KEY'
           AND tc.table_schema NOT IN ('pg_catalog', 'information_schema')`
    );

    const pkLookup = new Set(
        primaryKeys.map((row) => `${row.schema_name}.${row.table_name}.${row.column_name}`)
    );
    const columnMap = new Map<string, PostgresColumnInfo[]>();

    for (const column of columns) {
        const key = `${column.schema_name}.${column.table_name}`;
        const current = columnMap.get(key) || [];
        current.push({
            name: column.column_name,
            type: column.data_type,
            pk: pkLookup.has(`${column.schema_name}.${column.table_name}.${column.column_name}`)
                ? 1
                : 0,
            notnull: column.is_nullable === 'NO' ? 1 : 0,
        });
        columnMap.set(key, current);
    }

    return {
        tables: tables.map((table) => {
            const key = `${table.schema_name}.${table.table_name}`;
            const label =
                table.schema_name === 'public'
                    ? table.table_name
                    : `${table.schema_name}.${table.table_name}`;
            return {
                name: label,
                rowCount: null,
                columns: columnMap.get(key) || [],
            };
        }),
    };
}

export class PostgresProvider {
    static async openConnectionPanel(
        context: vscode.ExtensionContext,
        hint: Partial<PostgresConnectionConfig>,
        options?: OpenPostgresPanelOptions
    ): Promise<void> {
        const config = await resolveConnectionConfig(hint);
        if (!config) {
            return;
        }

        const panel = vscode.window.createWebviewPanel(
            'ultraview.postgres.panel',
            `Postgres: ${config.label || config.database}`,
            vscode.ViewColumn.Active,
            {
                enableScripts: true,
                retainContextWhenHidden: true,
                localResourceRoots: [vscode.Uri.file(path.join(context.extensionPath, 'dist'))],
            }
        );

        panel.webview.html = buildDbHtml(
            context.extensionPath,
            panel.webview,
            'PostgreSQL',
            config.label || `${config.host}:${config.port}/${config.database}`,
            config.database
        );

        const clientConfig = {
            host: parsePostgresConnectionString(config.host)?.host || config.host,
            port: config.port,
            database: config.database,
            user: config.user,
            password: config.password,
            ssl: config.ssl ? { rejectUnauthorized: false } : undefined,
        };

        const client = new Client(clientConfig);
        let connected = false;

        const ensureConnected = async (): Promise<void> => {
            if (!connected) {
                await client.connect();
                connected = true;
            }
        };

        panel.webview.onDidReceiveMessage(async (msg) => {
            try {
                switch (msg.type) {
                    case 'ready': {
                        await ensureConnected();
                        const schemaState = await loadSchema(client);

                        panel.webview.postMessage({
                            type: 'schema',
                            tables: schemaState.tables,
                            dbSize: 0,
                            sourceLabel:
                                config.label ||
                                `${config.host}:${config.port}/${config.database}`,
                            dbType: 'PostgreSQL',
                            dbName: config.database,
                            canEditData: true,
                            canEditSchema: true,
                        });
                        await options?.onConnected?.(config);
                        break;
                    }
                    case 'getTableData': {
                        await ensureConnected();
                        const pageSize = msg.pageSize ?? 200;
                        const offset = (msg.page ?? 0) * pageSize;
                        const tableRef = quoteTableReference(String(msg.table));
                        const countResult = await client.query<{ count: string }>(
                            `SELECT COUNT(*)::text AS count FROM ${tableRef}`
                        );
                        const rowCount = Number(countResult.rows[0]?.count ?? '0');
                        const rowsResult = await client.query(
                            `SELECT ctid::text AS "__uv_row_id", * FROM ${tableRef} LIMIT $1 OFFSET $2`,
                            [pageSize, offset]
                        );
                        const columns = rowsResult.fields
                            .map((field) => field.name)
                            .filter((field) => field !== '__uv_row_id');
                        const rowIds = rowsResult.rows.map((row) => String(row.__uv_row_id ?? ''));
                        const rows = rowsResult.rows.map((row) => {
                            const next = { ...row };
                            delete next.__uv_row_id;
                            return next;
                        });
                        panel.webview.postMessage({
                            type: 'tableData',
                            table: msg.table,
                            columns,
                            rows,
                            page: msg.page ?? 0,
                            rowCount,
                            rowIds,
                        });
                        break;
                    }
                    case 'runQuery': {
                        await ensureConnected();
                        const result = await client.query(String(msg.sql));
                        panel.webview.postMessage({
                            type: 'queryResult',
                            columns: result.fields.map((field) => field.name),
                            rows: result.rows,
                            changes: typeof result.rowCount === 'number' ? result.rowCount : undefined,
                        });
                        break;
                    }
                    case 'updateCell': {
                        await ensureConnected();
                        const tableRef = quoteTableReference(String(msg.table));
                        await client.query(
                            `UPDATE ${tableRef} SET ${quoteIdentifier(String(msg.column))} = $1 WHERE ctid = $2::tid`,
                            [asNullableValue(msg.value), String(msg.rowId)]
                        );
                        panel.webview.postMessage({ type: 'actionComplete', message: 'Cell updated.' });
                        break;
                    }
                    case 'insertRow': {
                        await ensureConnected();
                        const tableRef = quoteTableReference(String(msg.table));
                        const entries = Object.entries(msg.values || {});
                        if (entries.length === 0) {
                            await client.query(`INSERT INTO ${tableRef} DEFAULT VALUES`);
                        } else {
                            const columns = entries.map(([column]) => quoteIdentifier(column)).join(', ');
                            const placeholders = entries.map((_, index) => `$${index + 1}`).join(', ');
                            await client.query(
                                `INSERT INTO ${tableRef} (${columns}) VALUES (${placeholders})`,
                                entries.map(([, value]) => asNullableValue(value))
                            );
                        }
                        panel.webview.postMessage({ type: 'actionComplete', message: 'Row added.' });
                        break;
                    }
                    case 'deleteRow': {
                        await ensureConnected();
                        const tableRef = quoteTableReference(String(msg.table));
                        await client.query(
                            `DELETE FROM ${tableRef} WHERE ctid = $1::tid`,
                            [String(msg.rowId)]
                        );
                        panel.webview.postMessage({ type: 'actionComplete', message: 'Row deleted.' });
                        break;
                    }
                    case 'createTable': {
                        await ensureConnected();
                        const tableName = String(msg.tableName || '').trim();
                        const columns = Array.isArray(msg.columns) ? msg.columns : [];
                        if (!tableName || columns.length === 0) {
                            throw new Error('Table name and at least one column are required.');
                        }
                        const columnSql = columns.map((column) => {
                            const parts = [
                                quoteIdentifier(String(column.name)),
                                String(column.type || 'text').trim(),
                            ];
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
                        await client.query(`CREATE TABLE ${quoteTableReference(tableName)} (${columnSql})`);
                        const schemaState = await loadSchema(client);
                        panel.webview.postMessage({
                            type: 'schema',
                            tables: schemaState.tables,
                            dbSize: 0,
                            sourceLabel: config.label || `${config.host}:${config.port}/${config.database}`,
                            dbType: 'PostgreSQL',
                            dbName: config.database,
                            canEditData: true,
                            canEditSchema: true,
                        });
                        panel.webview.postMessage({ type: 'actionComplete', message: 'Table created.' });
                        break;
                    }
                    case 'deleteTable': {
                        await ensureConnected();
                        await client.query(`DROP TABLE ${quoteTableReference(String(msg.table))}`);
                        const schemaState = await loadSchema(client);
                        panel.webview.postMessage({
                            type: 'schema',
                            tables: schemaState.tables,
                            dbSize: 0,
                            sourceLabel: config.label || `${config.host}:${config.port}/${config.database}`,
                            dbType: 'PostgreSQL',
                            dbName: config.database,
                            canEditData: true,
                            canEditSchema: true,
                        });
                        panel.webview.postMessage({ type: 'actionComplete', message: 'Table deleted.' });
                        break;
                    }
                    case 'addColumn': {
                        await ensureConnected();
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
                        await client.query(parts.join(' '));
                        const schemaState = await loadSchema(client);
                        panel.webview.postMessage({
                            type: 'schema',
                            tables: schemaState.tables,
                            dbSize: 0,
                            sourceLabel: config.label || `${config.host}:${config.port}/${config.database}`,
                            dbType: 'PostgreSQL',
                            dbName: config.database,
                            canEditData: true,
                            canEditSchema: true,
                        });
                        panel.webview.postMessage({ type: 'actionComplete', message: 'Column added.' });
                        break;
                    }
                    case 'deleteColumn': {
                        await ensureConnected();
                        await client.query(
                            `ALTER TABLE ${quoteTableReference(String(msg.table))} DROP COLUMN ${quoteIdentifier(String(msg.column))}`
                        );
                        const schemaState = await loadSchema(client);
                        panel.webview.postMessage({
                            type: 'schema',
                            tables: schemaState.tables,
                            dbSize: 0,
                            sourceLabel: config.label || `${config.host}:${config.port}/${config.database}`,
                            dbType: 'PostgreSQL',
                            dbName: config.database,
                            canEditData: true,
                            canEditSchema: true,
                        });
                        panel.webview.postMessage({ type: 'actionComplete', message: 'Column removed.' });
                        break;
                    }
                }
            } catch (error) {
                panel.webview.postMessage({
                    type: 'error',
                    message: error instanceof Error ? error.message : String(error),
                });
            }
        });

        panel.onDidDispose(() => {
            void client.end().catch(() => undefined);
        });
    }
}
