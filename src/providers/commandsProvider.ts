import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
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
  // Sort by workspace order file if present, else fallback to usage
  return await sortCommandsByWorkspaceOrder(commands);
}


// --- Workspace command order tracking ---
const ORDER_FILE = '.vscode/command-order.json';

function getOrderFilePath(): string | null {
  const folders = vscode.workspace.workspaceFolders;
  if (!folders || folders.length === 0) return null;
  return path.join(folders[0].uri.fsPath, ORDER_FILE);
}

function getCommandId(command: ProjectCommand): string {
  return `${command.workspaceLabel}:${command.type}:${command.name}:${command.cwd}`;
}

function readOrderFile(): string[] {
  const file = getOrderFilePath();
  if (!file || !fs.existsSync(file)) return [];
  try {
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    return Array.isArray(data.order) ? data.order : [];
  } catch {
    return [];
  }
}

function writeOrderFile(order: string[]): void {
  const file = getOrderFilePath();
  if (!file) return;
  try {
    fs.writeFileSync(file, JSON.stringify({ order }, null, 2));
  } catch {}
}

function recordCommandUsage(command: ProjectCommand): void {
  // Update order file: move this commandId to the front
  const id = getCommandId(command);
  let order = readOrderFile();
  order = [id, ...order.filter(x => x !== id)];
  writeOrderFile(order);
}

async function sortCommandsByWorkspaceOrder(commands: ProjectCommand[]): Promise<ProjectCommand[]> {
  const order = readOrderFile();
  // Always put dev command at top if no order
  if (!order.length) {
    return commands.slice().sort((a, b) => {
      if (a.priority !== b.priority) return a.priority - b.priority;
      return a.name.localeCompare(b.name);
    });
  }
  // Sort by order file, then by priority/name for new commands
  const idMap = new Map(commands.map(cmd => [getCommandId(cmd), cmd]));
  const ordered = order.map(id => idMap.get(id)).filter(Boolean) as ProjectCommand[];
  const rest = commands.filter(cmd => !order.includes(getCommandId(cmd)));
  rest.sort((a, b) => {
    if (a.priority !== b.priority) return a.priority - b.priority;
    return a.name.localeCompare(b.name);
  });
  return [...ordered, ...rest];
}
