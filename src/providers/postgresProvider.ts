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

interface PostgresColumnInfo {
    name: string;
    type: string;
    pk?: number;
    notnull?: number;
}

function quoteIdentifier(value: string): string {
    return `"${value.replace(/"/g, '""')}"`;
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
    const host =
        hint.host ||
        (await promptForValue(
            'Enter the PostgreSQL host',
            'db.example.com or 127.0.0.1',
            hint.host
        ));
    if (!host) {
        return undefined;
    }

    const portText =
        String(hint.port || '') ||
        (await promptForValue(
            'Enter the PostgreSQL port',
            '5432',
            hint.port ? String(hint.port) : '5432',
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
        hint.database ||
        (await promptForValue(
            'Enter the PostgreSQL database name',
            'postgres',
            hint.database
        ));
    if (!database) {
        return undefined;
    }

    const user =
        hint.user ||
        (await promptForValue(
            'Enter the PostgreSQL username',
            'postgres',
            hint.user
        ));
    if (!user) {
        return undefined;
    }

    const password =
        hint.password ||
        (await promptForValue(
            'Enter the PostgreSQL password',
            'Password for this database user',
            '',
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
        host,
        port,
        database,
        user,
        password,
        ssl: hint.ssl,
        label: hint.label,
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

export class PostgresProvider {
    static async openConnectionPanel(
        context: vscode.ExtensionContext,
        hint: Partial<PostgresConnectionConfig>
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

        panel.webview.html = buildDbHtml(context.extensionPath, panel.webview, 'PostgreSQL', config.label);

        const clientConfig = {
            host: config.host,
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

                        const columns = await queryRows<{
                            schema_name: string;
                            table_name: string;
                            column_name: string;
                            data_type: string;
                            is_nullable: 'YES' | 'NO';
                        }>(
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
                            primaryKeys.map(
                                (row) => `${row.schema_name}.${row.table_name}.${row.column_name}`
                            )
                        );
                        const columnMap = new Map<string, PostgresColumnInfo[]>();

                        for (const column of columns) {
                            const key = `${column.schema_name}.${column.table_name}`;
                            const current = columnMap.get(key) || [];
                            current.push({
                                name: column.column_name,
                                type: column.data_type,
                                pk: pkLookup.has(
                                    `${column.schema_name}.${column.table_name}.${column.column_name}`
                                )
                                    ? 1
                                    : 0,
                                notnull: column.is_nullable === 'NO' ? 1 : 0,
                            });
                            columnMap.set(key, current);
                        }

                        panel.webview.postMessage({
                            type: 'schema',
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
                            dbSize: 0,
                            sourceLabel:
                                config.label ||
                                `${config.host}:${config.port}/${config.database}`,
                            dbType: 'PostgreSQL',
                        });
                        break;
                    }
                    case 'getTableData': {
                        await ensureConnected();
                        const pageSize = msg.pageSize ?? 200;
                        const offset = (msg.page ?? 0) * pageSize;
                        const { schema, table } = parseTableReference(String(msg.table));
                        const tableRef = `${quoteIdentifier(schema)}.${quoteIdentifier(table)}`;
                        const countResult = await client.query<{ count: string }>(
                            `SELECT COUNT(*)::text AS count FROM ${tableRef}`
                        );
                        const rowCount = Number(countResult.rows[0]?.count ?? '0');
                        const rowsResult = await client.query(
                            `SELECT * FROM ${tableRef} LIMIT $1 OFFSET $2`,
                            [pageSize, offset]
                        );
                        const columns = rowsResult.fields.map((field) => field.name);
                        panel.webview.postMessage({
                            type: 'tableData',
                            table: msg.table,
                            columns,
                            rows: rowsResult.rows,
                            page: msg.page ?? 0,
                            rowCount,
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
