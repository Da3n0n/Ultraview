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

}

export function deactivate() { }
