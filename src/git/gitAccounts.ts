import * as vscode from 'vscode';
import * as crypto from 'crypto';
import { GitAccount, GitProvider, AuthMethod, SshKey } from './types';
import { SharedStore, SyncAccount, SyncSshKey } from '../sync/sharedStore';

function simpleUuid(): string {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
    const r = (Math.random() * 16) | 0;
    const v = c === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

// ── Converters ────────────────────────────────────────────────────────────────
// Tokens are stored ONLY in context.secrets, keyed by account ID.
// The SyncAccount written to disk never includes the raw token.

function toGitAccount(sync: SyncAccount, token?: string): GitAccount {
  return {
    id: sync.id,
    provider: sync.provider as GitProvider,
    username: sync.username,
    email: sync.email,
    token,
    sshKeyId: sync.sshKeyId,
    authMethod: sync.authMethod as AuthMethod | undefined,
    lastValidatedAt: sync.lastValidatedAt,
    tokenExpiresAt: sync.tokenExpiresAt,
    createdAt: sync.createdAt,
  };
}

function toSyncAccount(account: GitAccount): SyncAccount {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { token: _token, ...safe } = account;
  return safe as SyncAccount;
}

function toSshKey(sync: SyncSshKey): SshKey {
  return sync as SshKey;
}

// ── GitAccounts ───────────────────────────────────────────────────────────────

export class GitAccounts {
  constructor(
    private context: vscode.ExtensionContext,
    private store: SharedStore
  ) { }

  // ── Accounts ────────────────────────────────────────────────────────────

  listAccounts(): GitAccount[] {
    const data = this.store.read();
    // We return accounts without tokens in bulk; callers that need tokens fetch them individually.
    return data.accounts.map(a => toGitAccount(a));
  }

  saveAccounts(list: GitAccount[]) {
    this.store.write({ accounts: list.map(toSyncAccount) });
  }

  addAccount(account: Partial<GitAccount>): GitAccount {
    const data = this.store.read();
    const accounts = data.accounts;

    const existingIdx = accounts.findIndex(a =>
      a.provider === (account.provider || 'github') &&
      a.username.toLowerCase() === (account.username || '').toLowerCase()
    );

    if (existingIdx >= 0) {
      const merged: SyncAccount = { ...accounts[existingIdx], ...toSyncAccount(account as GitAccount) };
      accounts[existingIdx] = merged;
      this.store.write({ accounts });
      // Persist token if provided
      if (account.token) {
        this.context.secrets.store(`ultraview.git.token.${merged.id}`, account.token);
      }
      return toGitAccount(merged, account.token);
    }

    const acc: GitAccount = {
      id: account.id || simpleUuid(),
      provider: account.provider || 'github',
      username: account.username || '',
      email: account.email,
      token: account.token,
      sshKeyId: account.sshKeyId,
      authMethod: account.authMethod,
      lastValidatedAt: account.lastValidatedAt,
      tokenExpiresAt: account.tokenExpiresAt,
      createdAt: account.createdAt || Date.now(),
    };
    accounts.push(toSyncAccount(acc));
    this.store.write({ accounts });

    // Persist token separately
    if (acc.token) {
      this.context.secrets.store(`ultraview.git.token.${acc.id}`, acc.token);
    }
    return acc;
  }

  updateAccount(id: string, patch: Partial<GitAccount>) {
    const data = this.store.read();
    const accounts = data.accounts;
    const idx = accounts.findIndex(a => a.id === id);
    if (idx >= 0) {
      const { token, ...safePatch } = patch;
      accounts[idx] = { ...accounts[idx], ...safePatch };
      this.store.write({ accounts });
      if (token !== undefined) {
        this.context.secrets.store(`ultraview.git.token.${id}`, token);
      }
    }
  }

  removeAccount(id: string) {
    const data = this.store.read();
    const accounts = data.accounts.filter(a => a.id !== id);
    const localAccounts = data.localAccounts.filter(l => l.accountId !== id);
    this.store.write({ accounts, localAccounts });
    this.context.secrets.delete(`ultraview.git.token.${id}`);
  }

  getAccount(id: string): GitAccount | undefined {
    const data = this.store.read();
    const sync = data.accounts.find(a => a.id === id);
    if (!sync) return undefined;
    return toGitAccount(sync);
  }

  async getAccountWithToken(id: string): Promise<GitAccount | undefined> {
    const data = this.store.read();
    const sync = data.accounts.find(a => a.id === id);
    if (!sync) return undefined;
    const token = await this.context.secrets.get(`ultraview.git.token.${id}`);
    return toGitAccount(sync, token);
  }

  // ── Per-project account selection ──────────────────────────────────────

  setLocalAccount(workspaceUri: string, accountId: string | undefined) {
    const data = this.store.read();
    const local = [...data.localAccounts];
    const existing = local.findIndex(l => l.workspaceUri === workspaceUri);
    if (accountId) {
      if (existing >= 0) {
        local[existing] = { workspaceUri, accountId };
      } else {
        local.push({ workspaceUri, accountId });
      }
    } else if (existing >= 0) {
      local.splice(existing, 1);
    }
    this.store.write({ localAccounts: local });
  }

  getLocalAccount(workspaceUri: string): GitAccount | undefined {
    const entry = this.store.read().localAccounts.find(l => l.workspaceUri === workspaceUri);
    if (!entry) return undefined;
    return this.getAccount(entry.accountId);
  }

  // ── SSH Keys ─────────────────────────────────────────────────────────────

  listSshKeys(): SshKey[] {
    return this.store.read().sshKeys.map(toSshKey);
  }

  saveSshKeys(list: SshKey[]) {
    this.store.write({ sshKeys: list });
  }

  addSshKey(key: Partial<SshKey>): SshKey {
    const keys = this.store.read().sshKeys;
    const sshKey: SshKey = {
      id: key.id || simpleUuid(),
      name: key.name || 'SSH Key',
      publicKey: key.publicKey || '',
      privateKeyPath: key.privateKeyPath,
      provider: key.provider || 'github',
      accountId: key.accountId || '',
      createdAt: key.createdAt || Date.now(),
    };
    keys.push(sshKey);
    this.store.write({ sshKeys: keys });
    return sshKey;
  }

  removeSshKey(id: string) {
    const keys = this.store.read().sshKeys.filter(k => k.id !== id);
    this.store.write({ sshKeys: keys });
  }

  getSshKey(id: string): SshKey | undefined {
    return this.store.read().sshKeys.find(k => k.id === id) as SshKey | undefined;
  }

  async generateSshKey(accountId: string, provider: GitProvider, keyName?: string): Promise<SshKey> {
    const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519', {
      publicKeyEncoding: { type: 'spki', format: 'pem' },
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    });

    const key = this.addSshKey({
      name: keyName || `ultraview-${provider}-${Date.now()}`,
      publicKey: publicKey.replace(/-----BEGIN PUBLIC KEY-----/, '').replace(/-----END PUBLIC KEY-----/, '').trim(),
      provider,
      accountId,
      privateKeyPath: `ultraview-ssh-${Date.now()}.pem`,
    });

    await this.context.secrets.store(`ultraview.git.sshkey.${key.id}`, privateKey);
    return key;
  }

  async getPrivateKey(keyId: string): Promise<string | undefined> {
    return this.context.secrets.get(`ultraview.git.sshkey.${keyId}`);
  }

  async deletePrivateKey(keyId: string): Promise<void> {
    await this.context.secrets.delete(`ultraview.git.sshkey.${keyId}`);
  }

  getProviderUrl(provider: GitProvider): { sshKeyUrl: string; tokenUrl: string } {
    switch (provider) {
      case 'github':
        return {
          sshKeyUrl: 'https://github.com/settings/ssh/new',
          tokenUrl: 'https://github.com/settings/tokens/new',
        };
      case 'gitlab':
        return {
          sshKeyUrl: 'https://gitlab.com/-/profile/keys',
          tokenUrl: 'https://gitlab.com/-/profile/personal_access_tokens',
        };
      case 'azure':
        return {
          sshKeyUrl: 'https://dev.azure.com/{user}/_settings/ssh',
          tokenUrl: 'https://dev.azure.com/_usersSettings/tokens',
        };
      default:
        return { sshKeyUrl: '', tokenUrl: '' };
    }
  }

  // ── Token Validation ────────────────────────────────────────────────────

  /**
   * Validate an OAuth account's token with a lightweight API call.
   * Returns { valid, expired } and updates lastValidatedAt in the sync file.
   */
  async validateToken(id: string): Promise<{ valid: boolean; expired: boolean }> {
    const token = await this.context.secrets.get(`ultraview.git.token.${id}`);
    const account = this.getAccount(id);
    if (!account) return { valid: false, expired: true };

    // SSH and PAT accounts don't need validation (they don't expire via OAuth flow)
    if (account.authMethod === 'ssh') {
      this.updateAccount(id, { lastValidatedAt: Date.now() });
      return { valid: true, expired: false };
    }
    if (account.authMethod === 'pat') {
      // PATs can technically expire, but we just check if token exists
      const hasToken = !!token;
      if (hasToken) {
        this.updateAccount(id, { lastValidatedAt: Date.now() });
      }
      return { valid: hasToken, expired: !hasToken };
    }

    // OAuth: check if token exists first
    if (!token) {
      return { valid: false, expired: true };
    }

    // Check tokenExpiresAt if set
    if (account.tokenExpiresAt && account.tokenExpiresAt < Date.now()) {
      return { valid: false, expired: true };
    }

    // Make a lightweight API call to verify the token is still valid
    try {
      let res: Response;
      if (account.provider === 'github') {
        res = await fetch('https://api.github.com/user', {
          headers: { 'Authorization': `Bearer ${token}`, 'User-Agent': 'Ultraview-VSCode' }
        });
      } else if (account.provider === 'gitlab') {
        res = await fetch('https://gitlab.com/api/v4/user', {
          headers: { 'Authorization': `Bearer ${token}` }
        });
      } else {
        // Azure or unknown — assume valid if token exists
        this.updateAccount(id, { lastValidatedAt: Date.now() });
        return { valid: true, expired: false };
      }

      if (res.ok) {
        this.updateAccount(id, { lastValidatedAt: Date.now() });
        return { valid: true, expired: false };
      }
      if (res.status === 401 || res.status === 403) {
        return { valid: false, expired: true };
      }
      // Network error or server error — assume still valid but stale
      return { valid: true, expired: false };
    } catch {
      // Network error — don't mark as expired, just can't validate
      return { valid: true, expired: false };
    }
  }

  /**
   * Compute auth status for an account for UI display.
   */
  getAccountAuthStatus(account: GitAccount): 'valid' | 'warning' | 'expired' {
    // SSH and PAT are always valid
    if (account.authMethod === 'ssh' || account.authMethod === 'pat') {
      return 'valid';
    }

    // OAuth accounts: check tokenExpiresAt
    if (account.tokenExpiresAt) {
      const now = Date.now();
      if (account.tokenExpiresAt < now) {
        return 'expired';
      }
      // Warn if token expires within 24 hours
      const ONE_DAY = 24 * 60 * 60 * 1000;
      if (account.tokenExpiresAt < now + ONE_DAY) {
        return 'warning';
      }
    }

    // If it's OAuth and we haven't validated in over 24 hours, show warning
    if (account.authMethod === 'oauth') {
      const ONE_DAY = 24 * 60 * 60 * 1000;
      if (!account.lastValidatedAt || (Date.now() - account.lastValidatedAt > ONE_DAY)) {
        return 'warning';
      }
    }

    return 'valid';
  }
}
