import * as vscode from 'vscode';

const SHELL_INTEGRATION_WAIT_MS = 3000;

export async function createCommandTerminal(
  name: string,
  cwd: string,
  commandLine: string,
): Promise<vscode.Terminal> {
  const terminal = vscode.window.createTerminal({ name, cwd });

  terminal.show(false);

  const shellIntegration = await waitForShellIntegration(terminal);
  if (shellIntegration) {
    shellIntegration.executeCommand(commandLine);
    return terminal;
  }

  // Waiting for the shell process avoids intermittently losing input while a
  // newly-created terminal is still starting up.
  await terminal.processId;
  terminal.sendText(commandLine, true);
  return terminal;
}

async function waitForShellIntegration(
  terminal: vscode.Terminal,
): Promise<vscode.TerminalShellIntegration | undefined> {
  if (terminal.shellIntegration) {
    return terminal.shellIntegration;
  }

  return new Promise(resolve => {
    let settled = false;
    const finish = (shellIntegration?: vscode.TerminalShellIntegration) => {
      if (settled) return;
      settled = true;
      listener.dispose();
      clearTimeout(timer);
      resolve(shellIntegration);
    };

    const listener = vscode.window.onDidChangeTerminalShellIntegration(event => {
      if (event.terminal === terminal) {
        finish(event.shellIntegration);
      }
    });
    const timer = setTimeout(() => finish(), SHELL_INTEGRATION_WAIT_MS);
  });
}
