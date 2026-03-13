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
      '**/setup.py',
      '**/pyproject.toml',
      '**/requirements.txt',
      '**/Pipfile',
      '**/poetry.lock',
      '**/go.mod',
      '**/go.sum',
      '**/bun.lock',
      '**/bun.lockb',
      '**/bunfig.toml',
      '**/deno.json',
      '**/deno.jsonc',
      '**/deno.lock',
      '**/import_map.json',
      '**/pnpm-lock.yaml',
      '**/pnpm-workspace.yaml',
      '**/scripts/**/*.py',
      '**/scripts/**/*.ps1',
      '**/scripts/**/*.sh',
      '**/scripts/**/*.ts',
      '**/scripts/**/*.js',
      '**/tools/**/*.py',
      '**/tools/**/*.ps1',
      '**/tools/**/*.sh',
      '**/tools/**/*.ts',
      '**/tools/**/*.js',
      '**/bin/**/*.py',
      '**/bin/**/*.ps1',
      '**/bin/**/*.sh',
      '**/test/**/*.ts',
      '**/test/**/*.js',
      '**/tests/**/*.ts',
      '**/tests/**/*.js',
      '**/__tests__/**/*.ts',
      '**/__tests__/**/*.js',
      '**/*.py',
      '**/*.ps1',
      '**/*.sh',
      '**/*.ts',
      '**/*.js',
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
  // Track command usage
  recordCommandUsage(command);
}

async function postCommands(webview: vscode.Webview): Promise<void> {
  const commands = await getWorkspaceCommands();
  webview.postMessage({ type: 'state', commands });
}

async function getWorkspaceCommands(): Promise<ProjectCommand[]> {
  const rootPaths = (vscode.workspace.workspaceFolders ?? []).map(folder => folder.uri.fsPath);
  const commands = await scanWorkspaceCommands(rootPaths);
  // Sort by most recently used
  return sortCommandsByUsage(commands);
}

// Command usage tracking
interface CommandUsage {
  commandId: string;
  lastRun: number;
  runCount: number;
}

function recordCommandUsage(command: ProjectCommand): void {
  const config = vscode.workspace.getConfiguration('ultraview');
  const usageData = config.get<Record<string, CommandUsage>>('commands.usage') || {};

  const commandId = `${command.type}:${command.name}:${command.cwd}`;
  const now = Date.now();

  if (usageData[commandId]) {
    usageData[commandId].lastRun = now;
    usageData[commandId].runCount++;
  } else {
    usageData[commandId] = {
      commandId,
      lastRun: now,
      runCount: 1
    };
  }

  config.update('commands.usage', usageData, vscode.ConfigurationTarget.Global);
}

function sortCommandsByUsage(commands: ProjectCommand[]): ProjectCommand[] {
  const config = vscode.workspace.getConfiguration('ultraview');
  const usageData = config.get<Record<string, CommandUsage>>('commands.usage') || {};

  return commands.sort((a, b) => {
    const aId = `${a.type}:${a.name}:${a.cwd}`;
    const bId = `${b.type}:${b.name}:${b.cwd}`;

    const aUsage = usageData[aId];
    const bUsage = usageData[bId];

    const aLastRun = aUsage?.lastRun || 0;
    const bLastRun = bUsage?.lastRun || 0;

    // Sort by last run time (most recent first)
    if (aLastRun !== bLastRun) {
      return bLastRun - aLastRun;
    }

    // If same last run time, sort by run count
    const aRunCount = aUsage?.runCount || 0;
    const bRunCount = bUsage?.runCount || 0;
    if (aRunCount !== bRunCount) {
      return bRunCount - aRunCount;
    }

    // If same usage, sort alphabetically by name
    return a.name.localeCompare(b.name);
  });
}
