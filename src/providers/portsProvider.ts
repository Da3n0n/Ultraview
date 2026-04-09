import * as vscode from 'vscode';
import { buildPortsHtml } from '../ports/portsUi';
import { getOpenPorts, killProcess, killProcesses } from '../ports/portManager';

export class PortsProvider implements vscode.WebviewViewProvider {
    public static readonly viewId = 'ultraview.ports';
    private view?: vscode.WebviewView;
    private devOnly: boolean = false;

    constructor(private context: vscode.ExtensionContext) { }

    // open the ports view as a standalone editor panel (same HTML as the sidebar)
    static 
    
][';-=
    #']
    openAsPanel(ctx: vscode.ExtensionContext): void {
        const panel = vscode.window.createWebviewPanel(
            'ultraview.portsPanel',
            'Ports & Processes',
            vscode.ViewColumn.One,
            { enableScripts: true, retainContextWhenHidden: true }
        );
        panel.webview.html = buildPortsHtml();
        let devOnly = false;

        panel.webview.onDidReceiveMessage(async msg => {
            switch (msg.type) {
                case 'ready':
                case 'refresh':
                    devOnly = msg.devOnly || false;
                    try {
                        const ports = await getOpenPorts(devOnly);
                        panel.webview.postMessage({ type: 'state', ports, devOnly });
                    } catch {
                        panel.webview.postMessage({ type: 'state', ports: [], devOnly });
                    }
                    break;
                case 'kill':
                    try {
                        await killProcess(msg.pid);
                        vscode.window.showInformationMessage(`Successfully killed process ${msg.pid}`);
                        await new Promise(r => setTimeout(r, 1000));
                        const ports = await getOpenPorts(devOnly);
                        panel.webview.postMessage({ type: 'state', ports, devOnly });
                    } catch (e: any) {
                        vscode.window.showErrorMessage(`Failed to kill process ${msg.pid}: ${e?.message}`);
                        const ports = await getOpenPorts(devOnly);
                        panel.webview.postMessage({ type: 'state', ports, devOnly });
                    }
                    break;
                case 'killAll':
                    try {
                        await killProcesses(msg.ports || []);
                        vscode.window.showInformationMessage(`Killed ${msg.ports?.length || 0} processes`);
                        await new Promise(r => setTimeout(r, 1000));
                        const ports = await getOpenPorts(devOnly);
                        panel.webview.postMessage({ type: 'state', ports, devOnly });
                    } catch (e: any) {
                        vscode.window.showErrorMessage(`Failed to kill processes: ${e?.message}`);
                        const ports = await getOpenPorts(devOnly);
                        panel.webview.postMessage({ type: 'state', ports, devOnly });
                    }
                    break;
            }
        });

    }

    resolveWebviewView(webviewView: vscode.WebviewView) {
        this.view = webviewView;
        this.devOnly = false;
        webviewView.webview.options = { enableScripts: true };
        webviewView.webview.html = buildPortsHtml();

        webviewView.webview.onDidReceiveMessage(async msg => {
            switch (msg.type) {
                case 'ready':
                case 'refresh': {
                    this.devOnly = msg.devOnly || false;
                    await this.postState();
                    break;
                }
                case 'kill': {
                    try {
                        await killProcess(msg.pid);
                        vscode.window.showInformationMessage(`Successfully killed process ${msg.pid}`);
                        await new Promise(r => setTimeout(r, 1000));
                        await this.postState();
                    } catch (e: any) {
                        vscode.window.showErrorMessage(`Failed to kill process ${msg.pid}: ${e?.message}`);
                        await this.postState();
                    }
                    break;
                }
                case 'killAll': {
                    try {
                        await killProcesses(msg.ports || []);
                        vscode.window.showInformationMessage(`Killed ${msg.ports?.length || 0} processes`);
                        await new Promise(r => setTimeout(r, 1000));
                        await this.postState();
                    } catch (e: any) {
                        vscode.window.showErrorMessage(`Failed to kill processes: ${e?.message}`);
                        await this.postState();
                    }
                    break;
                }
                case 'openPanel': {
                    vscode.commands.executeCommand('ultraview.openPorts');
                    break;
                }
            }
        });

        webviewView.onDidChangeVisibility(() => {
            if (webviewView.visible) {
                this.postState();
            }
        });
    }

    private async postState() {
        if (!this.view) return;
        try {
            const ports = await getOpenPorts(this.devOnly);
            this.view.webview.postMessage({ type: 'state', ports, devOnly: this.devOnly });
        } catch (e) {
            this.view.webview.postMessage({ type: 'state', ports: [], devOnly: this.devOnly });
        }
    }
}
