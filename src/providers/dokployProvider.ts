import * as vscode from 'vscode';
import { buildDokployHtml } from '../dokploy/dokployUi';
import { PostgresProvider } from './postgresProvider';
import { openUrlInVsCodeBrowser } from '../utils/browser';

const DOKPLOY_CONFIG_KEY = 'dokploy.url';
const DOKPLOY_PROFILES_KEY = 'ultraview.dokploy.profiles.v1';
const DOKPLOY_ACTIVE_PROFILE_KEY = 'ultraview.dokploy.activeProfile.v1';
const DOKPLOY_PROFILE_CACHE_KEY = 'ultraview.dokploy.profileCache.v1';
const DOKPLOY_TOKEN_SECRET_PREFIX = 'ultraview.dokploy.token.';
const DOKPLOY_DB_SECRET_PREFIX = 'ultraview.dokploy.db.';
const DOKPLOY_CACHE_STALE_MS = 5 * 1000;

interface DokployProfile {
    id: string;
    name: string;
    url: string;
}

interface DokployServiceState {
    id: string;
    name: string;
    projectName: string;
    type: 'application' | 'compose' | 'database';
    serviceKind?: string;
    serverId?: string;
    domains: string[];
    status: string;
    statusTone: 'success' | 'warning' | 'danger' | 'info' | 'muted';
    updatedAt?: number;
    databaseConnection?: DokployDatabaseConnectionHint;
    hasSavedConnection?: boolean;
}

interface DokployDatabaseConnectionHint {
    host?: string;
    port?: number;
    database?: string;
    user?: string;
    password?: string;
    ssl?: boolean;
}

interface DokployServerMetricState {
    serverId: string;
    serverName: string;
    cpuPercent?: number;
    memoryPercent?: number;
    memoryUsedBytes?: number;
    memoryTotalBytes?: number;
    diskPercent?: number;
    diskReadBytes?: number;
    diskWriteBytes?: number;
    networkRxBytes?: number;
    networkTxBytes?: number;
    updatedAt?: number;
}

interface DokployProfileCache {
    connected: boolean;
    projectCount?: number;
    services: DokployServiceState[];
    serverMetrics?: DokployServerMetricState[];
    version?: string;
    lastSyncedAt?: number;
    lastError?: string;
}

interface DokployProfileState extends DokployProfile {
    hasToken: boolean;
    isRefreshing: boolean;
    cache?: DokployProfileCache;
}

interface DokployServiceCandidate {
    id: string;
    name: string;
    projectName: string;
    type: 'application' | 'compose' | 'database';
    serviceKind?: string;
    serverId?: string;
    databaseConnection?: DokployDatabaseConnectionHint;
}

interface CandidateScanContext {
    projectName?: string;
    parentKey?: string;
}

interface DokployProjectRef {
    id: string;
    name: string;
}

interface DokployServerRef {
    id: string;
    name: string;
    ipAddress?: string;
    metricsPort?: number;
    metricsToken?: string;
    metricsUrl?: string;
}

function isGeneratedServiceName(name: string): boolean {
    const value = name.trim().toLowerCase();
    return /^[a-z0-9-]{10,}$/.test(value) || value.includes('postgres-') || value.includes('postgresql-');
}

function getPreferredDatabaseName(
    serviceName: string,
    databaseConnection?: DokployDatabaseConnectionHint
): string {
    const databaseName = databaseConnection?.database?.trim();
    if (!databaseName) {
        return serviceName;
    }

    if (!serviceName.trim() || isGeneratedServiceName(serviceName)) {
        return databaseName;
    }

    return serviceName;
}

function getDokployConfiguration(): vscode.WorkspaceConfiguration {
    return vscode.workspace.getConfiguration('ultraview');
}

function normalizeDokployUrl(rawValue: string): string {
    const trimmed = rawValue.trim();
    if (!trimmed) {
        return '';
    }

    const withScheme = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
    const parsed = new URL(withScheme);
    parsed.pathname = parsed.pathname.replace(/\/+$/, '');
    parsed.hash = '';
    return parsed.toString().replace(/\/$/, '');
}

function getTokenSecretKey(profileId: string): string {
    return `${DOKPLOY_TOKEN_SECRET_PREFIX}${profileId}`;
}

function getDatabaseSecretKey(profileId: string, serviceId: string): string {
    return `${DOKPLOY_DB_SECRET_PREFIX}${profileId}.${serviceId}`;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
    return value && typeof value === 'object' && !Array.isArray(value)
        ? (value as Record<string, unknown>)
        : undefined;
}

function readString(value: unknown): string | undefined {
    return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function readNumber(value: unknown): number | undefined {
    return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function readBoolean(value: unknown): boolean | undefined {
    if (typeof value === 'boolean') {
        return value;
    }

    if (typeof value === 'string') {
        const normalized = value.trim().toLowerCase();
        if (['true', '1', 'yes', 'on', 'require', 'required'].includes(normalized)) {
            return true;
        }
        if (['false', '0', 'no', 'off'].includes(normalized)) {
            return false;
        }
    }

    return undefined;
}

function readTimestamp(value: unknown): number | undefined {
    const numeric = readNumber(value);
    if (numeric !== undefined) {
        return numeric;
    }

    const text = readString(value);
    if (!text) {
        return undefined;
    }

    const parsed = Date.parse(text);
    return Number.isNaN(parsed) ? undefined : parsed;
}

function pickString(source: Record<string, unknown>, keys: string[]): string | undefined {
    for (const key of keys) {
        const value = readString(source[key]);
        if (value) {
            return value;
        }
    }
    return undefined;
}

function pickTimestamp(source: Record<string, unknown>, keys: string[]): number | undefined {
    for (const key of keys) {
        const value = readTimestamp(source[key]);
        if (value !== undefined) {
            return value;
        }
    }
    return undefined;
}

function pickNumber(source: Record<string, unknown>, keys: string[]): number | undefined {
    for (const key of keys) {
        const value = readNumber(source[key]);
        if (value !== undefined) {
            return value;
        }

        const text = readString(source[key]);
        if (!text) {
            continue;
        }

        const numeric = Number(text);
        if (Number.isFinite(numeric)) {
            return numeric;
        }
    }
    return undefined;
}

function pickBoolean(source: Record<string, unknown>, keys: string[]): boolean | undefined {
    for (const key of keys) {
        const value = readBoolean(source[key]);
        if (value !== undefined) {
            return value;
        }
    }
    return undefined;
}

function normalizeStatusTone(status: string): DokployServiceState['statusTone'] {
    const value = status.toLowerCase();
    if (
        value.includes('fail') ||
        value.includes('error') ||
        value.includes('crash') ||
        value.includes('stopped') ||
        value.includes('killed')
    ) {
        return 'danger';
    }

    if (
        value.includes('deploy') ||
        value.includes('queue') ||
        value.includes('build') ||
        value.includes('pull') ||
        value.includes('start') ||
        value.includes('pending') ||
        value.includes('running')
    ) {
        return 'info';
    }

    if (
        value.includes('success') ||
        value.includes('healthy') ||
        value.includes('ready') ||
        value.includes('active') ||
        value.includes('completed')
    ) {
        return 'success';
    }

    if (
        value.includes('warning') ||
        value.includes('degraded') ||
        value.includes('partial')
    ) {
        return 'warning';
    }

    return 'muted';
}

function createProfileId(): string {
    return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function labelFromUrl(url: string): string {
    try {
        const parsed = new URL(url);
        return parsed.hostname || url;
    } catch {
        return url;
    }
}

function sanitizeServiceCache(value: unknown): DokployServiceState | undefined {
    const record = asRecord(value);
    if (!record) {
        return undefined;
    }

    const id = readString(record.id);
    const name = readString(record.name);
    const projectName = readString(record.projectName);
    const type =
        record.type === 'application' || record.type === 'compose' || record.type === 'database'
            ? record.type
            : undefined;
    if (!id || !name || !projectName || !type) {
        return undefined;
    }

    const rawDomains = Array.isArray(record.domains) ? record.domains : [];
    const domains = rawDomains
        .map((entry) => readString(entry))
        .filter((entry): entry is string => !!entry);

    const status = readString(record.status) || 'Unknown';
    const databaseConnection = sanitizeDatabaseConnectionHint(record.databaseConnection);
    return {
        id,
        name: type === 'database' ? getPreferredDatabaseName(name, databaseConnection) : name,
        projectName,
        type,
        serviceKind: readString(record.serviceKind),
        serverId: readString(record.serverId),
        domains,
        status,
        statusTone:
            record.statusTone === 'success' ||
            record.statusTone === 'warning' ||
            record.statusTone === 'danger' ||
            record.statusTone === 'info' ||
            record.statusTone === 'muted'
                ? record.statusTone
                : normalizeStatusTone(status),
        updatedAt: readTimestamp(record.updatedAt),
        databaseConnection,
    };
}

function sanitizeDatabaseConnectionHint(value: unknown): DokployDatabaseConnectionHint | undefined {
    const record = asRecord(value);
    if (!record) {
        return undefined;
    }

    const port = pickNumber(record, ['port']);
    const ssl = pickBoolean(record, ['ssl']);
    const hint: DokployDatabaseConnectionHint = {
        host: pickString(record, ['host']),
        port,
        database: pickString(record, ['database']),
        user: pickString(record, ['user']),
        password: pickString(record, ['password']),
        ssl,
    };

    return hint.host || hint.port || hint.database || hint.user || hint.password || hint.ssl !== undefined
        ? hint
        : undefined;
}

function sanitizeServerMetricCache(value: unknown): DokployServerMetricState | undefined {
    const record = asRecord(value);
    if (!record) {
        return undefined;
    }

    const serverId = readString(record.serverId);
    const serverName = readString(record.serverName);
    if (!serverId || !serverName) {
        return undefined;
    }

    return {
        serverId,
        serverName,
        cpuPercent: readNumber(record.cpuPercent),
        memoryPercent: readNumber(record.memoryPercent),
        memoryUsedBytes: readNumber(record.memoryUsedBytes),
        memoryTotalBytes: readNumber(record.memoryTotalBytes),
        diskPercent: readNumber(record.diskPercent),
        diskReadBytes: readNumber(record.diskReadBytes),
        diskWriteBytes: readNumber(record.diskWriteBytes),
        networkRxBytes: readNumber(record.networkRxBytes),
        networkTxBytes: readNumber(record.networkTxBytes),
        updatedAt: readTimestamp(record.updatedAt),
    };
}

function sanitizeProfileCache(value: unknown): DokployProfileCache | undefined {
    const record = asRecord(value);
    if (!record) {
        return undefined;
    }

    const services = Array.isArray(record.services)
        ? record.services
              .map((entry) => sanitizeServiceCache(entry))
              .filter((entry): entry is DokployServiceState => !!entry)
        : [];
    const serverMetrics = Array.isArray(record.serverMetrics)
        ? record.serverMetrics
              .map((entry) => sanitizeServerMetricCache(entry))
              .filter((entry): entry is DokployServerMetricState => !!entry)
        : [];

    return {
        connected: !!record.connected,
        projectCount: readNumber(record.projectCount),
        services,
        serverMetrics,
        version: readString(record.version),
        lastSyncedAt: readTimestamp(record.lastSyncedAt),
        lastError: readString(record.lastError),
    };
}

function readProfiles(context: vscode.ExtensionContext): DokployProfile[] {
    const raw = context.globalState.get<unknown[]>(DOKPLOY_PROFILES_KEY, []);
    return raw
        .filter((value): value is DokployProfile => {
            return (
                !!value &&
                typeof value === 'object' &&
                typeof (value as DokployProfile).id === 'string' &&
                typeof (value as DokployProfile).name === 'string' &&
                typeof (value as DokployProfile).url === 'string'
            );
        })
        .map((profile) => ({
            id: profile.id,
            name: profile.name.trim() || labelFromUrl(profile.url),
            url: normalizeDokployUrl(profile.url),
        }))
        .filter((profile) => !!profile.url);
}

async function writeProfiles(
    context: vscode.ExtensionContext,
    profiles: DokployProfile[]
): Promise<void> {
    await context.globalState.update(DOKPLOY_PROFILES_KEY, profiles);
}

function readProfileCaches(context: vscode.ExtensionContext): Record<string, DokployProfileCache> {
    const raw = asRecord(context.globalState.get<unknown>(DOKPLOY_PROFILE_CACHE_KEY, {})) ?? {};
    const next: Record<string, DokployProfileCache> = {};
    for (const [key, value] of Object.entries(raw)) {
        const cache = sanitizeProfileCache(value);
        if (cache) {
            next[key] = cache;
        }
    }
    return next;
}

async function writeProfileCaches(
    context: vscode.ExtensionContext,
    caches: Record<string, DokployProfileCache>
): Promise<void> {
    await context.globalState.update(DOKPLOY_PROFILE_CACHE_KEY, caches);
}

function readActiveProfileId(context: vscode.ExtensionContext): string | undefined {
    return context.globalState.get<string>(DOKPLOY_ACTIVE_PROFILE_KEY);
}

async function setActiveProfileId(
    context: vscode.ExtensionContext,
    profileId: string | undefined
): Promise<void> {
    await context.globalState.update(DOKPLOY_ACTIVE_PROFILE_KEY, profileId);
}

async function syncActiveProfileToConfig(context: vscode.ExtensionContext): Promise<void> {
    const profiles = readProfiles(context);
    const activeId = readActiveProfileId(context);
    const activeProfile = profiles.find((profile) => profile.id === activeId) ?? profiles[0];
    await setDokployUrl(activeProfile?.url ?? '');
    if (activeProfile && activeProfile.id !== activeId) {
        await setActiveProfileId(context, activeProfile.id);
    }
}

async function migrateLegacyUrlIfNeeded(context: vscode.ExtensionContext): Promise<void> {
    const profiles = readProfiles(context);
    if (profiles.length > 0) {
        await syncActiveProfileToConfig(context);
        return;
    }

    const legacyUrl = getDokployUrl();
    if (!legacyUrl) {
        return;
    }

    const migrated: DokployProfile = {
        id: createProfileId(),
        name: labelFromUrl(legacyUrl),
        url: legacyUrl,
    };

    await writeProfiles(context, [migrated]);
    await setActiveProfileId(context, migrated.id);
    await syncActiveProfileToConfig(context);
}

async function promptForProfile(
    existing?: DokployProfile
): Promise<{ name: string; url: string } | undefined> {
    const urlInput = await vscode.window.showInputBox({
        prompt: existing ? 'Edit Dokploy URL' : 'Enter a Dokploy base URL',
        placeHolder: 'https://deploy.example.com or http://localhost:3000',
        value: existing?.url || 'https://',
        ignoreFocusOut: true,
        validateInput(value) {
            if (!value.trim()) {
                return 'URL is required.';
            }

            try {
                normalizeDokployUrl(value);
                return undefined;
            } catch {
                return 'Enter a valid http or https URL.';
            }
        },
    });

    if (urlInput === undefined) {
        return undefined;
    }

    const normalizedUrl = normalizeDokployUrl(urlInput);
    const nameInput = await vscode.window.showInputBox({
        prompt: existing ? 'Edit Dokploy profile name' : 'Name this Dokploy profile',
        placeHolder: 'Production, Staging, Local, Team A...',
        value: existing?.name || labelFromUrl(normalizedUrl),
        ignoreFocusOut: true,
        validateInput(value) {
            return value.trim() ? undefined : 'Profile name is required.';
        },
    });

    if (nameInput === undefined) {
        return undefined;
    }

    return {
        name: nameInput.trim(),
        url: normalizedUrl,
    };
}

async function promptForApiToken(profile: DokployProfile): Promise<string | undefined> {
    return vscode.window.showInputBox({
        prompt: `Enter Dokploy API key for ${profile.name}`,
        placeHolder: 'Paste API key from Dokploy profile settings',
        password: true,
        ignoreFocusOut: true,
        validateInput(value) {
            return value.trim() ? undefined : 'API key is required.';
        },
    });
}

async function openDokployUrlInEditor(url: string): Promise<void> {
    await openUrlInVsCodeBrowser(url, {
        promptExternalOnFailure: true,
        failureContext: 'Dokploy',
    });
}

async function ensureDokployUrl(): Promise<string | undefined> {
    const configured = getDokployUrl();
    if (configured) {
        return configured;
    }

    return configureDokployUrl();
}

function flattenObjects(value: unknown): Record<string, unknown>[] {
    if (Array.isArray(value)) {
        return value.flatMap((entry) => flattenObjects(entry));
    }

    const record = asRecord(value);
    if (!record) {
        return [];
    }

    return [record];
}

function buildDomainLabel(domain: Record<string, unknown>): string | undefined {
    const host = pickString(domain, ['host', 'domain']);
    if (!host) {
        return undefined;
    }

    const path = readString(domain.path);
    return path ? `${host}${path}` : host;
}

function extractDomains(payload: unknown): string[] {
    const seen = new Set<string>();
    const domains: string[] = [];
    for (const record of flattenObjects(payload)) {
        const host = buildDomainLabel(record);
        if (!host || seen.has(host)) {
            continue;
        }

        seen.add(host);
        domains.push(host);
    }
    return domains;
}

function extractDeploymentRecords(payload: unknown): Record<string, unknown>[] {
    const records = flattenObjects(payload);
    return records.filter((record) => {
        return (
            !!pickString(record, ['deploymentId', 'status', 'state', 'title', 'description']) ||
            pickTimestamp(record, ['createdAt', 'updatedAt', 'finishedAt', 'startedAt']) !== undefined
        );
    });
}

function summarizeDeploymentStatus(payload: unknown): { status: string; updatedAt?: number } {
    const records = extractDeploymentRecords(payload);
    if (records.length === 0) {
        return { status: 'No deployments yet' };
    }

    const sorted = [...records].sort((left, right) => {
        const leftTime =
            pickTimestamp(left, ['updatedAt', 'finishedAt', 'createdAt', 'startedAt']) ?? 0;
        const rightTime =
            pickTimestamp(right, ['updatedAt', 'finishedAt', 'createdAt', 'startedAt']) ?? 0;
        return rightTime - leftTime;
    });

    const latest = sorted[0];
    const status =
        pickString(latest, ['status', 'state', 'phase', 'result']) ||
        pickString(latest, ['title', 'description']) ||
        'Unknown';

    return {
        status,
        updatedAt: pickTimestamp(latest, ['updatedAt', 'finishedAt', 'createdAt', 'startedAt']),
    };
}

function flattenRecords(value: unknown): Record<string, unknown>[] {
    const records: Record<string, unknown>[] = [];

    const scan = (entry: unknown): void => {
        if (Array.isArray(entry)) {
            entry.forEach(scan);
            return;
        }

        const record = asRecord(entry);
        if (!record) {
            return;
        }

        records.push(record);
        Object.values(record).forEach(scan);
    };

    scan(value);
    return records;
}

function extractEnvVars(value: unknown): Record<string, string> {
    const vars: Record<string, string> = {};

    for (const record of flattenRecords(value)) {
        const key =
            pickString(record, ['name', 'key', 'envKey', 'variable', 'envName']) ||
            pickString(record, ['slug']);
        const recordValue = pickString(record, ['value', 'envValue']);

        if (!key || !recordValue) {
            continue;
        }

        vars[key.toUpperCase()] = recordValue;
    }

    return vars;
}

function isLikelyPostgresService(serviceKind?: string): boolean {
    return (serviceKind || '').toLowerCase().includes('postgres');
}

function parsePostgresConnectionString(value: string): DokployDatabaseConnectionHint | undefined {
    if (!/^postgres(?:ql)?:\/\//i.test(value.trim())) {
        return undefined;
    }

    try {
        const url = new URL(value.trim());
        return {
            host: url.hostname || undefined,
            port: url.port ? Number(url.port) : 5432,
            database: url.pathname.replace(/^\/+/, '') || undefined,
            user: url.username ? decodeURIComponent(url.username) : undefined,
            ssl:
                url.searchParams.get('sslmode') === 'require' ||
                url.searchParams.get('ssl') === 'true' ||
                undefined,
        };
    } catch {
        return undefined;
    }
}

function extractPostgresConnectionHint(value: unknown): DokployDatabaseConnectionHint | undefined {
    const env = extractEnvVars(value);
    const records = flattenRecords(value);

    const parseConnectionUrl = (): Partial<DokployDatabaseConnectionHint> => {
        const rawUrl =
            env.DATABASE_URL ||
            env.POSTGRES_URL ||
            env.POSTGRES_URI ||
            env.POSTGRESQL_URL ||
            records
                .map((record) =>
                    pickString(record, [
                        'databaseUrl',
                        'connectionString',
                        'connectionUri',
                        'postgresUrl',
                        'postgresUri',
                    ])
                )
                .find((entry) => !!entry);
        if (!rawUrl) {
            return {};
        }

        try {
            const url = new URL(rawUrl);
            return {
                host: url.hostname || undefined,
                port: url.port ? Number(url.port) : undefined,
                database: url.pathname.replace(/^\/+/, '') || undefined,
                user: url.username || undefined,
                ssl:
                    url.searchParams.get('sslmode') === 'require' ||
                    url.searchParams.get('ssl') === 'true' ||
                    undefined,
            };
        } catch {
            return {};
        }
    };

    const fromUrl = parseConnectionUrl();
    const directHost = records
        .map((record) =>
            pickString(record, [
                'host',
                'hostname',
                'dbHost',
                'databaseHost',
                'postgresHost',
                'pgHost',
                'publicHost',
                'internalHost',
            ])
        )
        .find((entry) => !!entry);
    const directPort = records
        .map((record) =>
            pickNumber(record, ['port', 'dbPort', 'databasePort', 'postgresPort', 'pgPort'])
        )
        .find((entry) => entry !== undefined);
    const directDatabase = records
        .map((record) =>
            pickString(record, ['database', 'databaseName', 'dbName', 'postgresDb', 'postgresDatabase'])
        )
        .find((entry) => !!entry);
    const directUser = records
        .map((record) =>
            pickString(record, ['user', 'username', 'dbUser', 'databaseUser', 'postgresUser'])
        )
        .find((entry) => !!entry);
    const directSsl = records
        .map((record) =>
            pickBoolean(record, ['ssl', 'sslEnabled', 'requireSsl', 'tls', 'tlsEnabled'])
        )
        .find((entry) => entry !== undefined);
    const hostFieldUrl = [directHost, env.POSTGRES_HOST, env.PGHOST, env.DB_HOST]
        .map((entry) => (entry ? parsePostgresConnectionString(entry) : undefined))
        .find((entry) => !!entry);

    const hint: DokployDatabaseConnectionHint = {
        host:
            hostFieldUrl?.host ||
            fromUrl.host ||
            env.POSTGRES_HOST ||
            env.PGHOST ||
            env.DB_HOST ||
            directHost,
        port:
            hostFieldUrl?.port ||
            fromUrl.port ||
            (env.POSTGRES_PORT ? Number(env.POSTGRES_PORT) : undefined) ||
            (env.PGPORT ? Number(env.PGPORT) : undefined) ||
            directPort,
        database:
            hostFieldUrl?.database ||
            fromUrl.database ||
            env.POSTGRES_DB ||
            env.PGDATABASE ||
            env.DB_NAME ||
            directDatabase,
        user:
            hostFieldUrl?.user ||
            fromUrl.user ||
            env.POSTGRES_USER ||
            env.PGUSER ||
            env.DB_USER ||
            directUser,
        ssl:
            hostFieldUrl?.ssl ??
            fromUrl.ssl ??
            (env.PGSSLMODE ? env.PGSSLMODE.toLowerCase() === 'require' : undefined) ??
            directSsl,
    };

    return hint.host || hint.port || hint.database || hint.user || hint.ssl !== undefined
        ? hint
        : undefined;
}

function extractServiceCandidates(payload: unknown): DokployServiceCandidate[] {
    const seen = new Set<string>();
    const services: DokployServiceCandidate[] = [];
    const serviceKeys = new Set([
        'applications',
        'application',
        'composes',
        'compose',
        'services',
        'service',
    ]);

    function resolveProjectName(
        record: Record<string, unknown>,
        context: CandidateScanContext
    ): string {
        return (
            pickString(record, ['projectName', 'project']) ||
            context.projectName ||
            pickString(record, ['name']) ||
            'Project'
        );
    }

    function pushCandidate(
        type: DokployServiceCandidate['type'],
        id: string,
        item: Record<string, unknown>,
        projectName: string,
        serviceKind?: string
    ): void {
        const uniqueId = `${type}:${id}`;
        if (seen.has(uniqueId)) {
            return;
        }

        seen.add(uniqueId);
        const databaseConnection =
            type === 'database' && isLikelyPostgresService(serviceKind)
                ? extractPostgresConnectionHint(item)
                : undefined;
        services.push({
            id,
            name:
                type === 'database'
                    ? getPreferredDatabaseName(
                          pickString(item, ['name', 'appName', 'slug', 'serviceName']) || id,
                          databaseConnection
                      )
                    : pickString(item, ['name', 'appName', 'slug', 'serviceName']) || id,
            projectName,
            type,
            serviceKind,
            serverId: pickString(item, ['serverId']),
            databaseConnection,
        });
    }

    function inferType(
        item: Record<string, unknown>,
        context: CandidateScanContext
    ): DokployServiceCandidate['type'] | undefined {
        if (readString(item.applicationId)) {
            return 'application';
        }
        if (readString(item.composeId)) {
            return 'compose';
        }
        if (
            readString(item.postgresId) ||
            readString(item.mysqlId) ||
            readString(item.mariadbId) ||
            readString(item.mongoId) ||
            readString(item.redisId)
        ) {
            return 'database';
        }
        if (readString(item.appId)) {
            return 'application';
        }
        if (readString(item.serviceId)) {
            return 'compose';
        }

        const parentKey = (context.parentKey || '').toLowerCase();
        if (parentKey.includes('application')) {
            return 'application';
        }
        if (parentKey.includes('compose')) {
            return 'compose';
        }

        const serviceType = readString(item.type)?.toLowerCase();
        if (serviceType === 'application' || serviceType === 'compose' || serviceType === 'database') {
            return serviceType;
        }
        if (serviceType?.includes('docker-compose') || serviceType?.includes('compose')) {
            return 'compose';
        }
        if (
            serviceType?.includes('postgres') ||
            serviceType?.includes('mysql') ||
            serviceType?.includes('mariadb') ||
            serviceType?.includes('mongo') ||
            serviceType?.includes('redis') ||
            serviceType?.includes('database')
        ) {
            return 'database';
        }
        if (readString(item.appName) && parentKey.includes('service')) {
            return 'application';
        }

        return undefined;
    }

    function readCandidateId(
        item: Record<string, unknown>,
        type: DokployServiceCandidate['type']
    ): string | undefined {
        if (type === 'application') {
            return readString(item.applicationId) || readString(item.appId) || readString(item.id);
        }
        if (type === 'compose') {
            return readString(item.composeId) || readString(item.serviceId) || readString(item.id);
        }
        return (
            readString(item.postgresId) ||
            readString(item.mysqlId) ||
            readString(item.mariadbId) ||
            readString(item.mongoId) ||
            readString(item.redisId) ||
            readString(item.databaseId) ||
            readString(item.id)
        );
    }

    function inferServiceKind(item: Record<string, unknown>, context: CandidateScanContext): string | undefined {
        const parentKey = (context.parentKey || '').toLowerCase();
        return (
            pickString(item, ['serviceKind', 'databaseType', 'type']) ||
            (parentKey.includes('postgres')
                ? 'Postgres'
                : parentKey.includes('mysql')
                  ? 'MySQL'
                  : parentKey.includes('mariadb')
                    ? 'MariaDB'
                    : parentKey.includes('mongo')
                      ? 'MongoDB'
                      : parentKey.includes('redis')
                        ? 'Redis'
                        : undefined)
        );
    }

    function scan(value: unknown, context: CandidateScanContext = {}): void {
        if (Array.isArray(value)) {
            for (const entry of value) {
                scan(entry, context);
            }
            return;
        }

        const record = asRecord(value);
        if (!record) {
            return;
        }

        const projectName = resolveProjectName(record, context);
        const type = inferType(record, context);
        if (type === 'application') {
            const id = readCandidateId(record, 'application');
            if (id) {
                pushCandidate('application', id, record, projectName, inferServiceKind(record, context));
            }
        } else if (type === 'compose') {
            const id = readCandidateId(record, 'compose');
            if (id) {
                pushCandidate('compose', id, record, projectName, inferServiceKind(record, context));
            }
        } else if (type === 'database') {
            const id = readCandidateId(record, 'database');
            if (id) {
                pushCandidate('database', id, record, projectName, inferServiceKind(record, context));
            }
        }

        for (const [key, child] of Object.entries(record)) {
            const nextContext: CandidateScanContext = {
                projectName,
                parentKey: key,
            };

            if (serviceKeys.has(key.toLowerCase()) && Array.isArray(child)) {
                for (const entry of child) {
                    scan(entry, nextContext);
                }
                continue;
            }

            scan(child, nextContext);
        }
    }

    scan(payload);

    return services.sort((left, right) => {
        return (
            left.projectName.localeCompare(right.projectName) ||
            left.name.localeCompare(right.name) ||
            left.type.localeCompare(right.type)
        );
    });
}

function extractSearchCandidates(
    payload: unknown,
    type: DokployServiceCandidate['type']
): DokployServiceCandidate[] {
    const items = Array.isArray(payload)
        ? payload
        : Array.isArray(asRecord(payload)?.items)
          ? (asRecord(payload)?.items as unknown[])
          : Array.isArray(asRecord(payload)?.data)
            ? (asRecord(payload)?.data as unknown[])
            : [];

    const candidates: DokployServiceCandidate[] = [];
    for (const entry of items) {
        const item = asRecord(entry);
        if (!item) {
            continue;
        }

        const id =
            type === 'application'
                ? readString(item.applicationId) || readString(item.appId) || readString(item.id)
                : type === 'compose'
                  ? readString(item.composeId) || readString(item.serviceId) || readString(item.id)
                  : readString(item.databaseId) || readString(item.id);

        if (!id) {
            continue;
        }

        candidates.push({
            id,
            name: pickString(item, ['name', 'appName', 'slug', 'serviceName']) || id,
            projectName: pickString(item, ['projectName', 'project', 'environmentName']) || 'Project',
            type,
            serviceKind:
                type === 'database'
                    ? pickString(item, ['databaseType', 'type']) || 'Database'
                    : pickString(item, ['type']),
        });
    }

    return candidates;
}

function extractProjectRefs(payload: unknown): DokployProjectRef[] {
    const projects = Array.isArray(payload) ? payload : [];

    return projects
        .map((entry) => {
            const item = asRecord(entry);
            if (!item) {
                return undefined;
            }

            const id = readString(item.projectId) || readString(item.id);
            if (!id) {
                return undefined;
            }

            return {
                id,
                name: pickString(item, ['name', 'projectName']) || 'Project',
            } satisfies DokployProjectRef;
        })
        .filter((entry): entry is DokployProjectRef => !!entry);
}

function extractServerRefs(payload: unknown): DokployServerRef[] {
    const servers = Array.isArray(payload) ? payload : [];
    const refs: DokployServerRef[] = [];

    for (const entry of servers) {
        const item = asRecord(entry);
        if (!item) {
            continue;
        }

        const id = readString(item.serverId) || readString(item.id);
        if (!id) {
            continue;
        }

        const metricsConfig = asRecord(item.metricsConfig);
        const serverMetrics = asRecord(metricsConfig?.server);
        const monitoringConfig =
            asRecord(item.monitoring) ||
            asRecord(item.monitoringConfig) ||
            asRecord(metricsConfig?.monitoring);
        const rawUrl =
            pickString(item, ['metricsUrl']) ||
            pickString(item, ['monitoringUrl']) ||
            pickString(serverMetrics ?? {}, ['url']) ||
            pickString(serverMetrics ?? {}, ['baseUrl']) ||
            pickString(monitoringConfig ?? {}, ['url', 'baseUrl']);
        const ipAddress = pickString(item, ['ipAddress', 'host', 'ip', 'address']);
        const metricsPort =
            readNumber(serverMetrics?.port) ||
            readNumber(monitoringConfig?.port) ||
            readNumber(item.metricsPort) ||
            4500;

        let metricsUrl = rawUrl;
        if (!metricsUrl && ipAddress) {
            const host = /^https?:\/\//i.test(ipAddress) ? ipAddress : `http://${ipAddress}`;
            metricsUrl = `${host.replace(/\/$/, '')}:${metricsPort}`;
        }

        refs.push({
            id,
            name: pickString(item, ['name']) || 'Server',
            ipAddress,
            metricsPort,
            metricsToken:
                pickString(item, ['metricsToken']) ||
                pickString(item, ['monitoringToken']) ||
                pickString(serverMetrics ?? {}, ['token']) ||
                pickString(metricsConfig ?? {}, ['token']) ||
                pickString(monitoringConfig ?? {}, ['token']),
            metricsUrl,
        });
    }

    return refs;
}

function collectNumericValues(value: unknown, out: Array<{ key: string; value: number }>): void {
    if (Array.isArray(value)) {
        value.forEach((entry) => collectNumericValues(entry, out));
        return;
    }

    const record = asRecord(value);
    if (!record) {
        return;
    }

    for (const [key, child] of Object.entries(record)) {
        const num = readNumber(child);
        if (num !== undefined) {
            out.push({ key: key.toLowerCase(), value: num });
            continue;
        }
        collectNumericValues(child, out);
    }
}

function normalizeMetricKey(value: string): string {
    return value.toLowerCase().replace(/[^a-z0-9]+/g, '');
}

function readMetricSample(value: unknown): number | undefined {
    const direct = readNumber(value);
    if (direct !== undefined) {
        return direct;
    }

    if (Array.isArray(value)) {
        if (value.length === 2) {
            const tupleSample = readNumber(value[1]);
            if (tupleSample !== undefined) {
                return tupleSample;
            }
        }
        for (let index = value.length - 1; index >= 0; index -= 1) {
            const sample = readMetricSample(value[index]);
            if (sample !== undefined) {
                return sample;
            }
        }
        return undefined;
    }

    const record = asRecord(value);
    if (!record) {
        return undefined;
    }

    return (
        readNumber(record.current) ??
        readNumber(record.last) ??
        readNumber(record.avg) ??
        readMetricSample(record.value) ??
        readMetricSample(record.values) ??
        readMetricSample(record.data)
    );
}

function collectStructuredMetricValues(value: unknown, out: Array<{ key: string; value: number }>): void {
    if (Array.isArray(value)) {
        value.forEach((entry) => collectStructuredMetricValues(entry, out));
        return;
    }

    const record = asRecord(value);
    if (!record) {
        return;
    }

    const metricRecord = asRecord(record.metric);
    const metricName =
        pickString(metricRecord ?? {}, ['__name__', 'name', 'metric']) ||
        pickString(record, ['name', 'metricName', 'seriesName']);
    const sample =
        readMetricSample(record.values) ??
        readMetricSample(record.value) ??
        readMetricSample(record.result) ??
        readMetricSample(record.data);

    if (metricName && sample !== undefined) {
        out.push({ key: normalizeMetricKey(metricName), value: sample });
    }

    Object.values(record).forEach((child) => collectStructuredMetricValues(child, out));
}

function pickMetricValue(
    values: Array<{ key: string; value: number }>,
    patterns: string[]
): number | undefined {
    for (const pattern of patterns) {
        const exact = values.find((entry) => entry.key === pattern);
        if (exact) {
            return exact.value;
        }
    }

    for (const pattern of patterns) {
        const partial = values.find((entry) => entry.key.includes(pattern));
        if (partial) {
            return partial.value;
        }
    }

    return undefined;
}

function normalizePercent(value: number | undefined): number | undefined {
    if (value === undefined || !Number.isFinite(value)) {
        return undefined;
    }
    if (value <= 1) {
        return value * 100;
    }
    return value;
}

function parseServerMetricState(server: DokployServerRef, payload: unknown): DokployServerMetricState | undefined {
    const values: Array<{ key: string; value: number }> = [];
    collectStructuredMetricValues(payload, values);
    collectNumericValues(payload, values);
    if (values.length === 0) {
        return undefined;
    }

    const cpuPercent = normalizePercent(
        pickMetricValue(values, [
            'cpupercent',
            'cpuusagepercent',
            'cpuusage',
            'cpu',
            'cpuusageseconds',
            'cpu_usage_percent',
            'cpu_usage'
        ])
    );
    const memoryPercent = normalizePercent(
        pickMetricValue(values, [
            'memorypercent',
            'memoryusagepercent',
            'memoryusagepercentage',
            'memorypercentage',
            'memoryusage_percentage',
            'memory_percentage'
        ])
    );
    const memoryUsedBytes = pickMetricValue(
        values,
        [
            'memoryusedbytes',
            'memoryusagebytes',
            'memorybytes',
            'memoryused',
            'memory_usage_bytes',
            'memory_working_set_bytes'
        ]
    );
    const memoryTotalBytes = pickMetricValue(
        values,
        ['memorytotalbytes', 'memorylimitbytes', 'memorytotal', 'memory_limit_bytes']
    );
    const diskPercent = normalizePercent(
        pickMetricValue(values, [
            'diskpercent',
            'diskusagepercent',
            'diskusagepercentage',
            'diskpercentage',
            'diskusage_percentage',
            'disk_percentage'
        ])
    );
    const diskReadBytes = pickMetricValue(
        values,
        ['diskreadbytes', 'ioreadbytes', 'readbytes', 'disk_read_bytes', 'disk_read_bytes_total']
    );
    const diskWriteBytes = pickMetricValue(
        values,
        ['diskwritebytes', 'iowritebytes', 'writebytes', 'disk_write_bytes', 'disk_write_bytes_total']
    );
    const networkRxBytes = pickMetricValue(
        values,
        [
            'networkrxbytes',
            'rxbytes',
            'networkreceivebytes',
            'receivedbytes',
            'network_receive_bytes',
            'network_receive_bytes_total'
        ]
    );
    const networkTxBytes = pickMetricValue(
        values,
        [
            'networktxbytes',
            'txbytes',
            'networktransmitbytes',
            'sentbytes',
            'network_transmit_bytes',
            'network_transmit_bytes_total'
        ]
    );

    if (
        cpuPercent === undefined &&
        memoryPercent === undefined &&
        memoryUsedBytes === undefined &&
        memoryTotalBytes === undefined &&
        diskPercent === undefined &&
        diskReadBytes === undefined &&
        diskWriteBytes === undefined &&
        networkRxBytes === undefined &&
        networkTxBytes === undefined
    ) {
        return undefined;
    }

    return {
        serverId: server.id,
        serverName: server.name,
        cpuPercent,
        memoryPercent,
        memoryUsedBytes,
        memoryTotalBytes,
        diskPercent,
        diskReadBytes,
        diskWriteBytes,
        networkRxBytes,
        networkTxBytes,
        updatedAt: Date.now(),
    };
}

async function fetchProfileServerMetrics(
    profile: DokployProfile,
    apiToken: string,
    candidates: DokployServiceCandidate[]
): Promise<DokployServerMetricState[]> {
    const serverIds = Array.from(
        new Set(candidates.map((candidate) => candidate.serverId).filter((value): value is string => !!value))
    );
    if (serverIds.length === 0) {
        return [];
    }

    const serversPayload = await fetchDokployJson(profile, apiToken, 'server.all').catch(() => []);
    const serverRefs = extractServerRefs(serversPayload);
    const matchingServers = serverRefs.filter((server) => serverIds.includes(server.id));
    const servers = (matchingServers.length ? matchingServers : serverRefs).filter(
        (server) => !!server.metricsUrl && !!server.metricsToken
    );
    if (servers.length === 0) {
        return [];
    }

    const metricResults = await Promise.allSettled(
        servers.map((server) =>
            fetchDokployJson(
                profile,
                apiToken,
                `server.getServerMetrics?url=${encodeURIComponent(server.metricsUrl ?? '')}&token=${encodeURIComponent(server.metricsToken ?? '')}&dataPoints=20`
            ).then((payload) => parseServerMetricState(server, payload))
        )
    );

    return metricResults
        .filter(
            (result): result is PromiseFulfilledResult<DokployServerMetricState | undefined> =>
                result.status === 'fulfilled'
        )
        .map((result) => result.value)
        .filter((entry): entry is DokployServerMetricState => !!entry);
}

async function fetchServiceCandidates(
    profile: DokployProfile,
    apiToken: string
): Promise<{ candidates: DokployServiceCandidate[]; projectCount?: number }> {
    const projectsPayload = await fetchDokployJson(profile, apiToken, 'project.all');
    const projects = extractProjectRefs(projectsPayload);
    const projectCount = projects.length || (Array.isArray(projectsPayload) ? projectsPayload.length : undefined);

    if (projects.length > 0) {
        const projectAppResults = await Promise.allSettled(
            projects.map((project) =>
                fetchDokployJson(
                    profile,
                    apiToken,
                    `project.app?projectId=${encodeURIComponent(project.id)}`
                ).then((payload) => ({
                    project,
                    candidates: extractServiceCandidates(
                        Array.isArray(payload)
                            ? payload.map((entry) => {
                                  const record = asRecord(entry);
                                  return record ? { ...record, projectName: project.name } : entry;
                              })
                            : payload
                    ),
                }))
            )
        );

        const projectAppCandidates = projectAppResults
            .filter(
                (
                    result
                ): result is PromiseFulfilledResult<{
                    project: DokployProjectRef;
                    candidates: DokployServiceCandidate[];
                }> => result.status === 'fulfilled'
            )
            .flatMap((result) => result.value.candidates);

        if (projectAppCandidates.length > 0) {
            return {
                projectCount,
                candidates: projectAppCandidates.sort((left, right) => {
                    return (
                        left.projectName.localeCompare(right.projectName) ||
                        left.name.localeCompare(right.name) ||
                        left.type.localeCompare(right.type)
                    );
                }),
            };
        }
    }

    const projectCandidates = extractServiceCandidates(projectsPayload);
    if (projectCandidates.length > 0) {
        return { candidates: projectCandidates, projectCount };
    }

    const fallbackResults = await Promise.allSettled([
        fetchDokployJson(profile, apiToken, 'application.search?limit=100'),
        fetchDokployJson(profile, apiToken, 'compose.search?limit=100'),
    ]);

    const applicationCandidates =
        fallbackResults[0].status === 'fulfilled'
            ? extractSearchCandidates(fallbackResults[0].value, 'application')
            : [];
    const composeCandidates =
        fallbackResults[1].status === 'fulfilled'
            ? extractSearchCandidates(fallbackResults[1].value, 'compose')
            : [];

    return {
        projectCount,
        candidates: [...applicationCandidates, ...composeCandidates].sort((left, right) => {
        return (
            left.projectName.localeCompare(right.projectName) ||
            left.name.localeCompare(right.name) ||
            left.type.localeCompare(right.type)
        );
        }),
    };
}

async function fetchDokployJson(
    profile: DokployProfile,
    apiToken: string,
    endpoint: string
): Promise<unknown> {
    const url = new URL(`/api/${endpoint}`, profile.url).toString();
    const response = await fetch(url, {
        headers: {
            Accept: 'application/json',
            Authorization: `Bearer ${apiToken}`,
            'x-api-key': apiToken,
        },
    });

    if (!response.ok) {
        const body = await response.text().catch(() => '');
        const detail = body ? ` ${body}` : '';
        throw new Error(`Dokploy API ${response.status}.${detail}`.trim());
    }

    const contentType = response.headers.get('content-type') || '';
    if (contentType.includes('application/json')) {
        return response.json();
    }

    return response.text();
}

async function fetchServiceState(
    profile: DokployProfile,
    apiToken: string,
    candidate: DokployServiceCandidate
): Promise<DokployServiceState> {
    if (candidate.type === 'database') {
        return {
            id: candidate.id,
            name: getPreferredDatabaseName(candidate.name, candidate.databaseConnection),
            projectName: candidate.projectName,
            type: 'database',
            serviceKind: candidate.serviceKind,
            serverId: candidate.serverId,
            domains: [],
            status: candidate.serviceKind || 'Managed database',
            statusTone: 'muted',
            databaseConnection: candidate.databaseConnection,
        };
    }

    const domainEndpoint =
        candidate.type === 'application'
            ? `domain.byApplicationId?applicationId=${encodeURIComponent(candidate.id)}`
            : `domain.byComposeId?composeId=${encodeURIComponent(candidate.id)}`;

    const deploymentEndpoint =
        candidate.type === 'application'
            ? `deployment.all?applicationId=${encodeURIComponent(candidate.id)}`
            : `deployment.allByCompose?composeId=${encodeURIComponent(candidate.id)}`;

    const [domainsResult, deploymentResult] = await Promise.allSettled([
        fetchDokployJson(profile, apiToken, domainEndpoint),
        fetchDokployJson(profile, apiToken, deploymentEndpoint),
    ]);

    const domains = domainsResult.status === 'fulfilled' ? extractDomains(domainsResult.value) : [];
    const deploymentSummary =
        deploymentResult.status === 'fulfilled'
            ? summarizeDeploymentStatus(deploymentResult.value)
            : {
                  status: domains.length > 0 ? 'Connected' : 'Unknown',
                  updatedAt: undefined,
              };

    const status = deploymentSummary.status || (domains.length > 0 ? 'Connected' : 'Unknown');
    return {
        id: candidate.id,
        name: candidate.name,
        projectName: candidate.projectName,
        type: candidate.type,
        serviceKind: candidate.serviceKind,
        serverId: candidate.serverId,
        domains,
        status,
        statusTone: normalizeStatusTone(status),
        updatedAt: deploymentSummary.updatedAt,
    };
}

export async function configureDokployUrl(
    context?: vscode.ExtensionContext
): Promise<string | undefined> {
    if (context) {
        await migrateLegacyUrlIfNeeded(context);
        const profiles = readProfiles(context);
        const activeId = readActiveProfileId(context);
        const active = profiles.find((profile) => profile.id === activeId) ?? profiles[0];
        const input = await promptForProfile(active);
        if (!input) {
            return undefined;
        }

        if (active) {
            const nextProfiles = profiles.map((profile) =>
                profile.id === active.id
                    ? { ...profile, name: input.name, url: input.url }
                    : profile
            );
            await writeProfiles(context, nextProfiles);
            await setActiveProfileId(context, active.id);
        } else {
            const profile: DokployProfile = {
                id: createProfileId(),
                name: input.name,
                url: input.url,
            };
            await writeProfiles(context, [profile]);
            await setActiveProfileId(context, profile.id);
        }

        await syncActiveProfileToConfig(context);
        return input.url;
    }

    const currentUrl = getDokployUrl();
    const profile = await promptForProfile(
        currentUrl ? { id: '', name: labelFromUrl(currentUrl), url: currentUrl } : undefined
    );

    if (!profile) {
        return undefined;
    }

    await setDokployUrl(profile.url);
    return profile.url;
}

export function getDokployUrl(): string {
    return normalizeDokployUrl(getDokployConfiguration().get<string>(DOKPLOY_CONFIG_KEY, ''));
}

async function setDokployUrl(url: string): Promise<void> {
    const target = vscode.workspace.workspaceFolders?.length
        ? vscode.ConfigurationTarget.Workspace
        : vscode.ConfigurationTarget.Global;

    await getDokployConfiguration().update(DOKPLOY_CONFIG_KEY, url, target);
}

export async function openDokployInEditor(): Promise<void> {
    const url = await ensureDokployUrl();
    if (!url) {
        return;
    }

    await openDokployUrlInEditor(url);
}

export async function openDokployExternally(): Promise<void> {
    const url = await ensureDokployUrl();
    if (!url) {
        return;
    }

    await vscode.env.openExternal(vscode.Uri.parse(url));
}

export class DokployProvider implements vscode.WebviewViewProvider {
    public static readonly viewId = 'ultraview.dokploy';
    private static readonly activeWebviews = new Map<vscode.Webview, 'sidebar' | 'panel'>();
    private static instance?: DokployProvider;
    private readonly refreshingProfileIds = new Set<string>();
    private initializePromise?: Promise<void>;
    private view?: vscode.WebviewView;

    constructor(private readonly context: vscode.ExtensionContext) {
        DokployProvider.instance = this;
        this.context.subscriptions.push(
            vscode.workspace.onDidChangeConfiguration((event) => {
                if (event.affectsConfiguration(`ultraview.${DOKPLOY_CONFIG_KEY}`)) {
                    void DokployProvider.refreshAllViews();
                }
            })
        );
    }

    static openAsPanel(context: vscode.ExtensionContext): void {
        const provider = new DokployProvider(context);
        const panel = vscode.window.createWebviewPanel(
            'ultraview.dokploy.panel',
            'Dokploy',
            vscode.ViewColumn.One,
            { enableScripts: true, retainContextWhenHidden: true }
        );

        provider.attachWebview(panel.webview, 'panel', panel.onDidDispose);
        panel.webview.html = buildDokployHtml(true);
    }

    resolveWebviewView(webviewView: vscode.WebviewView): void {
        this.view = webviewView;
        webviewView.webview.options = { enableScripts: true };
        this.attachWebview(webviewView.webview, 'sidebar', webviewView.onDidDispose);
        webviewView.webview.html = buildDokployHtml(false);

        webviewView.onDidChangeVisibility(() => {
            if (webviewView.visible) {
                void this.postState(webviewView.webview, 'sidebar');
                void this.refreshStaleProfiles();
            }
        });
    }

    static async refreshAllViews(): Promise<void> {
        const instance = DokployProvider.instance;
        if (!instance) {
            return;
        }

        await instance.ensureInitialized();
        const state = await instance.getState();
        for (const [webview, mode] of DokployProvider.activeWebviews.entries()) {
            await webview.postMessage({ type: 'state', ...state, mode });
        }
    }

    private attachWebview(
        webview: vscode.Webview,
        mode: 'sidebar' | 'panel',
        registerDispose: (listener: () => any) => vscode.Disposable
    ): void {
        DokployProvider.instance = this;
        DokployProvider.activeWebviews.set(webview, mode);
        registerDispose(() => {
            DokployProvider.activeWebviews.delete(webview);
        });

        webview.onDidReceiveMessage(
            async (msg) => {
                switch (msg.type) {
                    case 'ready':
                    case 'refresh':
                        await this.postState(webview, mode);
                        void this.refreshStaleProfiles();
                        break;
                    case 'configure':
                        await this.configureActiveProfile();
                        await this.postState(webview, mode);
                        break;
                    case 'openEditor':
                        await this.openActiveProfileInEditor();
                        break;
                    case 'openExternal':
                        await this.openActiveProfileExternally();
                        break;
                    case 'addProfile':
                        await this.addProfile();
                        break;
                    case 'activateProfile':
                        await this.activateProfile(String(msg.profileId || ''));
                        break;
                    case 'openProfile':
                        if (typeof msg.profileId === 'string') {
                            await this.openProfileInEditor(msg.profileId);
                        }
                        break;
                    case 'authProfileApi':
                        if (typeof msg.profileId === 'string') {
                            await this.connectProfileApi(msg.profileId);
                        }
                        break;
                    case 'disconnectProfileApi':
                        if (typeof msg.profileId === 'string') {
                            await this.disconnectProfileApi(msg.profileId);
                        }
                        break;
                    case 'refreshProfileData':
                        if (typeof msg.profileId === 'string') {
                            await this.refreshProfileSnapshot(msg.profileId, true);
                        }
                        break;
                    case 'deleteProfile':
                        if (typeof msg.profileId === 'string') {
                            await this.deleteProfile(msg.profileId);
                        }
                        break;
                    case 'openServiceDatabase':
                        if (
                            typeof msg.profileId === 'string' &&
                            typeof msg.serviceId === 'string'
                        ) {
                            await this.openServiceDatabase(msg.profileId, msg.serviceId);
                        }
                        break;
                }
            },
            undefined,
            this.context.subscriptions
        );
    }

    private async postState(webview: vscode.Webview, mode: 'sidebar' | 'panel'): Promise<void> {
        await this.ensureInitialized();
        const state = await this.getState();
        await webview.postMessage({
            type: 'state',
            ...state,
            mode,
        });
    }

    private async ensureInitialized(): Promise<void> {
        if (!this.initializePromise) {
            this.initializePromise = migrateLegacyUrlIfNeeded(this.context);
        }
        await this.initializePromise;
    }

    private async getState(): Promise<{
        url: string;
        profiles: DokployProfileState[];
        activeProfileId?: string;
    }> {
        await syncActiveProfileToConfig(this.context);
        const profiles = readProfiles(this.context);
        const caches = readProfileCaches(this.context);
        const activeProfileId = readActiveProfileId(this.context);
        const activeProfile =
            profiles.find((profile) => profile.id === activeProfileId) ?? profiles[0];
        const profilesWithState = await Promise.all(
            profiles.map(async (profile) => {
                const cache = caches[profile.id];
                const services = cache?.services
                    ? await Promise.all(
                          cache.services.map(async (service) => ({
                              ...service,
                              hasSavedConnection:
                                  service.type === 'database'
                                      ? !!(await this.context.secrets.get(
                                            getDatabaseSecretKey(profile.id, service.id)
                                        ))
                                      : false,
                          }))
                      )
                    : undefined;

                return {
                    ...profile,
                    hasToken: !!(await this.context.secrets.get(getTokenSecretKey(profile.id))),
                    isRefreshing: this.refreshingProfileIds.has(profile.id),
                    cache: cache ? { ...cache, services: services ?? cache.services } : cache,
                };
            })
        );

        return {
            url: activeProfile?.url ?? '',
            profiles: profilesWithState,
            activeProfileId: activeProfile?.id,
        };
    }

    private async refreshStaleProfiles(): Promise<void> {
        await this.ensureInitialized();
        const profiles = readProfiles(this.context);
        const caches = readProfileCaches(this.context);

        for (const profile of profiles) {
            const hasToken = !!(await this.context.secrets.get(getTokenSecretKey(profile.id)));
            if (!hasToken || this.refreshingProfileIds.has(profile.id)) {
                continue;
            }

            const cache = caches[profile.id];
            const isStale =
                !cache?.lastSyncedAt || Date.now() - cache.lastSyncedAt > DOKPLOY_CACHE_STALE_MS;
            if (isStale) {
                void this.refreshProfileSnapshot(profile.id, false);
            }
        }
    }

    private async openServiceDatabase(profileId: string, serviceId: string): Promise<void> {
        await this.ensureInitialized();
        const profile = readProfiles(this.context).find((item) => item.id === profileId);
        const cache = readProfileCaches(this.context)[profileId];
        const service = cache?.services.find((item) => item.id === serviceId);

        if (!profile || !service || service.type !== 'database') {
            return;
        }

        if (!isLikelyPostgresService(service.serviceKind)) {
            vscode.window.showInformationMessage(
                `${service.serviceKind || 'This database'} is not supported in the live DB viewer yet.`
            );
            return;
        }

        await setActiveProfileId(this.context, profile.id);
        await syncActiveProfileToConfig(this.context);

        const savedSecret = await this.context.secrets.get(getDatabaseSecretKey(profile.id, service.id));
        let savedConnection: DokployDatabaseConnectionHint | undefined;
        if (savedSecret) {
            try {
                savedConnection = JSON.parse(savedSecret) as DokployDatabaseConnectionHint;
            } catch {
                savedConnection = undefined;
            }
        }

        await PostgresProvider.openConnectionPanel(this.context, {
            host: savedConnection?.host || service.databaseConnection?.host,
            port: savedConnection?.port || service.databaseConnection?.port,
            database: savedConnection?.database || service.databaseConnection?.database,
            user: savedConnection?.user || service.databaseConnection?.user,
            password: savedConnection?.password,
            ssl: savedConnection?.ssl ?? service.databaseConnection?.ssl,
            label: `${profile.name} / ${service.projectName} / ${getPreferredDatabaseName(service.name, service.databaseConnection)}`,
        }, {
            onConnected: async (config) => {
                await this.context.secrets.store(
                    getDatabaseSecretKey(profile.id, service.id),
                    JSON.stringify({
                        host: config.host,
                        port: config.port,
                        database: config.database,
                        user: config.user,
                        password: config.password,
                        ssl: config.ssl,
                    } satisfies DokployDatabaseConnectionHint)
                );
                await DokployProvider.refreshAllViews();
            },
        });
    }

    private async addProfile(): Promise<void> {
        await this.ensureInitialized();
        const input = await promptForProfile();
        if (!input) {
            return;
        }

        const profiles = readProfiles(this.context);
        const profile: DokployProfile = {
            id: createProfileId(),
            name: input.name,
            url: input.url,
        };
        profiles.push(profile);
        await writeProfiles(this.context, profiles);
        await setActiveProfileId(this.context, profile.id);
        await syncActiveProfileToConfig(this.context);
        await DokployProvider.refreshAllViews();
    }

    private async activateProfile(profileId: string): Promise<void> {
        await this.ensureInitialized();
        const profiles = readProfiles(this.context);
        const profile = profiles.find((item) => item.id === profileId);
        if (!profile) {
            return;
        }

        await setActiveProfileId(this.context, profile.id);
        await syncActiveProfileToConfig(this.context);
        await DokployProvider.refreshAllViews();
    }

    private async openProfileInEditor(profileId: string): Promise<void> {
        await this.ensureInitialized();
        const profile = readProfiles(this.context).find((item) => item.id === profileId);
        if (!profile) {
            return;
        }

        await setActiveProfileId(this.context, profile.id);
        await syncActiveProfileToConfig(this.context);
        await openDokployUrlInEditor(profile.url);
        await DokployProvider.refreshAllViews();
    }

    private async openActiveProfileInEditor(): Promise<void> {
        await this.ensureInitialized();
        const { url } = await this.getState();
        if (!url) {
            await this.addProfile();
            const nextState = await this.getState();
            if (!nextState.url) {
                return;
            }
            await openDokployUrlInEditor(nextState.url);
            return;
        }

        await openDokployUrlInEditor(url);
    }

    private async openActiveProfileExternally(): Promise<void> {
        await this.ensureInitialized();
        const { url } = await this.getState();
        if (!url) {
            await this.addProfile();
            const nextState = await this.getState();
            if (!nextState.url) {
                return;
            }
            await vscode.env.openExternal(vscode.Uri.parse(nextState.url));
            return;
        }

        await vscode.env.openExternal(vscode.Uri.parse(url));
    }

    private async configureActiveProfile(): Promise<void> {
        await this.ensureInitialized();
        const profiles = readProfiles(this.context);
        const activeId = readActiveProfileId(this.context);
        const active = profiles.find((profile) => profile.id === activeId) ?? profiles[0];

        if (!active) {
            await this.addProfile();
            return;
        }

        const input = await promptForProfile(active);
        if (!input) {
            return;
        }

        const nextProfiles = profiles.map((profile) =>
            profile.id === active.id ? { ...profile, name: input.name, url: input.url } : profile
        );
        await writeProfiles(this.context, nextProfiles);
        await syncActiveProfileToConfig(this.context);
        await DokployProvider.refreshAllViews();
    }

    private async connectProfileApi(profileId: string): Promise<void> {
        await this.ensureInitialized();
        const profile = readProfiles(this.context).find((item) => item.id === profileId);
        if (!profile) {
            return;
        }

        const token = await promptForApiToken(profile);
        if (token === undefined) {
            return;
        }

        await this.context.secrets.store(getTokenSecretKey(profile.id), token.trim());
        await this.refreshProfileSnapshot(profile.id, true);
    }

    private async disconnectProfileApi(profileId: string): Promise<void> {
        await this.ensureInitialized();
        const profile = readProfiles(this.context).find((item) => item.id === profileId);
        if (!profile) {
            return;
        }

        const answer = await vscode.window.showWarningMessage(
            `Disconnect Dokploy API for "${profile.name}"?`,
            { modal: false },
            'Disconnect'
        );
        if (answer !== 'Disconnect') {
            return;
        }

        await this.context.secrets.delete(getTokenSecretKey(profile.id));
        const caches = readProfileCaches(this.context);
        delete caches[profile.id];
        await writeProfileCaches(this.context, caches);
        await DokployProvider.refreshAllViews();
    }

    private async refreshProfileSnapshot(profileId: string, revealErrors: boolean): Promise<void> {
        await this.ensureInitialized();
        const profile = readProfiles(this.context).find((item) => item.id === profileId);
        if (!profile || this.refreshingProfileIds.has(profile.id)) {
            return;
        }

        const apiToken = await this.context.secrets.get(getTokenSecretKey(profile.id));
        if (!apiToken) {
            if (revealErrors) {
                vscode.window.showWarningMessage(
                    `Add a Dokploy API key for "${profile.name}" before refreshing.`
                );
            }
            return;
        }

        this.refreshingProfileIds.add(profile.id);
        await DokployProvider.refreshAllViews();

        try {
            const [serviceSnapshot, versionPayload] = await Promise.all([
                fetchServiceCandidates(profile, apiToken),
                fetchDokployJson(profile, apiToken, 'settings.getDokployVersion').catch(() => undefined),
            ]);
            const [services, serverMetrics] = await Promise.all([
                Promise.all(
                    serviceSnapshot.candidates.map((candidate) => fetchServiceState(profile, apiToken, candidate))
                ),
                fetchProfileServerMetrics(profile, apiToken, serviceSnapshot.candidates).catch(() => []),
            ]);

            const caches = readProfileCaches(this.context);
            const versionRecord = asRecord(versionPayload);
            caches[profile.id] = {
                connected: true,
                projectCount: serviceSnapshot.projectCount,
                services,
                serverMetrics,
                version:
                    (versionRecord && pickString(versionRecord, ['version', 'dokployVersion'])) ||
                    readString(versionPayload),
                lastSyncedAt: Date.now(),
            };
            await writeProfileCaches(this.context, caches);
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            const caches = readProfileCaches(this.context);
            caches[profile.id] = {
                connected: false,
                services: [],
                lastSyncedAt: Date.now(),
                lastError: message,
            };
            await writeProfileCaches(this.context, caches);
            if (revealErrors) {
                vscode.window.showErrorMessage(`Dokploy sync failed for "${profile.name}": ${message}`);
            }
        } finally {
            this.refreshingProfileIds.delete(profile.id);
            await DokployProvider.refreshAllViews();
        }
    }

    private async deleteProfile(profileId: string): Promise<void> {
        await this.ensureInitialized();
        const profiles = readProfiles(this.context);
        const profile = profiles.find((item) => item.id === profileId);
        if (!profile) {
            return;
        }

        const answer = await vscode.window.showWarningMessage(
            `Remove Dokploy profile "${profile.name}"?`,
            { modal: false },
            'Remove'
        );
        if (answer !== 'Remove') {
            return;
        }

        const nextProfiles = profiles.filter((item) => item.id !== profileId);
        await writeProfiles(this.context, nextProfiles);
        await this.context.secrets.delete(getTokenSecretKey(profileId));

        const caches = readProfileCaches(this.context);
        delete caches[profileId];
        await writeProfileCaches(this.context, caches);

        if (readActiveProfileId(this.context) === profileId) {
            await setActiveProfileId(this.context, nextProfiles[0]?.id);
            await syncActiveProfileToConfig(this.context);
        }
        await DokployProvider.refreshAllViews();
    }
}
