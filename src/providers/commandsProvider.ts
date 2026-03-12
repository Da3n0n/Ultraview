import * as vscode from 'vscode';
import { buildCommandsHtml } from '../commands/commandsUi';
import { ProjectCommand, scanWorkspaceCommands } from '../commands/commandScanner';

export class CommandsProvider implements vscode.WebviewViewProvider {
  public static readonly viewId = 'ultraview.commands';
  private view?: vscode.WebviewView;

  constructor(private context: vscode.ExtensionContext) {
    this.registerRefreshWatchers();
  }

  static openAsPanel(ctx: vscode.ExtensionContext): void {
    const panel = vscode.window.createWebviewPanel(
      'ultraview.commandsPanel',
      'Commands',
      vscode.ViewColumn.One,
      { enableScripts: true, retainContextWhenHidden: true }
    );
    panel.webview.html = buildCommandsHtml();
    panel.webview.onDidReceiveMessage(async msg => {
      switch (msg.type) {
        case 'ready':
        case 'refresh':
          await postCommands(panel.webview);
          break;
        case 'run':
          runInTerminal(msg.command as ProjectCommand);
          break;
      }
    });
  }

  resolveWebviewView(webviewView: vscode.WebviewView): void {
    this.view = webviewView;
    webviewView.webview.options = { enableScripts: true };
    webviewView.webview.html = buildCommandsHtml();

    webviewView.webview.onDidReceiveMessage(async msg => {
      switch (msg.type) {
        case 'ready':
        case 'refresh':
          await this.postState();
          break;
        case 'run':
          runInTerminal(msg.command as ProjectCommand);
          break;
        case 'openPanel':
          vscode.commands.executeCommand('ultraview.openCommands');
          break;
      }
    });

    webviewView.onDidChangeVisibility(() => {
      if (webviewView.visible) this.postState();
    });
  }

  private async postState(): Promise<void> {
    if (!this.view) return;
    const commands = await getWorkspaceCommands();
    this.view.webview.postMessage({ type: 'state', commands });
  }

  private registerRefreshWatchers(): void {
    const patterns = [
      '**/package.json',
      '**/justfile',
      '**/Justfile',
      '**/.justfile',
      '**/Taskfile.yml',
      '**/Taskfile.yaml',
      '**/taskfile.yml',
      '**/taskfile.yaml',
      '**/Makefile',
    ];

    for (const pattern of patterns) {
      const watcher = vscode.workspace.createFileSystemWatcher(pattern);
      const refresh = () => {
        if (this.view?.visible) {
          void this.postState();
        }
      };

      watcher.onDidCreate(refresh, undefined, this.context.subscriptions);
      watcher.onDidChange(refresh, undefined, this.context.subscriptions);
      watcher.onDidDelete(refresh, undefined, this.context.subscriptions);
      this.context.subscriptions.push(watcher);
    }
  }
}

function runInTerminal(command: ProjectCommand): void {
  const terminal = vscode.window.createTerminal({
    name: `UltraView: ${command.name} (${command.folderLabel})`,
    cwd: command.cwd,
  });
  terminal.show();
  terminal.sendText(command.runCmd);
}

async function postCommands(webview: vscode.Webview): Promise<void> {
  const commands = await getWorkspaceCommands();
  webview.postMessage({ type: 'state', commands });
}

async function getWorkspaceCommands(): Promise<ProjectCommand[]> {
  const rootPaths = (vscode.workspace.workspaceFolders ?? []).map(folder => folder.uri.fsPath);
  return scanWorkspaceCommands(rootPaths);
}
