import * as vscode from 'vscode';
import { exec } from 'child_process';
import { promisify } from 'util';
import { GitAccount } from './types';

const execAsync = promisify(exec);

/**
 * Runs a git config command in a given directory.
 */
async function gitConfig(cwd: string, scope: '--local' | '--global', key: string, value: string): Promise<void> {
    const cmd = `git config ${scope} ${key} "${value.replace(/"/g, '\\"')}"`;
    await execAsync(cmd, { cwd });
}

async function gitConfigUnset(cwd: string, scope: '--local' | '--global', key: string): Promise<void> {
    try {
        await execAsync(`git config ${scope} --unset ${key}`, { cwd });
    } catch {
        // ignore — key may not exist
    }
}

/**
 * Build the provider hostname for credential matching.
 */
function hostForProvider(provider: string): string {
    switch (provider) {
        case 'github': return 'github.com';
        case 'gitlab': return 'gitlab.com';
        case 'azure': return 'dev.azure.com';
        default: return 'github.com';
    }
}

/**
 * Apply a git account's identity + credentials to a specific local repo path.
 * This makes VS Code's built-in Source Control use the right account.
 */
export async function applyLocalAccount(
    repoPath: string,
    account: GitAccount,
    token?: string
): Promise<void> {
    try {
        const host = hostForProvider(account.provider);

        // 1. Set commit identity
        await gitConfig(repoPath, '--local', 'user.name', account.username);
        const email = account.email || `${account.username}@${host}`;
        await gitConfig(repoPath, '--local', 'user.email', email);

        // 2. If we have a token, configure the remote URL to embed credentials
        //    so git (and VS Code SCM) authenticates transparently.
        if (token) {
            await applyTokenToRemote(repoPath, account.username, token, host);
        }

        console.log(`[Ultraview] Applied local git identity: ${account.username} (${host}) in ${repoPath}`);
    } catch (err: any) {
        console.warn('[Ultraview] Could not apply local git config:', err?.message);
    }
}



/**
 * Remove local git account overrides for a repo (reset to default).
 * Called when local account is unset.
 */
export async function clearLocalAccount(repoPath: string): Promise<void> {
    try {
        await gitConfigUnset(repoPath, '--local', 'user.name');
        await gitConfigUnset(repoPath, '--local', 'user.email');
        // Restore remote URL to a non-credentialed form
        await restoreRemoteUrl(repoPath);
        console.log('[Ultraview] Cleared local git identity in', repoPath);
    } catch (err: any) {
        console.warn('[Ultraview] Could not clear local git config:', err?.message);
    }
}

/**
 * Embed the token into the 'origin' remote URL so git authenticates automatically.
 * e.g. https://github.com/org/repo  →  https://Da3n0n:ghp_xxx@github.com/org/repo
 */
async function applyTokenToRemote(
    repoPath: string,
    username: string,
    token: string,
    host: string
): Promise<void> {
    try {
        const { stdout } = await execAsync('git remote get-url origin', { cwd: repoPath });
        const current = stdout.trim();

        // Only rewrite HTTPS remotes (not SSH)
        if (!current.startsWith('https://')) return;

        // Strip any existing credentials from the URL first
        const stripped = current.replace(/https:\/\/[^@]+@/, 'https://');

        // Inject new credentials
        const credentialed = stripped.replace('https://', `https://${username}:${token}@`);
        await execAsync(`git remote set-url origin "${credentialed}"`, { cwd: repoPath });
    } catch (err: any) {
        console.warn('[Ultraview] Could not update remote URL with credentials:', err?.message);
    }
}

/**
 * Strip embedded credentials from the origin remote URL.
 */
async function restoreRemoteUrl(repoPath: string): Promise<void> {
    try {
        const { stdout } = await execAsync('git remote get-url origin', { cwd: repoPath });
        const current = stdout.trim();
        if (current.includes('@')) {
            const cleaned = current.replace(/https:\/\/[^@]+@/, 'https://');
            await execAsync(`git remote set-url origin "${cleaned}"`, { cwd: repoPath });
        }
    } catch {
        // no remote, fine
    }
}

/**
 * Get the current remote URL for a repo (with credentials stripped for display).
 */
export async function getRemoteUrl(repoPath: string): Promise<string | undefined> {
    try {
        const { stdout } = await execAsync('git remote get-url origin', { cwd: repoPath });
        const url = stdout.trim();
        // Strip credentials before returning for display
        return url.replace(/https:\/\/[^@]+@/, 'https://');
    } catch {
        return undefined;
    }
}
