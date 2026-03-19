import * as vscode from 'vscode';
import { buildCommandsHtml } from '../commands/commandsUi';
import { ProjectCommand, scanWorkspaceCommands } from '../commands/commandScanner';

export class CommandsProvider implements vscode.WebviewViewProvider {
  public static readonly viewId = 'ultraview.commands';
  private static readonly activeWebviews = new Set<vscode.Webview>();
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
    CommandsProvider.trackWebview(panel.webview, panel.onDidDispose);
    panel.webview.html = buildCommandsHtml();
    panel.webview.onDidReceiveMessage(async msg => {
      switch (msg.type) {
        case 'ready':
        case 'refresh':
          await postCommands(panel.webview);
          break;
        case 'run':
          await runInTerminal(msg.command as ProjectCommand);
          break;
      }
    });
  }

  resolveWebviewView(webviewView: vscode.WebviewView): void {
    this.view = webviewView;
    CommandsProvider.trackWebview(webviewView.webview, webviewView.onDidDispose);
    webviewView.webview.options = { enableScripts: true };
    webviewView.webview.html = buildCommandsHtml();

    webviewView.webview.onDidReceiveMessage(async msg => {
      switch (msg.type) {
        case 'ready':
        case 'refresh':
          await this.postState();
          break;
        case 'run':
          await runInTerminal(msg.command as ProjectCommand);
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

  private static trackWebview(
    webview: vscode.Webview,
    registerDispose: (listener: () => any) => vscode.Disposable,
  ): void {
    CommandsProvider.activeWebviews.add(webview);
    registerDispose(() => {
      CommandsProvider.activeWebviews.delete(webview);
    });
  }

  static async refreshAllViews(): Promise<void> {
    const commands = await getWorkspaceCommands();
    for (const webview of CommandsProvider.activeWebviews) {
      webview.postMessage({ type: 'state', commands });
    }
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

async function runInTerminal(command: ProjectCommand): Promise<void> {
  const termName = 'UltraView';
  let terminal = vscode.window.terminals.find(
    t => t.name === termName && t.exitStatus === undefined
  );
  if (!terminal) {
    terminal = vscode.window.createTerminal({ name: termName });
  }
  terminal.show();
  terminal.sendText(`cd "${command.cwd}"`);
  terminal.sendText(command.runCmd);
  recordCommandUsage(command);
  await CommandsProvider.refreshAllViews();
  void vscode.commands.executeCommand('ultraview.commands.focus');
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

// In-memory map so sorts are always instant — config is only used for persistence across sessions.
let usageCache: Record<string, CommandUsage> | null = null;

function getUsageCache(): Record<string, CommandUsage> {
  if (usageCache === null) {
    const config = vscode.workspace.getConfiguration('ultraview');
    usageCache = config.get<Record<string, CommandUsage>>('commands.usage') || {};
  }
  return usageCache;
}

function recordCommandUsage(command: ProjectCommand): void {
  const cache = getUsageCache();
  const commandId = `${command.workspaceLabel}:${command.type}:${command.name}:${command.cwd}`;
  const now = Date.now();

  if (cache[commandId]) {
    cache[commandId].lastRun = now;
    cache[commandId].runCount++;
  } else {
    cache[commandId] = { commandId, lastRun: now, runCount: 1 };
  }

  // Persist in background — don't await so the sort sees the update immediately
  const config = vscode.workspace.getConfiguration('ultraview');
  void config.update('commands.usage', cache, vscode.ConfigurationTarget.Global);
}

function sortCommandsByUsage(commands: ProjectCommand[]): ProjectCommand[] {
  const usageData = getUsageCache();

  return commands
    .map(command => {
      const commandId = `${command.workspaceLabel}:${command.type}:${command.name}:${command.cwd}`;
      const usage = usageData[commandId];
      return { ...command, lastRun: usage?.lastRun || 0, runCount: usage?.runCount || 0 };
    })
    .sort((a, b) => {
      if (a.lastRun !== b.lastRun) { return b.lastRun - a.lastRun; }
      if (a.runCount !== b.runCount) { return b.runCount - a.runCount; }
      return a.name.localeCompare(b.name);
    });
}
