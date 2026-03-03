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
import { CustomComments } from './customComments/index';
import { SharedStore } from './sync/sharedStore';
import { Model3dProvider } from './model3dViewer';
import { forceDelete } from './utils/forceDelete';


let customComments: CustomComments;
let sharedStore: SharedStore;

export async function activate(context: vscode.ExtensionContext) {
  customComments = new CustomComments(context);

  // ── Shared cross-IDE store ─────────────────────────────────────────────
  sharedStore = new SharedStore(context);
  await sharedStore.initialize();
  context.subscriptions.push({ dispose: () => sharedStore.dispose() });

  const gitProvider = new GitProvider(context, sharedStore);

  context.subscriptions.push(
    vscode.window.registerCustomEditorProvider(
      'ultraview.sqlite',
      new SqliteProvider(context),
      { supportsMultipleEditorsPerDocument: false, webviewOptions: { retainContextWhenHidden: true } }
    ),
    vscode.window.registerCustomEditorProvider(
      'ultraview.duckdb',
      new DuckDbProvider(context),
      { supportsMultipleEditorsPerDocument: false, webviewOptions: { retainContextWhenHidden: true } }
    ),
    vscode.window.registerCustomEditorProvider(
      'ultraview.access',
      new AccessProvider(context),
      { supportsMultipleEditorsPerDocument: false, webviewOptions: { retainContextWhenHidden: true } }
    ),
    vscode.window.registerCustomEditorProvider(
      'ultraview.sqldump',
      new SqlDumpProvider(context),
      { supportsMultipleEditorsPerDocument: false, webviewOptions: { retainContextWhenHidden: true } }
    ),
    vscode.window.registerCustomEditorProvider(
      'ultraview.markdown',
      new MarkdownProvider(context),
      { supportsMultipleEditorsPerDocument: false, webviewOptions: { retainContextWhenHidden: true } }
    ),
    vscode.window.registerCustomEditorProvider(
      'ultraview.svg',
      new SvgProvider(context),
      { supportsMultipleEditorsPerDocument: false, webviewOptions: { retainContextWhenHidden: true } }
    ),
    vscode.window.registerCustomEditorProvider(
      'ultraview.index',
      new IndexProvider(context),
      { supportsMultipleEditorsPerDocument: false, webviewOptions: { retainContextWhenHidden: true } }
    ),
    vscode.window.registerCustomEditorProvider(
      'ultraview.model3d',
      new Model3dProvider(context),
      { supportsMultipleEditorsPerDocument: false, webviewOptions: { retainContextWhenHidden: true } }
    ),
    vscode.window.registerWebviewViewProvider(
      CodeGraphProvider.viewId,
      new CodeGraphProvider(context),
      { webviewOptions: { retainContextWhenHidden: true } }
    ),
    vscode.window.registerWebviewViewProvider(
      GitProvider.viewId,
      gitProvider,
      { webviewOptions: { retainContextWhenHidden: true } }
    ),
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
    vscode.commands.registerCommand('ultraview.openPorts', () => {
      PortsProvider.openAsPanel(context);
    }),
    vscode.window.registerWebviewViewProvider(
      CommandsProvider.viewId,
      new CommandsProvider(context),
      { webviewOptions: { retainContextWhenHidden: true } }
    ),
    vscode.commands.registerCommand('ultraview.openCommands', () => {
      CommandsProvider.openAsPanel(context);
    }),
    vscode.commands.registerCommand('ultraview.openUrl', async (url?: string) => {
      if (url && typeof url === 'string') {
        if (!/^https?:\/\//.test(url)) {
          url = 'https://' + url;
        }
        vscode.commands.executeCommand('simpleBrowser.show', url);
      } else {
        const input = await vscode.window.showInputBox({
          prompt: 'Enter URL to open',
          placeHolder: 'https://example.com',
          value: 'https://'
        });
        if (input) {
          let finalUrl = input;
          if (!/^https?:\/\//.test(finalUrl)) {
            finalUrl = 'https://' + finalUrl;
          }
          vscode.commands.executeCommand('simpleBrowser.show', finalUrl);
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
    }),
  );

  // ── Force Git panel as default sidebar on every VS Code launch ──────────
  // Try a few times to catch the moment the sidebar is ready, but stop
  // immediately if the user manually switches to a different panel.
  let focusCount = 0;
  let userOverrode = false;

  // Listen for any sidebar view-change the user triggers; if they click
  // away from the git panel we must stop fighting them.
  const viewChangeSub = vscode.window.tabGroups.onDidChangeTabGroups(() => {
    // Any tab-group change while we are still retrying means the user is
    // actively interacting – bail out.
    userOverrode = true;
  });

  const focusTimer = setInterval(() => {
    if (userOverrode || ++focusCount >= 6) {
      clearInterval(focusTimer);
      viewChangeSub.dispose();
      return;
    }
    vscode.commands.executeCommand('ultraview.git.focus');
  }, 150);

  // Also cancel if the user explicitly focuses any other sidebar view
  // within the first second by watching visibility of the git webview.
  // The gitProvider will call back when its view becomes hidden.
  gitProvider.onUserOverride(() => {
    userOverrode = true;
    clearInterval(focusTimer);
    viewChangeSub.dispose();
  });
}

export function deactivate() { }
