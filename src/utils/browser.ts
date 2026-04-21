import * as vscode from 'vscode';

const INTERNAL_BROWSER_COMMANDS: ReadonlyArray<{
  id: string;
  getArgs: (url: string) => unknown[];
}> = [
  {
    id: 'browse-lite.open',
    getArgs: (url: string) => [url],
  },
  {
    id: 'simpleBrowser.show',
    getArgs: (url: string) => [url],
  },
  {
    id: 'simpleBrowser.api.open',
    getArgs: (url: string) => [vscode.Uri.parse(url)],
  },
];

export async function openUrlInVsCodeBrowser(
  url: string,
  options?: { promptExternalOnFailure?: boolean; failureContext?: string }
): Promise<boolean> {
  for (const command of INTERNAL_BROWSER_COMMANDS) {
    try {
      await vscode.commands.executeCommand(command.id, ...command.getArgs(url));
      return true;
    } catch {
      // Try the next in-editor browser option.
    }
  }

  if (options?.promptExternalOnFailure) {
    const action = 'Open External Browser';
    const message = options.failureContext
      ? `${options.failureContext} couldn't open inside VS Code.`
      : 'No in-editor browser is available for this URL.';
    const selection = await vscode.window.showWarningMessage(message, action);
    if (selection === action) {
      await vscode.env.openExternal(vscode.Uri.parse(url));
    }
  }

  return false;
}
