import * as vscode from 'vscode';
import { buildDokployHtml } from '../dokploy/dokployUi';
import { openUrlInVsCodeBrowser } from '../utils/browser';

const DOKPLOY_CONFIG_KEY = 'dokploy.url';
const DOKPLOY_PROFILES_KEY = 'ultraview.dokploy.profiles.v1';
const DOKPLOY_ACTIVE_PROFILE_KEY = 'ultraview.dokploy.activeProfile.v1';

interface DokployProfile {
    id: string;
    name: string;
    url: string;
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

export function getDokployUrl(): string {
    return normalizeDokployUrl(getDokployConfiguration().get<string>(DOKPLOY_CONFIG_KEY, ''));
}

async function setDokployUrl(url: string): Promise<void> {
    const target = vscode.workspace.workspaceFolders?.length
        ? vscode.ConfigurationTarget.Workspace
        : vscode.ConfigurationTarget.Global;

    await getDokployConfiguration().update(DOKPLOY_CONFIG_KEY, url, target);
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
    private view?: vscode.WebviewView;

    constructor(private readonly context: vscode.ExtensionContext) {
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

    private static instance?: DokployProvider;
    private initializePromise?: Promise<void>;

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
                    case 'openProfileExt':
                        if (typeof msg.profileId === 'string') {
                            await this.openProfileExternally(msg.profileId);
                        }
                        break;
                    case 'editProfile':
                        if (typeof msg.profileId === 'string') {
                            await this.editProfile(msg.profileId);
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
        profiles: DokployProfile[];
        activeProfileId?: string;
    }> {
        await syncActiveProfileToConfig(this.context);
        const profiles = readProfiles(this.context);
        const activeProfileId = readActiveProfileId(this.context);
        const activeProfile =
            profiles.find((profile) => profile.id === activeProfileId) ?? profiles[0];
        return {
            url: activeProfile?.url ?? '',
            profiles,
            activeProfileId: activeProfile?.id,
        };
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

    private async openProfileExternally(profileId: string): Promise<void> {
        await this.ensureInitialized();
        const profile = readProfiles(this.context).find((item) => item.id === profileId);
        if (!profile) {
            return;
        }

        await setActiveProfileId(this.context, profile.id);
        await syncActiveProfileToConfig(this.context);
        await vscode.env.openExternal(vscode.Uri.parse(profile.url));
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

    private async editProfile(profileId: string): Promise<void> {
        await this.ensureInitialized();
        const profiles = readProfiles(this.context);
        const profile = profiles.find((item) => item.id === profileId);
        if (!profile) {
            return;
        }

        const input = await promptForProfile(profile);
        if (!input) {
            return;
        }

        const nextProfiles = profiles.map((item) =>
            item.id === profileId ? { ...item, name: input.name, url: input.url } : item
        );
        await writeProfiles(this.context, nextProfiles);
        if (readActiveProfileId(this.context) === profileId) {
            await syncActiveProfileToConfig(this.context);
        }
        await DokployProvider.refreshAllViews();
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
        if (readActiveProfileId(this.context) === profileId) {
            await setActiveProfileId(this.context, nextProfiles[0]?.id);
            await syncActiveProfileToConfig(this.context);
        }
        await DokployProvider.refreshAllViews();
    }
}
