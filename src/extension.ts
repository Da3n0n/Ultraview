import * as vscode from 'vscode';
import { SqliteProvider } from './providers/sqliteProvider';
import { DuckDbProvider } from './providers/duckdbProvider';
import { AccessProvider } from './providers/accessProvider';
import { SqlDumpProvider } from './providers/sqlDumpProvider';
import { MarkdownProvider } from './providers/markdownProvider';
import { SvgProvider } from './providers/svgProvider';
import { IndexProvider } from './providers/indexProvider';
import { CodeGraphProvider } from './providers/codeGraphProvider';
import { GitProvider } from './providers/gitProvider';
import { PortsProvider } from './providers/portsProvider';
import { CommandsProvider } from './providers/commandsProvider';
import {
    DokployProvider,
    configureDokployUrl,
    openDokployInEditor,
} from './providers/dokployProvider';
import { CustomComments } from './customComments/index';
import { SharedStore } from './sync/sharedStore';
import { GitProjects } from './git/gitProjects';
import { GitAccounts } from './git/gitAccounts';
import { Model3dProvider } from './model3dViewer';
import { registerThemeCommands } from './theme';
import { forceDelete } from './utils/forceDelete';
import { openUrlInVsCodeBrowser } from './utils/browser';
import { applyLocalAccount, migratePlaintextRemote } from './git/gitCredentials';
import { DrawingProvider } from './drawings/drawingProvider';
import { DrawingManager } from './drawings/drawingManager';
import { GitNexusProvider } from './providers/gitNexusProvider';
import { GitNexusRuntime } from './gitNexus/runtime';

let customComments: CustomComments | undefined;
let sharedStore: SharedStore;
let storeReady: Promise<void> | undefined;

export async function activate(context: vscode.ExtensionContext) {
    const getCustomComments = () => customComments ??= new CustomComments(context);
    let bucketProvider: Promise<import('./providers/bucketManagerProvider').BucketManagerProvider> | undefined;
    const getBucketProvider = () => bucketProvider ??= import('./providers/bucketManagerProvider')
        .then(({ BucketManagerProvider }) => new BucketManagerProvider(context));
    registerThemeCommands(context);

    // ── Shared cross-IDE store ─────────────────────────────────────────────
    sharedStore = new SharedStore(context);
    storeReady = sharedStore.initialize();
    void storeReady.catch(error => console.error('[Ultraview] Shared store initialization failed:', error));
    context.subscriptions.push({ dispose: async () => {
        await storeReady?.catch(() => {});
        await sharedStore.dispose();
    } });

    const gitProvider = new GitProvider(context, sharedStore);
    // Older versions wrote git tokens into remote URLs (.git/config). Move any that remain into
    // the OS credential store, for every known project and open folder (runs once per start).
    void storeReady
        .then(async () => {
            const nodeFs = require('fs') as typeof import('fs');
            const nodePath = require('path') as typeof import('path');
            const paths = new Set<string>([
                ...new GitProjects(context, sharedStore).listProjects().map((p) => p.path),
                ...(vscode.workspace.workspaceFolders ?? []).map((f) => f.uri.fsPath),
            ]);
            for (const repo of paths) {
                if (repo && nodeFs.existsSync(nodePath.join(repo, '.git'))) await migratePlaintextRemote(repo);
            }
        })
        .catch((error) => console.warn('[Ultraview] Credential migration skipped:', error));
    const drawingManager = new DrawingManager(context, sharedStore);
    const drawingProvider = new DrawingProvider(context, drawingManager);
    const gitNexusRuntime = new GitNexusRuntime(context);
    const gitNexusProvider = new GitNexusProvider(context, gitNexusRuntime);
    context.subscriptions.push(gitNexusRuntime, gitNexusProvider);

    context.subscriptions.push(
        vscode.window.registerCustomEditorProvider(
            'ultraview.sqlite',
            new SqliteProvider(context),
            {
                supportsMultipleEditorsPerDocument: false,
                // SQLite viewer loads data on-demand; no need to retain DOM when hidden
                webviewOptions: { retainContextWhenHidden: false },
            }
        ),
        vscode.window.registerCustomEditorProvider(
            'ultraview.duckdb',
            new DuckDbProvider(context),
            {
                supportsMultipleEditorsPerDocument: false,
                webviewOptions: { retainContextWhenHidden: false },
            }
        ),
        vscode.window.registerCustomEditorProvider(
            'ultraview.access',
            new AccessProvider(context),
            {
                supportsMultipleEditorsPerDocument: false,
                webviewOptions: { retainContextWhenHidden: false },
            }
        ),
        vscode.window.registerCustomEditorProvider(
            'ultraview.sqldump',
            new SqlDumpProvider(context),
            {
                supportsMultipleEditorsPerDocument: false,
                webviewOptions: { retainContextWhenHidden: false },
            }
        ),
        vscode.window.registerCustomEditorProvider(
            'ultraview.markdown',
            new MarkdownProvider(context),
            {
                supportsMultipleEditorsPerDocument: false,
                webviewOptions: { retainContextWhenHidden: true },
            }
        ),
        vscode.window.registerCustomEditorProvider('ultraview.svg', new SvgProvider(context), {
            supportsMultipleEditorsPerDocument: false,
            webviewOptions: { retainContextWhenHidden: false },
        }),
        vscode.window.registerCustomEditorProvider('ultraview.index', new IndexProvider(context), {
            supportsMultipleEditorsPerDocument: false,
            webviewOptions: { retainContextWhenHidden: false },
        }),
        vscode.window.registerCustomEditorProvider(
            'ultraview.model3d',
            new Model3dProvider(context),
            {
                supportsMultipleEditorsPerDocument: false,
                webviewOptions: { retainContextWhenHidden: false },
            }
        ),
        vscode.window.registerWebviewViewProvider(
            CodeGraphProvider.viewId,
            new CodeGraphProvider(context),
            { webviewOptions: { retainContextWhenHidden: true } }
        ),
        vscode.window.registerWebviewViewProvider(
            GitNexusProvider.viewId,
            gitNexusProvider,
            { webviewOptions: { retainContextWhenHidden: false } }
        ),
        vscode.window.registerWebviewViewProvider(GitProvider.viewId, {
            resolveWebviewView: async (view, _resolveContext, token) => {
                await storeReady;
                if (!token.isCancellationRequested) gitProvider.resolveWebviewView(view);
            },
        }, {
            webviewOptions: { retainContextWhenHidden: true },
        }),
        vscode.window.registerWebviewViewProvider(
            PortsProvider.viewId,
            new PortsProvider(context),
            { webviewOptions: { retainContextWhenHidden: false } }
        ),
        vscode.window.registerWebviewViewProvider(
            DrawingProvider.viewId,
            { resolveWebviewView: async (view, resolveContext, token) => {
                await storeReady;
                if (!token.isCancellationRequested) drawingProvider.resolveWebviewView(view, resolveContext, token);
            } },
            { webviewOptions: { retainContextWhenHidden: true } }
        ),
        vscode.window.registerWebviewViewProvider(
            'ultraview.bucketManager',
            { resolveWebviewView: async (view) => (await getBucketProvider()).resolveWebviewView(view) },
            { webviewOptions: { retainContextWhenHidden: false } }
        ),
        vscode.commands.registerCommand('ultraview.openCodeGraph', () => {
            CodeGraphProvider.openAsPanel(context);
        }),
        vscode.commands.registerCommand('ultraview.openGitNexus', () => {
            gitNexusProvider.openAsPanel();
        }),
        vscode.commands.registerCommand('ultraview.gitNexus.startServer', async () => {
            await vscode.window.withProgress(
                { location: vscode.ProgressLocation.Notification, title: 'Starting local GitNexus…' },
                () => gitNexusRuntime.start()
            );
            vscode.window.showInformationMessage(`GitNexus is ready on localhost:${gitNexusRuntime.port}.`);
        }),
        vscode.commands.registerCommand('ultraview.gitNexus.stopServer', () => gitNexusRuntime.stop()),
        vscode.commands.registerCommand('ultraview.gitNexus.openCli', () => gitNexusRuntime.openCli()),
        vscode.commands.registerCommand('ultraview.gitNexus.startMcp', () => gitNexusRuntime.startMcp()),
        vscode.commands.registerCommand('ultraview.gitNexus.analyzeWorkspace', async () => {
            await vscode.window.withProgress(
                { location: vscode.ProgressLocation.Notification, title: 'Analyzing workspace with GitNexus…' },
                () => gitNexusProvider.analyzeWorkspace()
            );
        }),
        vscode.commands.registerCommand('ultraview.openGitProjects', async () => {
            await storeReady;
            GitProvider.openAsPanel(context, sharedStore);
        }),
        vscode.commands.registerCommand('ultraview.quickOpenProject', async () => {
            await storeReady;
            const manager = new GitProjects(context, sharedStore);
            const accounts = new GitAccounts(context, sharedStore);
            const projects = manager
                .listProjects()
                .sort((a, b) => (b.lastOpened ?? 0) - (a.lastOpened ?? 0));
            const activeRepo = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? '';

            interface ProjectPickItem extends vscode.QuickPickItem {
                projectPath?: string;
                action?: 'addLocal' | 'addRepo';
            }

            const projectItems: ProjectPickItem[] = projects.map((p) => ({
                label:
                    p.path === activeRepo
                        ? `$(git-branch) ${p.name} (active)`
                        : `$(git-branch) ${p.name}`,
                description: p.path,
                alwaysShow: p.path === activeRepo,
                projectPath: p.path,
            }));

            const separator: ProjectPickItem = {
                label: '',
                kind: vscode.QuickPickItemKind.Separator,
                alwaysShow: true,
            };

            const addLocalItem: ProjectPickItem = {
                label: '$(add) Add Local...',
                description: 'Add a local folder as a project',
                alwaysShow: true,
                action: 'addLocal',
            };

            const addRepoItem: ProjectPickItem = {
                label: '$(repo) Add Repository...',
                description: 'Clone or add a git repository',
                alwaysShow: true,
                action: 'addRepo',
            };

            const items: ProjectPickItem[] = [
                ...projectItems,
                ...(projects.length > 0
                    ? [separator, addLocalItem, addRepoItem]
                    : [addLocalItem, addRepoItem]),
            ];

            const selected = await vscode.window.showQuickPick(items, {
                placeHolder:
                    projects.length > 0
                        ? 'Select a project to open, or add a new one'
                        : 'Add a project to get started',
                matchOnDescription: true,
            });

            if (!selected) return;

            if (selected.action === 'addLocal') {
                await gitProvider.addLocalProject();
                return;
            }

            if (selected.action === 'addRepo') {
                await gitProvider.addRepo();
                return;
            }

            if (!selected.projectPath) return;
            const project = projects.find((p) => p.path === selected.projectPath);
            if (!project) return;

            if (project.accountId) {
                const acc = await accounts.getAccountWithToken(project.accountId);
                if (acc) {
                    await applyLocalAccount(project.path, acc, acc.token);
                }
            }
            manager.updateProject(project.id, { lastOpened: Date.now() });
            vscode.commands.executeCommand(
                'vscode.openFolder',
                vscode.Uri.file(project.path),
                false
            );
        }),
        vscode.commands.registerCommand('ultraview.quickSwitchGitAccount', async () => {
            await storeReady;
            const manager = new GitProjects(context, sharedStore);
            const accounts = new GitAccounts(context, sharedStore);
            const accountList = accounts.listAccounts();
            const activeRepo = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? '';

            const activeProject = activeRepo ? manager.getProjectByPath(activeRepo) : undefined;
            const activeAccountId =
                activeProject?.accountId ||
                (activeRepo ? accounts.getLocalAccount(activeRepo)?.id : undefined);

            interface AccountPickItem extends vscode.QuickPickItem {
                accountId?: string;
                action?: 'add' | 'manage';
            }

            const accountItems: AccountPickItem[] = accountList.map((acc) => ({
                label:
                    acc.id === activeAccountId
                        ? `$(account) ${acc.username} (active)`
                        : `$(account) ${acc.username}`,
                description: `${acc.provider}`,
                alwaysShow: acc.id === activeAccountId,
                detail: acc.email ?? undefined,
                accountId: acc.id,
            }));

            const separator: AccountPickItem = {
                label: '',
                kind: vscode.QuickPickItemKind.Separator,
                alwaysShow: true,
            };

            const addNewItem: AccountPickItem = {
                label: '$(add) Add new account...',
                description: 'Add a new git account',
                alwaysShow: true,
                action: 'add',
            };

            const manageItem: AccountPickItem = {
                label: '$(settings-gear) Manage Accounts',
                description: 'Open Project Manager to manage accounts',
                alwaysShow: true,
                action: 'manage',
            };

            const items: AccountPickItem[] = [
                ...accountItems,
                ...(accountList.length > 0 ? [separator, addNewItem, manageItem] : [addNewItem]),
            ];

            const selected = await vscode.window.showQuickPick(items, {
                placeHolder:
                    accountList.length > 0
                        ? 'Select a git account, or add a new one'
                        : 'Add a git account to get started',
                matchOnDescription: true,
            });

            if (!selected) return;

            if (selected.action === 'add' || selected.action === 'manage') {
                vscode.commands.executeCommand('workbench.view.extension.ultraview-git');
                return;
            }

            if (!selected.accountId) return;
            const account = accountList.find((a) => a.id === selected.accountId);
            if (!account) return;

            if (!activeRepo) {
                vscode.window.showWarningMessage('No workspace open. Open a project first.');
                return;
            }

            let project = manager.getProjectByPath(activeRepo);
            if (!project) {
                const path = require('path') as typeof import('path');
                const name = path.basename(activeRepo);
                project = manager.addProject({ name, path: activeRepo });
            }

            manager.setProjectAccount(project.id, account.id);
            accounts.setLocalAccount(activeRepo, account.id);

            const accWithToken = await accounts.getAccountWithToken(account.id);
            if (accWithToken) {
                await applyLocalAccount(activeRepo, accWithToken, accWithToken.token);
                vscode.window.showInformationMessage(
                    `Switched to ${accWithToken.username} for this project.`
                );
            }
        }),
        vscode.commands.registerCommand('ultraview.openPorts', () => {
            PortsProvider.openAsPanel(context);
        }),
        vscode.window.registerWebviewViewProvider(
            CommandsProvider.viewId,
            new CommandsProvider(context),
            { webviewOptions: { retainContextWhenHidden: false } }
        ),
        vscode.window.registerWebviewViewProvider(
            DokployProvider.viewId,
            new DokployProvider(context),
            { webviewOptions: { retainContextWhenHidden: false } }
        ),
        vscode.commands.registerCommand('ultraview.openCommands', () => {
            CommandsProvider.openAsPanel(context);
        }),
        vscode.commands.registerCommand('ultraview.openDrawings', async () => {
            await storeReady;
            DrawingProvider.openDrawingPanel(context, drawingManager);
        }),
        vscode.commands.registerCommand('ultraview.openDokployPanel', () => {
            DokployProvider.openAsPanel(context);
        }),
        vscode.commands.registerCommand('ultraview.openBucketManager', async () => {
            (await import('./providers/bucketManagerProvider')).BucketManagerProvider.openAsPanel(context);
        }),
        vscode.commands.registerCommand('ultraview.openDokploy', async () => {
            await openDokployInEditor();
        }),
        vscode.commands.registerCommand('ultraview.configureDokployUrl', async () => {
            await configureDokployUrl(context);
            await DokployProvider.refreshAllViews();
        }),
        vscode.commands.registerCommand('ultraview.openUrl', async (url?: string) => {
            if (url && typeof url === 'string') {
                if (!/^https?:\/\//.test(url)) {
                    url = 'https://' + url;
                }
                await openUrlInVsCodeBrowser(url, {
                    promptExternalOnFailure: true,
                    failureContext: 'Ultraview URL opening',
                });
            } else {
                const input = await vscode.window.showInputBox({
                    prompt: 'Enter URL to open',
                    placeHolder: 'https://example.com',
                    value: 'https://',
                });
                if (input) {
                    let finalUrl = input;
                    if (!/^https?:\/\//.test(finalUrl)) {
                        finalUrl = 'https://' + finalUrl;
                    }
                    await openUrlInVsCodeBrowser(finalUrl, {
                        promptExternalOnFailure: true,
                        failureContext: 'Ultraview URL opening',
                    });
                }
            }
        }),
        vscode.commands.registerCommand('ultraview.enableCustomComments', async () => {
            const result = await getCustomComments().enable();
            if (result.success) {
                vscode.window.showInformationMessage(result.message);
            } else {
                vscode.window.showErrorMessage(result.message);
            }
        }),
        vscode.commands.registerCommand('ultraview.disableCustomComments', async () => {
            const result = await getCustomComments().disable();
            if (result.success) {
                vscode.window.showInformationMessage(result.message);
            } else {
                vscode.window.showErrorMessage(result.message);
            }
        }),
        vscode.commands.registerCommand('ultraview.toggleCustomComments', () => {
            void getCustomComments().toggle();
        }),
        vscode.commands.registerCommand('ultraview.refreshCustomComments', () => {
            getCustomComments().updateCss();
        }),

        // ── Sync folder management ──────────────────────────────────────────
        vscode.commands.registerCommand('ultraview.setSyncFolder', async () => {
            await storeReady;
            await sharedStore.changeSyncDirectory();
        }),
        vscode.commands.registerCommand('ultraview.showSyncFolder', () => {
            vscode.env.openExternal(vscode.Uri.file(sharedStore.syncDirPath));
            vscode.window.showInformationMessage(
                `Ultraview sync file: ${sharedStore.syncFilePath}`
            );
        }),

        vscode.commands.registerCommand('ultraview.forceDelete', async (uri: vscode.Uri) => {
            await forceDelete(uri);
        })
    );
}

export async function deactivate() {
    await storeReady?.catch(() => {});
    await sharedStore?.dispose();
}
