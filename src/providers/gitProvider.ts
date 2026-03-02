import * as vscode from 'vscode';
import { buildGitHtml } from '../git/gitUi';
import { GitProjects } from '../git/gitProjects';
import { GitAccounts } from '../git/gitAccounts';
import { GitProfile, GitProvider as GitProviderType, AuthMethod } from '../git/types';
import { applyLocalAccount, clearLocalAccount } from '../git/gitCredentials';
import { SharedStore } from '../sync/sharedStore';

export class GitProvider implements vscode.WebviewViewProvider {
  public static readonly viewId = 'ultraview.git';
  private view?: vscode.WebviewView;
  private context: vscode.ExtensionContext;
  private manager: GitProjects;
  private accounts: GitAccounts;
  private store: SharedStore;

  constructor(context: vscode.ExtensionContext, store: SharedStore) {
    this.context = context;
    this.store = store;
    this.manager = new GitProjects(context, store);
    this.accounts = new GitAccounts(context, store);
  }

  resolveWebviewView(webviewView: vscode.WebviewView) {
    this.view = webviewView;
    webviewView.webview.options = { enableScripts: true };
    webviewView.webview.html = buildGitHtml();

    // Hot-reload when another IDE writes the shared sync file
    this.store.on('changed', () => this.postState());

    webviewView.webview.onDidReceiveMessage(async msg => {
      switch (msg.type) {
        case 'ready': {
          // On ready, auto-apply credentials for the current project
          await this._autoApplyOnOpen();
          await this._validateAllTokensBackground();
          this.postState();
          break;
        }
        case 'addProject': {
          const uri = await vscode.window.showOpenDialog({ canSelectFolders: true, canSelectFiles: false, openLabel: 'Select folder for project' });
          if (uri && uri[0]) {
            const folder = uri[0].fsPath;
            const name = await vscode.window.showInputBox({ prompt: 'Project name', value: nameFromPath(folder) });
            if (name !== undefined) {
              this.manager.addProject({ name: name || nameFromPath(folder), path: folder });
              this.postState();
            }
          }
          break;
        }
        case 'addCurrentProject': {
          const workspaceFolders = vscode.workspace.workspaceFolders;
          if (workspaceFolders && workspaceFolders.length > 0) {
            const folder = workspaceFolders[0].uri.fsPath;
            const name = workspaceFolders[0].name;
            this.manager.addProject({ name, path: folder });
            this.postState();
          } else {
            vscode.window.showInformationMessage('No workspace folder open. Use "+ Add" to select a folder.');
          }
          break;
        }
        case 'addRepo': {
          if (this.view) {
            await GitProvider._handleAddRepo(this.view.webview, this.manager, this.accounts, () => this.postState());
          }
          break;
        }
        case 'refresh': {
          this.postState();
          break;
        }
        case 'delete': {
          const id = msg.id;
          this.manager.removeProject(id);
          this.postState();
          break;
        }
        case 'open': {
          const id = msg.id;
          const project = this.manager.listProjects().find(p => p.id === id);
          if (project) {
            // Apply credentials for the project's bound account before opening
            if (project.accountId) {
              const acc = await this.accounts.getAccountWithToken(project.accountId);
              if (acc) {
                await applyLocalAccount(project.path, acc, acc.token);
              }
            }
            // Flag so the Git panel auto-focuses after the window reloads
            await this.context.globalState.update('ultraview.git.focusOnOpen', true);
            const uri = vscode.Uri.file(project.path);
            vscode.commands.executeCommand('vscode.openFolder', uri, false);
          }
          break;
        }
        case 'addAccount': {
          await this._addAccount();
          break;
        }
        case 'removeAccount': {
          const accountId = msg.accountId;
          if (accountId) {
            const keys = this.accounts.listSshKeys().filter(k => k.accountId === accountId);
            for (const key of keys) {
              await this.accounts.deletePrivateKey(key.id);
              this.accounts.removeSshKey(key.id);
            }
            this.accounts.removeAccount(accountId);
            this.postState();
          }
          break;
        }
        case 'switchAccount': {
          const accountId = msg.accountId;
          const activeRepo = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? '';
          if (!activeRepo) {
            vscode.window.showWarningMessage('No workspace open. Open a project first.');
            break;
          }

          // Find or create the project for this workspace
          let project = this.manager.getProjectByPath(activeRepo);
          if (!project) {
            const name = nameFromPath(activeRepo);
            project = this.manager.addProject({ name, path: activeRepo });
          }

          // Bind account to project
          this.manager.setProjectAccount(project.id, accountId);
          this.accounts.setLocalAccount(activeRepo, accountId);

          // Apply git credentials
          const acc = await this.accounts.getAccountWithToken(accountId);
          if (acc) {
            await applyLocalAccount(activeRepo, acc, acc.token);
            vscode.window.showInformationMessage(`✓ Switched to ${acc.username} for this project.`);
          }

          this.postState();
          break;
        }
        case 'authOptions': {
          const accountId = msg.accountId;
          const account = this.accounts.getAccount(accountId);
          if (!account) break;
          const option = await vscode.window.showQuickPick([
            { label: '$(key) Manage SSH Key', description: 'Generate and configure SSH key' },
            { label: '$(key) Manage Token', description: 'Add or update personal access token' }
          ], { placeHolder: `Manage Auth for ${account.username}` });
          if (option?.label.includes('SSH')) {
            await GitProvider._handleGenerateSshKey(accountId, this.view?.webview, this.accounts, () => this.postState());
          } else if (option?.label.includes('Token')) {
            await GitProvider._handleAddToken(accountId, this.view?.webview, this.accounts);
          }
          break;
        }
        case 'generateSshKey': {
          const accountId = msg.accountId;
          await GitProvider._handleGenerateSshKey(accountId, this.view?.webview, this.accounts, () => this.postState());
          break;
        }
        case 'addToken': {
          const accountId = msg.accountId;
          await GitProvider._handleAddToken(accountId, this.view?.webview, this.accounts);
          break;
        }
        case 'reAuthAccount': {
          const accountId = msg.accountId;
          const account = this.accounts.getAccount(accountId);
          if (!account) break;
          await this._reAuthOAuth(account.id, account.provider);
          break;
        }
        case 'validateToken': {
          const accountId = msg.accountId;
          const result = await this.accounts.validateToken(accountId);
          this.postState();
          break;
        }
        case 'validateAllTokens': {
          await this._validateAllTokensBackground();
          this.postState();
          break;
        }
      }
    });

    // initial state
    this.postState();
  }

  postState() {
    if (!this.view) return;
    const projects = this.manager.listProjects();
    const activeRepo = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? '';
    const accounts = this.accounts.listAccounts();

    // Find active project and its account
    const activeProject = projects.find(p => p.path === activeRepo);
    const activeAccountId = activeProject?.accountId ||
      (activeRepo ? this.accounts.getLocalAccount(activeRepo)?.id : undefined);

    // Compute auth status for each account
    const accountsWithStatus = accounts.map(acc => ({
      ...acc,
      authStatus: this.accounts.getAccountAuthStatus(acc),
    }));

    this.view.webview.postMessage({
      type: 'state',
      projects,
      activeRepo,
      accounts: accountsWithStatus,
      activeAccountId: activeAccountId || null,
      activeProjectId: activeProject?.id || null,
    });
  }

  /** Auto-apply credentials when the extension loads for the current workspace */
  private async _autoApplyOnOpen() {
    const activeRepo = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? '';
    if (!activeRepo) return;

    // Check project-level binding first
    const project = this.manager.getProjectByPath(activeRepo);
    const accountId = project?.accountId || this.accounts.getLocalAccount(activeRepo)?.id;
    if (!accountId) return;

    const acc = await this.accounts.getAccountWithToken(accountId);
    if (acc) {
      await applyLocalAccount(activeRepo, acc, acc.token);
      console.log(`[Ultraview] Auto-applied account ${acc.username} for ${activeRepo}`);
    }
  }

  /** Re-authenticate an existing OAuth account (refresh token). */
  private async _reAuthOAuth(accountId: string, provider: GitProviderType): Promise<void> {
    const browserProviders: Record<string, string> = { github: 'github', gitlab: 'gitlab', azure: 'microsoft' };
    const vsCodeProviderId = browserProviders[provider];
    const scopes: Record<string, string[]> = {
      github: ['repo', 'read:user', 'user:email'],
      gitlab: ['read_user', 'api'],
      microsoft: ['499b84ac-1321-427f-aa17-267ca6975798/.default']
    };
    try {
      const session = await vscode.authentication.getSession(vsCodeProviderId, scopes[vsCodeProviderId] || [], { forceNewSession: true });
      this.accounts.updateAccount(accountId, {
        token: session.accessToken,
        lastValidatedAt: Date.now(),
        authMethod: 'oauth',
      });
      vscode.window.showInformationMessage(`✓ Re-authenticated successfully.`);
      this.postState();
    } catch (err: any) {
      vscode.window.showErrorMessage(`Re-auth failed: ${err?.message ?? String(err)}`);
    }
  }

  /** Background-validate all OAuth account tokens silently. */
  private async _validateAllTokensBackground(): Promise<void> {
    const accounts = this.accounts.listAccounts();
    for (const acc of accounts) {
      if (acc.authMethod === 'oauth') {
        await this.accounts.validateToken(acc.id);
      }
    }
  }

  private async _addAccount(): Promise<void> {
    const provider = await vscode.window.showQuickPick([
      { label: 'github', description: 'GitHub' },
      { label: 'gitlab', description: 'GitLab' },
      { label: 'azure', description: 'Azure DevOps' }
    ], { placeHolder: 'Select provider' });

    if (!provider) return;

    const browserProviders: Record<string, string> = { github: 'github', gitlab: 'gitlab', azure: 'microsoft' };
    const authMethodItems: { label: string; description: string }[] = [
      { label: 'browser', description: 'Sign in via browser (OAuth) — recommended' },
      { label: 'ssh', description: 'Generate SSH key' },
      { label: 'token', description: 'Enter personal access token manually' }
    ];

    const authMethod = await vscode.window.showQuickPick(authMethodItems, { placeHolder: 'How do you want to authenticate?' });
    if (!authMethod) return;

    if (authMethod.label === 'browser') {
      await this._addAccountViaOAuth(provider.label as GitProviderType, browserProviders[provider.label]);
      return;
    }

    const username = await vscode.window.showInputBox({ prompt: `${provider.label} username` });
    if (!username) return;

    const authMethodValue: AuthMethod = authMethod.label === 'ssh' ? 'ssh' : authMethod.label === 'token' ? 'pat' : 'oauth';
    const account = this.accounts.addAccount({
      provider: provider.label as GitProviderType,
      username,
      authMethod: authMethodValue,
    });

    // Auto-bind to current project
    const activeRepo = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? '';
    if (activeRepo) {
      let project = this.manager.getProjectByPath(activeRepo);
      if (!project) {
        project = this.manager.addProject({ name: nameFromPath(activeRepo), path: activeRepo });
      }
      this.manager.setProjectAccount(project.id, account.id);
      this.accounts.setLocalAccount(activeRepo, account.id);
      await applyLocalAccount(activeRepo, account, account.token);
    }

    if (authMethod.label === 'ssh') {
      const keyName = await vscode.window.showInputBox({ prompt: 'SSH key name (optional)', value: `ultraview-${username}` });
      const key = await this.accounts.generateSshKey(account.id, account.provider, keyName || undefined);
      const { sshKeyUrl } = this.accounts.getProviderUrl(account.provider);
      await vscode.env.clipboard.writeText(key.publicKey);
      vscode.window.showInformationMessage(`SSH key generated and copied to clipboard! Opening ${account.provider} settings...`);
      vscode.env.openExternal(vscode.Uri.parse(sshKeyUrl));
      this.accounts.updateAccount(account.id, { sshKeyId: key.id });
    } else if (authMethod.label === 'token') {
      const token = await vscode.window.showInputBox({ prompt: 'Enter personal access token', password: true });
      if (token) {
        this.accounts.updateAccount(account.id, { token });
      }
    }

    this.postState();
  }

  private async _addAccountViaOAuth(gitProvider: GitProviderType, vsCodeProviderId: string): Promise<void> {
    const scopes: Record<string, string[]> = {
      github: ['repo', 'read:user', 'user:email'],
      gitlab: ['read_user', 'api'],
      microsoft: ['499b84ac-1321-427f-aa17-267ca6975798/.default']
    };

    try {
      const session = await vscode.authentication.getSession(vsCodeProviderId, scopes[vsCodeProviderId] || [], { forceNewSession: true });
      const username = session.account.label;
      const token = session.accessToken;

      // Try to fetch email from provider API
      let email: string | undefined;
      try {
        if (gitProvider === 'github') {
          const res = await fetch('https://api.github.com/user', {
            headers: { 'Authorization': `Bearer ${token}`, 'User-Agent': 'Ultraview-VSCode' }
          });
          if (res.ok) {
            const data = await res.json() as { email?: string };
            email = data.email || undefined;
          }
          if (!email) {
            const emailsRes = await fetch('https://api.github.com/user/emails', {
              headers: { 'Authorization': `Bearer ${token}`, 'User-Agent': 'Ultraview-VSCode' }
            });
            if (emailsRes.ok) {
              const emailsData = await emailsRes.json() as { email: string, primary: boolean }[];
              const primaryEmail = emailsData.find(e => e.primary);
              if (primaryEmail) {
                email = primaryEmail.email;
              } else if (emailsData.length > 0) {
                email = emailsData[0].email;
              }
            }
          }
        } else if (gitProvider === 'gitlab') {
          const res = await fetch('https://gitlab.com/api/v4/user', {
            headers: { 'Authorization': `Bearer ${token}` }
          });
          if (res.ok) {
            const data = await res.json() as { email?: string };
            email = data.email || undefined;
          }
        }
      } catch {
        // email is optional
      }

      const account = this.accounts.addAccount({ provider: gitProvider, username, email, token, authMethod: 'oauth' as AuthMethod, lastValidatedAt: Date.now() });

      // Auto-bind to current project
      const activeRepo = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? '';
      if (activeRepo) {
        let project = this.manager.getProjectByPath(activeRepo);
        if (!project) {
          project = this.manager.addProject({ name: nameFromPath(activeRepo), path: activeRepo });
        }
        this.manager.setProjectAccount(project.id, account.id);
        this.accounts.setLocalAccount(activeRepo, account.id);
        await applyLocalAccount(activeRepo, account, token);
      }

      vscode.window.showInformationMessage(`Signed in as ${username} via ${gitProvider}!`);
      this.postState();
    } catch (err: any) {
      if (err?.name === 'Error' && String(err?.message).includes('No authentication provider')) {
        vscode.window.showErrorMessage(`Browser sign-in for ${gitProvider} requires the ${gitProvider} extension to be installed. Use manual token instead.`);
      } else {
        vscode.window.showErrorMessage(`OAuth sign-in failed: ${err?.message ?? String(err)}`);
      }
    }
  }

  static openAsPanel(context: vscode.ExtensionContext, store: SharedStore) {
    const panel = vscode.window.createWebviewPanel('ultraview.git.panel', 'Git Projects', vscode.ViewColumn.One, { enableScripts: true, retainContextWhenHidden: true });
    panel.webview.html = buildGitHtml();

    const manager = new GitProjects(context, store);
    const accounts = new GitAccounts(context, store);

    const postPanelState = () => {
      const projects = manager.listProjects();
      const activeRepo = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? '';
      const accountList = accounts.listAccounts();
      const activeProject = projects.find(p => p.path === activeRepo);
      const activeAccountId = activeProject?.accountId ||
        (activeRepo ? accounts.getLocalAccount(activeRepo)?.id : undefined);

      // Compute auth status for each account
      const accountsWithStatus = accountList.map(acc => ({
        ...acc,
        authStatus: accounts.getAccountAuthStatus(acc),
      }));

      panel.webview.postMessage({
        type: 'state',
        projects,
        activeRepo,
        accounts: accountsWithStatus,
        activeAccountId: activeAccountId || null,
        activeProjectId: activeProject?.id || null,
      });
    };

    // Hot-reload when another IDE writes the shared sync file
    store.on('changed', postPanelState);
    panel.onDidDispose(() => store.off('changed', postPanelState));

    panel.webview.onDidReceiveMessage(async msg => {
      switch (msg.type) {
        case 'ready': {
          postPanelState();
          break;
        }
        case 'addProject': {
          const uri = await vscode.window.showOpenDialog({ canSelectFolders: true, canSelectFiles: false, openLabel: 'Select folder for project' });
          if (uri && uri[0]) {
            const folder = uri[0].fsPath;
            const name = await vscode.window.showInputBox({ prompt: 'Project name', value: nameFromPath(folder) });
            if (name !== undefined) {
              manager.addProject({ name: name || nameFromPath(folder), path: folder });
              postPanelState();
            }
          }
          break;
        }
        case 'addCurrentProject': {
          const workspaceFolders = vscode.workspace.workspaceFolders;
          if (workspaceFolders && workspaceFolders.length > 0) {
            const folder = workspaceFolders[0].uri.fsPath;
            const name = workspaceFolders[0].name;
            manager.addProject({ name, path: folder });
            postPanelState();
          } else {
            vscode.window.showInformationMessage('No workspace folder open. Use "+ Add" to select a folder.');
          }
          break;
        }
        case 'addRepo': {
          await GitProvider._handleAddRepo(panel.webview, manager, accounts, postPanelState);
          break;
        }
        case 'refresh': {
          postPanelState();
          break;
        }
        case 'delete': {
          manager.removeProject(msg.id);
          postPanelState();
          break;
        }
        case 'open': {
          const project = manager.listProjects().find(p => p.id === msg.id);
          if (project) {
            if (project.accountId) {
              const acc = await accounts.getAccountWithToken(project.accountId);
              if (acc) {
                await applyLocalAccount(project.path, acc, acc.token);
              }
            }
            // Flag so the Git panel auto-focuses after the window reloads
            await context.globalState.update('ultraview.git.focusOnOpen', true);
            const uri = vscode.Uri.file(project.path);
            vscode.commands.executeCommand('vscode.openFolder', uri, false);
          }
          break;
        }
        case 'addAccount': {
          const provider = await vscode.window.showQuickPick([
            { label: 'github', description: 'GitHub' },
            { label: 'gitlab', description: 'GitLab' },
            { label: 'azure', description: 'Azure DevOps' }
          ], { placeHolder: 'Select provider' });
          if (!provider) break;

          const browserProviders: Record<string, string> = { github: 'github', gitlab: 'gitlab', azure: 'microsoft' };
          const authMethod = await vscode.window.showQuickPick([
            { label: 'browser', description: 'Sign in via browser (OAuth) — recommended' },
            { label: 'ssh', description: 'Generate SSH key' },
            { label: 'token', description: 'Enter personal access token manually' }
          ], { placeHolder: 'How do you want to authenticate?' });
          if (!authMethod) break;

          if (authMethod.label === 'browser') {
            const vsCodeProviderId = browserProviders[provider.label];
            const scopes: Record<string, string[]> = {
              github: ['repo', 'read:user', 'user:email'],
              gitlab: ['read_user', 'api'],
              microsoft: ['499b84ac-1321-427f-aa17-267ca6975798/.default']
            };
            try {
              const session = await vscode.authentication.getSession(vsCodeProviderId, scopes[vsCodeProviderId] || [], { forceNewSession: true });
              const username = session.account.label;
              const token = session.accessToken;
              let email: string | undefined;
              try {
                if (provider.label === 'github') {
                  const res = await fetch('https://api.github.com/user', { headers: { 'Authorization': `Bearer ${token}`, 'User-Agent': 'Ultraview-VSCode' } });
                  if (res.ok) { const d = await res.json() as { email?: string }; email = d.email || undefined; }
                  if (!email) {
                    const emailsRes = await fetch('https://api.github.com/user/emails', { headers: { 'Authorization': `Bearer ${token}`, 'User-Agent': 'Ultraview-VSCode' } });
                    if (emailsRes.ok) {
                      const emailsData = await emailsRes.json() as { email: string, primary: boolean }[];
                      const primaryEmail = emailsData.find(e => e.primary);
                      if (primaryEmail) email = primaryEmail.email;
                      else if (emailsData.length > 0) email = emailsData[0].email;
                    }
                  }
                } else if (provider.label === 'gitlab') {
                  const res = await fetch('https://gitlab.com/api/v4/user', { headers: { 'Authorization': `Bearer ${token}` } });
                  if (res.ok) { const d = await res.json() as { email?: string }; email = d.email || undefined; }
                }
              } catch { /* email optional */ }
              const account = accounts.addAccount({ provider: provider.label as GitProviderType, username, email, token, authMethod: 'oauth' as AuthMethod, lastValidatedAt: Date.now() });
              // Auto-bind to current project
              const activeRepo = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? '';
              if (activeRepo) {
                let project = manager.getProjectByPath(activeRepo);
                if (!project) project = manager.addProject({ name: nameFromPath(activeRepo), path: activeRepo });
                manager.setProjectAccount(project.id, account.id);
                accounts.setLocalAccount(activeRepo, account.id);
                await applyLocalAccount(activeRepo, account, token);
              }
              vscode.window.showInformationMessage(`Signed in as ${username} via ${provider.label}!`);
              postPanelState();
            } catch (err: any) {
              if (String(err?.message).includes('No authentication provider')) {
                vscode.window.showErrorMessage(`Browser sign-in for ${provider.label} requires the ${provider.label} extension. Use manual token instead.`);
              } else {
                vscode.window.showErrorMessage(`OAuth sign-in failed: ${err?.message ?? String(err)}`);
              }
            }
            break;
          }

          const username = await vscode.window.showInputBox({ prompt: `${provider.label} username` });
          if (!username) break;
          const authMethodValue: AuthMethod = authMethod.label === 'ssh' ? 'ssh' : authMethod.label === 'token' ? 'pat' : 'oauth';
          const account = accounts.addAccount({ provider: provider.label as GitProviderType, username, authMethod: authMethodValue });
          // Auto-bind to current project
          const activeRepo = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? '';
          if (activeRepo) {
            let project = manager.getProjectByPath(activeRepo);
            if (!project) project = manager.addProject({ name: nameFromPath(activeRepo), path: activeRepo });
            manager.setProjectAccount(project.id, account.id);
            accounts.setLocalAccount(activeRepo, account.id);
            await applyLocalAccount(activeRepo, account, account.token);
          }
          if (authMethod.label === 'ssh') {
            const keyName = await vscode.window.showInputBox({ prompt: 'SSH key name (optional)', value: `ultraview-${username}` });
            const key = await accounts.generateSshKey(account.id, account.provider, keyName || undefined);
            const { sshKeyUrl } = accounts.getProviderUrl(account.provider);
            await vscode.env.clipboard.writeText(key.publicKey);
            vscode.window.showInformationMessage(`SSH key generated and copied to clipboard! Opening ${account.provider} settings...`);
            vscode.env.openExternal(vscode.Uri.parse(sshKeyUrl));
            accounts.updateAccount(account.id, { sshKeyId: key.id });
          } else if (authMethod.label === 'token') {
            const token = await vscode.window.showInputBox({ prompt: 'Enter personal access token (with repo scope)', password: true });
            if (token) { accounts.updateAccount(account.id, { token }); }
          }
          postPanelState();
          break;
        }
        case 'switchAccount': {
          const accountId = msg.accountId;
          const activeRepo = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? '';
          if (!activeRepo) {
            vscode.window.showWarningMessage('No workspace open. Open a project first.');
            break;
          }
          let project = manager.getProjectByPath(activeRepo);
          if (!project) {
            project = manager.addProject({ name: nameFromPath(activeRepo), path: activeRepo });
          }
          manager.setProjectAccount(project.id, accountId);
          accounts.setLocalAccount(activeRepo, accountId);
          const acc = await accounts.getAccountWithToken(accountId);
          if (acc) {
            await applyLocalAccount(activeRepo, acc, acc.token);
            vscode.window.showInformationMessage(`✓ Switched to ${acc.username} for this project.`);
          }
          postPanelState();
          break;
        }
        case 'removeAccount': {
          const accountId = msg.accountId;
          if (accountId) {
            const keys = accounts.listSshKeys().filter(k => k.accountId === accountId);
            for (const key of keys) {
              await accounts.deletePrivateKey(key.id);
              accounts.removeSshKey(key.id);
            }
            accounts.removeAccount(accountId);
            postPanelState();
          }
          break;
        }
        case 'authOptions': {
          const accountId = msg.accountId;
          const account = accounts.getAccount(accountId);
          if (!account) break;
          const option = await vscode.window.showQuickPick([
            { label: '$(key) Manage SSH Key', description: 'Generate and configure SSH key' },
            { label: '$(key) Manage Token', description: 'Add or update personal access token' }
          ], { placeHolder: `Manage Auth for ${account.username}` });
          if (option?.label.includes('SSH')) {
            await GitProvider._handleGenerateSshKey(accountId, panel.webview, accounts, postPanelState);
          } else if (option?.label.includes('Token')) {
            await GitProvider._handleAddToken(accountId, panel.webview, accounts);
          }
          break;
        }
        case 'reAuthAccount': {
          const accountId = msg.accountId;
          const account = accounts.getAccount(accountId);
          if (!account) break;
          const browserProviders: Record<string, string> = { github: 'github', gitlab: 'gitlab', azure: 'microsoft' };
          const vsCodeProviderId = browserProviders[account.provider];
          const scopes: Record<string, string[]> = {
            github: ['repo', 'read:user', 'user:email'],
            gitlab: ['read_user', 'api'],
            microsoft: ['499b84ac-1321-427f-aa17-267ca6975798/.default']
          };
          try {
            const session = await vscode.authentication.getSession(vsCodeProviderId, scopes[vsCodeProviderId] || [], { forceNewSession: true });
            accounts.updateAccount(accountId, {
              token: session.accessToken,
              lastValidatedAt: Date.now(),
              authMethod: 'oauth',
            });
            vscode.window.showInformationMessage(`✓ Re-authenticated successfully.`);
            postPanelState();
          } catch (err: any) {
            vscode.window.showErrorMessage(`Re-auth failed: ${err?.message ?? String(err)}`);
          }
          break;
        }
        case 'validateToken': {
          const accountId = msg.accountId;
          await accounts.validateToken(accountId);
          postPanelState();
          break;
        }
        case 'validateAllTokens': {
          const accountList2 = accounts.listAccounts();
          for (const acc of accountList2) {
            if (acc.authMethod === 'oauth') {
              await accounts.validateToken(acc.id);
            }
          }
          postPanelState();
          break;
        }
      }
    });
  }

  private async _createProfile(): Promise<void> {
    const name = await vscode.window.showInputBox({ prompt: 'Profile name' });
    if (!name) return;

    const userName = await vscode.window.showInputBox({ prompt: 'Git user name (optional)' });
    const userEmail = await vscode.window.showInputBox({ prompt: 'Git user email (optional)' });

    const profile = this.manager.addProfile({ name, userName: userName || undefined, userEmail: userEmail || undefined });
    this.postState();
  }

  private async _editProfile(profile: GitProfile): Promise<void> {
    const name = await vscode.window.showInputBox({ prompt: 'Profile name', value: profile.name });
    if (name === undefined) return;

    const userName = await vscode.window.showInputBox({ prompt: 'Git user name (optional)', value: profile.userName || '' });
    const userEmail = await vscode.window.showInputBox({ prompt: 'Git user email (optional)', value: profile.userEmail || '' });

    const profiles = this.manager.listProfiles();
    const idx = profiles.findIndex(p => p.id === profile.id);
    if (idx >= 0) {
      profiles[idx] = { ...profiles[idx], name, userName: userName || undefined, userEmail: userEmail || undefined };
      this.manager.saveProfiles(profiles);
      this.postState();
    }
  }

  static async _handleGenerateSshKey(accountId: string, webview: vscode.Webview | undefined, activeAccs: GitAccounts, postStateCb?: () => void) {
    const account = activeAccs.getAccount(accountId);
    if (!account) return;
    const keyName = await vscode.window.showInputBox({ prompt: 'SSH key name (optional)', value: `ultraview-${account.username}` });
    const key = await activeAccs.generateSshKey(accountId, account.provider, keyName || undefined);
    const { sshKeyUrl } = activeAccs.getProviderUrl(account.provider);
    await vscode.env.clipboard.writeText(key.publicKey);
    vscode.window.showInformationMessage(`SSH key generated and copied to clipboard! Opening ${account.provider} settings...`);
    vscode.env.openExternal(vscode.Uri.parse(sshKeyUrl));
    if (postStateCb) postStateCb();
    webview?.postMessage({ type: 'sshKeyGenerated', key, accountId });
  }

  static async _handleAddToken(accountId: string, webview: vscode.Webview | undefined, activeAccs: GitAccounts) {
    const acct = activeAccs.getAccount(accountId);
    if (!acct) return;

    if (acct.provider === 'github') {
      const method = await vscode.window.showQuickPick([
        { label: 'browser', description: 'Sign in via browser (OAuth)' },
        { label: 'manual', description: 'Paste personal access token' }
      ], { placeHolder: 'How to add token?' });
      if (!method) return;
      if (method.label === 'browser') {
        try {
          const session = await vscode.authentication.getSession('github', ['repo', 'read:user', 'user:email'], { forceNewSession: true });
          activeAccs.updateAccount(accountId, { token: session.accessToken });
          webview?.postMessage({ type: 'accountUpdated', accountId });
          vscode.window.showInformationMessage(`Token updated for ${acct.username} via GitHub OAuth.`);
        } catch (err: any) {
          vscode.window.showErrorMessage(`OAuth failed: ${err?.message ?? String(err)}`);
        }
        return;
      }
    }

    const token = await vscode.window.showInputBox({ prompt: 'Enter personal access token (with repo scope)', password: true });
    if (token) {
      activeAccs.updateAccount(accountId, { token });
      webview?.postMessage({ type: 'accountUpdated', accountId });
    }
  }

  static async _handleAddRepo(webview: vscode.Webview, manager: GitProjects, accounts: GitAccounts, postStateCb: () => void) {
    const activeRepo = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? '';
    const activeAcc = activeRepo ? accounts.getLocalAccount(activeRepo) : undefined;
    if (!activeAcc) {
      vscode.window.showErrorMessage('No active Git account. Please add/select an account first.');
      return;
    }
    const accWithToken = await accounts.getAccountWithToken(activeAcc.id);
    if (!accWithToken || !accWithToken.token) {
      vscode.window.showErrorMessage(`Account ${activeAcc.username} has no token. Please authenticate first.`);
      return;
    }

    let repos: { name: string; url: string; private: boolean }[] = [];
    try {
      if (activeAcc.provider === 'github') {
        const res = await fetch('https://api.github.com/user/repos?per_page=100&sort=updated', {
          headers: { 'Authorization': `Bearer ${accWithToken.token}`, 'User-Agent': 'Ultraview-VSCode' }
        });
        if (!res.ok) throw new Error('GitHub API error');
        const data = await res.json() as any[];
        repos = data.map(r => ({ name: r.full_name, url: r.clone_url, private: r.private }));
      } else if (activeAcc.provider === 'gitlab') {
        const res = await fetch('https://gitlab.com/api/v4/projects?membership=true&simple=true&per_page=100&order_by=updated_at', {
          headers: { 'Authorization': `Bearer ${accWithToken.token}` }
        });
        if (!res.ok) throw new Error('GitLab API error');
        const data = await res.json() as any[];
        repos = data.map(r => ({ name: r.path_with_namespace, url: r.http_url_to_repo, private: r.visibility === 'private' || r.visibility === 'internal' }));
      } else {
        vscode.window.showInformationMessage('Fetching repos is currently only supported for GitHub and GitLab.');
      }
    } catch (err: any) {
      vscode.window.showErrorMessage(`Failed to fetch repos: ${err.message}`);
      return;
    }

    if (repos.length === 0) {
      const manualUrl = await vscode.window.showInputBox({ prompt: 'No repos found. Enter a clone URL manually' });
      if (!manualUrl) return;
      repos.push({ name: manualUrl.split('/').pop()?.replace('.git', '') || manualUrl, url: manualUrl, private: false });
    }

    const items = repos.map(r => ({ label: `$(repo) ${r.name}`, description: r.private ? 'Private' : 'Public', url: r.url, name: r.name }));
    const selected = await vscode.window.showQuickPick(items, { placeHolder: 'Select a repository to clone', matchOnDescription: true });
    if (!selected) return;

    const destUri = await vscode.window.showOpenDialog({ canSelectFolders: true, canSelectFiles: false, openLabel: 'Select clone destination folder' });
    if (!destUri || !destUri[0]) return;
    const destPath = destUri[0].fsPath;

    const repoName = selected.name.split('/').pop()?.replace('.git', '') || 'repo';
    const fullPath = require('path').join(destPath, repoName);

    await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: `Cloning ${selected.name}...` }, async () => {
      const execAsync = require('util').promisify(require('child_process').exec);
      try {
        const urlObj = new URL(selected.url);
        urlObj.username = accWithToken.username;
        urlObj.password = accWithToken.token!;
        const cloneUrl = urlObj.toString();

        await execAsync(`git clone "${cloneUrl}" "${repoName}"`, { cwd: destPath });

        const project = manager.addProject({ name: repoName, path: fullPath, accountId: activeAcc.id });

        accounts.setLocalAccount(fullPath, activeAcc.id);
        await applyLocalAccount(fullPath, accWithToken, accWithToken.token!);

        postStateCb();
        vscode.window.showInformationMessage(`Successfully cloned and added ${selected.name}`);
      } catch (err: any) {
        vscode.window.showErrorMessage(`Failed to clone: ${err.message}`);
      }
    });
  }
}

function nameFromPath(p: string) {
  const parts = p.replace(/\\/g, '/').split('/');
  return parts[parts.length - 1] || p;
}
