import * as vscode from 'vscode';
import { buildDokployHtml } from '../dokploy/dokployUi';
import { openUrlInVsCodeBrowser } from '../utils/browser';

const DOKPLOY_CONFIG_KEY = 'dokploy.url';
const DOKPLOY_PROFILES_KEY = 'ultraview.dokploy.profiles.v1';
const DOKPLOY_ACTIVE_PROFILE_KEY = 'ultraview.dokploy.activeProfile.v1';
const DOKPLOY_PROFILE_CACHE_KEY = 'ultraview.dokploy.profileCache.v1';
const DOKPLOY_TOKEN_SECRET_PREFIX = 'ultraview.dokploy.token.';
const DOKPLOY_CACHE_STALE_MS = 2 * 60 * 1000;

interface DokployProfile {
    id: string;
    name: string;
    url: string;
}

interface DokployServiceState {
    id: string;
    name: string;
    projectName: string;
    type: 'application' | 'compose';
    domains: string[];
    status: string;
    statusTone: 'success' | 'warning' | 'danger' | 'info' | 'muted';
    updatedAt?: number;
}

interface DokployProfileCache {
    connected: boolean;
    services: DokployServiceState[];
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
    type: 'application' | 'compose';
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
    const type = record.type === 'application' || record.type === 'compose' ? record.type : undefined;
    if (!id || !name || !projectName || !type) {
        return undefined;
    }

    const rawDomains = Array.isArray(record.domains) ? record.domains : [];
    const domains = rawDomains
        .map((entry) => readString(entry))
        .filter((entry): entry is string => !!entry);

    const status = readString(record.status) || 'Unknown';
    return {
        id,
        name,
        projectName,
        type,
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

    return {
        connected: !!record.connected,
        services,
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

function extractServiceCandidates(payload: unknown): DokployServiceCandidate[] {
    const seen = new Set<string>();
    const services: DokployServiceCandidate[] = [];
    const projects = Array.isArray(payload) ? payload : [payload];

    for (const projectValue of projects) {
        const project = asRecord(projectValue);
        if (!project) {
            continue;
        }

        const projectName = pickString(project, ['name', 'projectName']) || 'Project';
        for (const value of Object.values(project)) {
            if (!Array.isArray(value)) {
                continue;
            }

            for (const itemValue of value) {
                const item = asRecord(itemValue);
                if (!item) {
                    continue;
                }

                const applicationId = readString(item.applicationId);
                if (applicationId) {
                    const uniqueId = `application:${applicationId}`;
                    if (!seen.has(uniqueId)) {
                        seen.add(uniqueId);
                        services.push({
                            id: applicationId,
                            name:
                                pickString(item, ['name', 'appName', 'slug', 'serviceName']) ||
                                applicationId,
                            projectName,
                            type: 'application',
                        });
                    }
                }

                const composeId = readString(item.composeId);
                if (composeId) {
                    const uniqueId = `compose:${composeId}`;
                    if (!seen.has(uniqueId)) {
                        seen.add(uniqueId);
                        services.push({
                            id: composeId,
                            name:
                                pickString(item, ['name', 'appName', 'slug', 'serviceName']) ||
                                composeId,
                            projectName,
                            type: 'compose',
                        });
                    }
                }
            }
        }
    }

    return services.sort((left, right) => {
        return (
            left.projectName.localeCompare(right.projectName) ||
            left.name.localeCompare(right.name) ||
            left.type.localeCompare(right.type)
        );
    });
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
            profiles.map(async (profile) => ({
                ...profile,
                hasToken: !!(await this.context.secrets.get(getTokenSecretKey(profile.id))),
                isRefreshing: this.refreshingProfileIds.has(profile.id),
                cache: caches[profile.id],
            }))
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
            const [projectsPayload, versionPayload] = await Promise.all([
                fetchDokployJson(profile, apiToken, 'project.all'),
                fetchDokployJson(profile, apiToken, 'settings.getDokployVersion').catch(() => undefined),
            ]);

            const candidates = extractServiceCandidates(projectsPayload);
            const services = await Promise.all(
                candidates.map((candidate) => fetchServiceState(profile, apiToken, candidate))
            );

            const caches = readProfileCaches(this.context);
            const versionRecord = asRecord(versionPayload);
            caches[profile.id] = {
                connected: true,
                services,
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
