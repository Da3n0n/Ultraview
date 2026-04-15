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
import { applyLocalAccount } from './git/gitCredentials';

let customComments: CustomComments;
let sharedStore: SharedStore;

export async function activate(context: vscode.ExtensionContext) {
    customComments = new CustomComments(context);
    registerThemeCommands(context);

    // ── Shared cross-IDE store ─────────────────────────────────────────────
    sharedStore = new SharedStore(context);
    await sharedStore.initialize();
    context.subscriptions.push({ dispose: () => sharedStore.dispose() });

    const gitProvider = new GitProvider(context, sharedStore);

    context.subscriptions.push(
        vscode.window.registerCustomEditorProvider(
            'ultraview.sqlite',
            new SqliteProvider(context),
            {
                supportsMultipleEditorsPerDocument: false,
                webviewOptions: { retainContextWhenHidden: true },
            }
        ),
        vscode.window.registerCustomEditorProvider(
            'ultraview.duckdb',
            new DuckDbProvider(context),
            {
                supportsMultipleEditorsPerDocument: false,
                webviewOptions: { retainContextWhenHidden: true },
            }
        ),
        vscode.window.registerCustomEditorProvider(
            'ultraview.access',
            new AccessProvider(context),
            {
                supportsMultipleEditorsPerDocument: false,
                webviewOptions: { retainContextWhenHidden: true },
            }
        ),
        vscode.window.registerCustomEditorProvider(
            'ultraview.sqldump',
            new SqlDumpProvider(context),
            {
                supportsMultipleEditorsPerDocument: false,
                webviewOptions: { retainContextWhenHidden: true },
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
            webviewOptions: { retainContextWhenHidden: true },
        }),
        vscode.window.registerCustomEditorProvider('ultraview.index', new IndexProvider(context), {
            supportsMultipleEditorsPerDocument: false,
            webviewOptions: { retainContextWhenHidden: true },
        }),
        vscode.window.registerCustomEditorProvider(
            'ultraview.model3d',
            new Model3dProvider(context),
            {
                supportsMultipleEditorsPerDocument: false,
                webviewOptions: { retainContextWhenHidden: true },
            }
        ),
        vscode.window.registerWebviewViewProvider(
            CodeGraphProvider.viewId,
            new CodeGraphProvider(context),
            { webviewOptions: { retainContextWhenHidden: true } }
        ),
        vscode.window.registerWebviewViewProvider(GitProvider.viewId, gitProvider, {
            webviewOptions: { retainContextWhenHidden: true },
        }),
        vscode.window.registerWebviewViewProvider(
            PortsProvider.viewId,
            new PortsProvider(context),
            { webviewOptions: { retainContextWhenHidden: true } }
        ),
        vscode.commands.registerCommand('ultraview.openCodeGraph', () => {
            CodeGraphProvider.openAsPanel(context);
        }),
        vscode.commands.registerCommand('ultraview.openGitProjects', () => {
            GitProvider.openAsPanel(context, sharedStore);
        }),
        vscode.commands.registerCommand('ultraview.quickOpenProject', async () => {
            const manager = new GitProjects(context, sharedStore);
            const accounts = new GitAccounts(context, sharedStore);
            const projects = manager
                .listProjects()
                .sort((a, b) => (b.lastOpened ?? 0) - (a.lastOpened ?? 0));
            const activeRepo = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? '';

            if (projects.length === 0) {
                vscode.window.showInformationMessage(
                    'No projects in Project Manager. Add one first.'
                );
                return;
            }

            const items: vscode.QuickPickItem[] = projects.map((p) => ({
                label:
                    p.path === activeRepo
                        ? `$(git-branch) ${p.name} (active)`
                        : `$(git-branch) ${p.name}`,
                description: p.path,
                alwaysShow: p.path === activeRepo,
            }));

            const selected = await vscode.window.showQuickPick(items, {
                placeHolder: 'Select a project to open',
                matchOnDescription: true,
            });

            if (!selected?.description) return;
            const project = projects.find((p) => p.path === selected.description);
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
                        ? 'Select a git account to switch to, or add a new one'
                        : 'Add a git account to get started',
                matchOnDescription: true,
            });

            if (!selected) return;

            if (selected.action === 'add') {
                GitProvider.openAsPanel(context, sharedStore);
                return;
            }

            if (selected.action === 'manage') {
                GitProvider.openAsPanel(context, sharedStore);
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
            { webviewOptions: { retainContextWhenHidden: true } }
        ),
        vscode.window.registerWebviewViewProvider(
            DokployProvider.viewId,
            new DokployProvider(context),
            { webviewOptions: { retainContextWhenHidden: true } }
        ),
        vscode.commands.registerCommand('ultraview.openCommands', () => {
            CommandsProvider.openAsPanel(context);
        }),
        vscode.commands.registerCommand('ultraview.openDokployPanel', () => {
            DokployProvider.openAsPanel(context);
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
            const result = await customComments.enable();
            if (result.success) {
                vscode.window.showInformationMessage(result.message);
            } else {
                vscode.window.showErrorMessage(result.message);
            }
        }),
        vscode.commands.registerCommand('ultraview.disableCustomComments', async () => {
            const result = await customComments.disable();
            if (result.success) {
                vscode.window.showInformationMessage(result.message);
            } else {
                vscode.window.showErrorMessage(result.message);
            }
        }),
        vscode.commands.registerCommand('ultraview.toggleCustomComments', () => {
            customComments.toggle();
        }),
        vscode.commands.registerCommand('ultraview.refreshCustomComments', () => {
            customComments.updateCss();
        }),

        // ── Sync folder management ──────────────────────────────────────────
        vscode.commands.registerCommand('ultraview.setSyncFolder', async () => {
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

export function deactivate() {}
