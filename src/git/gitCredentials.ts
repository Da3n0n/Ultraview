import { execFile } from 'child_process';
import { GitAccount } from './types';

/**
 * Per-project git credentials without plaintext tokens.
 *
 * Tokens never go into `.git/config` or a command line. Each project gets:
 *   - remote URL `https://<username>@host/owner/repo.git` (username only, not secret)
 *   - its token in the operating system's credential store (Windows Credential Manager /
 *     macOS Keychain / libsecret), keyed to that repository's path, via `git credential approve`
 *   - a repo-local credential helper list that uses only that secure store (so a global
 *     plaintext `store` helper can never receive the token)
 * VS Code Source Control and terminal git then authenticate automatically, per project.
 */

const SECURE_HELPERS = ['manager', 'manager-core', 'wincred', 'osxkeychain', 'libsecret'];

interface GitResult {
    stdout: string;
    stderr: string;
}

/** Runs git with arguments (no shell) and optional stdin. Never put secrets in `args`. */
function git(cwd: string, args: string[], input?: string): Promise<GitResult> {
    return new Promise((resolve, reject) => {
        const child = execFile(
            'git',
            args,
            { cwd, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' }, timeout: 20000, windowsHide: true },
            (error, stdout, stderr) => {
                if (error) {
                    (error as any).stderr = stderr;
                    reject(error);
                } else {
                    resolve({ stdout: String(stdout), stderr: String(stderr) });
                }
            }
        );
        if (input !== undefined) child.stdin?.end(input);
    });
}

async function gitConfigUnset(cwd: string, key: string): Promise<void> {
    try {
        await git(cwd, ['config', '--local', '--unset-all', key]);
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

/** `https://user:secret@host/path` → parts; null for non-HTTPS remotes. */
function parseRemote(url: string): { host: string; path: string; user?: string; secret?: string } | null {
    const m = url.match(/^https:\/\/(?:([^:@/]+)(?::([^@/]*))?@)?([^/]+)\/(.+)$/);
    if (!m) return null;
    return {
        user: m[1] ? decodeURIComponent(m[1]) : undefined,
        secret: m[2] ? decodeURIComponent(m[2]) : undefined,
        host: m[3],
        path: m[4],
    };
}

/** Removes any `user[:secret]@` from an HTTPS URL (for display and for safe storage). */
export function stripCredentials(url: string): string {
    return url.replace(/^https:\/\/[^@/]+@/, 'https://');
}

/** `https://host/path` with only the (non-secret) username, so the right stored login is used. */
export function withUsername(url: string, username: string): string {
    return stripCredentials(url).replace(/^https:\/\//, `https://${encodeURIComponent(username)}@`);
}

/** The secure helper this repo should use: the first one already configured, else the platform's. */
async function secureHelper(cwd: string): Promise<string> {
    let configured: string[] = [];
    try {
        const { stdout } = await git(cwd, ['config', '--get-all', 'credential.helper']);
        configured = stdout.split(/\r?\n/).map((h) => h.trim()).filter(Boolean);
    } catch {
        // none configured
    }
    const secure = configured.find((h) => SECURE_HELPERS.some((name) => h === name || h.endsWith(`credential-${name}`) || h.endsWith(`/${name}`)));
    if (secure) return secure;
    if (process.platform === 'win32') return 'wincred';
    if (process.platform === 'darwin') return 'osxkeychain';
    return 'libsecret';
}

function credentialRequest(host: string, path: string, username: string, password?: string): string {
    const lines = ['protocol=https', `host=${host}`, `path=${path}`, `username=${username}`];
    if (password !== undefined) lines.push(`password=${password}`);
    return `${lines.join('\n')}\n\n`;
}

/**
 * Store `token` for this repository in the OS credential store and point the remote at it.
 * Returns false if the store could not be confirmed (the remote is still left token-free).
 */
async function storeRepoCredential(repoPath: string, username: string, token: string): Promise<boolean> {
    const { stdout } = await git(repoPath, ['remote', 'get-url', 'origin']);
    const remote = parseRemote(stdout.trim());
    if (!remote) return true; // SSH or other transport: nothing to do

    // Only this repo's settings change: a secure helper alone (the empty entry resets inherited
    // helpers such as a plaintext `store`), credentials keyed by repository path.
    const helper = await secureHelper(repoPath);
    await git(repoPath, ['config', '--local', '--replace-all', 'credential.helper', '']);
    await git(repoPath, ['config', '--local', '--add', 'credential.helper', helper]);
    await git(repoPath, ['config', '--local', 'credential.useHttpPath', 'true']);

    await git(repoPath, ['credential', 'approve'], credentialRequest(remote.host, remote.path, username, token));
    await git(repoPath, ['remote', 'set-url', 'origin', withUsername(stdout.trim(), username)]);

    // Confirm git can read it back (without printing it anywhere).
    try {
        const filled = await git(repoPath, ['credential', 'fill'], credentialRequest(remote.host, remote.path, username));
        return filled.stdout.split(/\r?\n/).includes(`password=${token}`);
    } catch {
        return false;
    }
}

/**
 * If the origin URL still carries a token (written by older Ultraview versions), move it into
 * the OS credential store and clean the URL. Safe to call on every project, any time.
 */
export async function migratePlaintextRemote(repoPath: string): Promise<boolean> {
    try {
        const { stdout } = await git(repoPath, ['remote', 'get-url', 'origin']);
        const remote = parseRemote(stdout.trim());
        if (!remote?.secret) return false;
        const username = remote.user || 'x-access-token';
        const stored = await storeRepoCredential(repoPath, username, remote.secret);
        if (!stored) {
            // Never leave the token in plaintext, even if the store is unavailable.
            await git(repoPath, ['remote', 'set-url', 'origin', withUsername(stdout.trim(), username)]);
        }
        console.log(`[Ultraview] Moved an embedded git token out of ${repoPath}/.git/config`);
        return true;
    } catch (err: any) {
        console.warn('[Ultraview] Could not migrate remote credentials:', err?.message);
        return false;
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
        await git(repoPath, ['config', '--local', 'user.name', account.username]);
        const noReplyHost = account.provider === 'github' ? 'users.noreply.github.com'
            : account.provider === 'gitlab' ? 'users.noreply.gitlab.com'
            : host;
        const noReplyPrefix = account.providerUserId
            ? `${account.providerUserId}+${account.username}`
            : account.username;
        const email = account.email || `${noReplyPrefix}@${noReplyHost}`;
        await git(repoPath, ['config', '--local', 'user.email', email]);

        // 2. Credentials: OS credential store for this repo, token-free remote URL.
        if (token) {
            const stored = await storeRepoCredential(repoPath, account.username, token);
            if (!stored) {
                console.warn('[Ultraview] The OS credential store did not keep the token; VS Code may ask to sign in.');
            }
        } else {
            await migratePlaintextRemote(repoPath);
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
        let remoteUrl = '';
        try {
            remoteUrl = (await git(repoPath, ['remote', 'get-url', 'origin'])).stdout.trim();
        } catch {
            // no remote
        }
        const remote = parseRemote(remoteUrl);
        if (remote?.user) {
            // Forget this repo's stored login.
            try {
                await git(repoPath, ['credential', 'reject'], credentialRequest(remote.host, remote.path, remote.user));
            } catch {
                // nothing stored
            }
        }
        await gitConfigUnset(repoPath, 'user.name');
        await gitConfigUnset(repoPath, 'user.email');
        await gitConfigUnset(repoPath, 'credential.helper');
        await gitConfigUnset(repoPath, 'credential.useHttpPath');
        if (remoteUrl.startsWith('https://') && remoteUrl.includes('@')) {
            await git(repoPath, ['remote', 'set-url', 'origin', stripCredentials(remoteUrl)]);
        }
        console.log('[Ultraview] Cleared local git identity in', repoPath);
    } catch (err: any) {
        console.warn('[Ultraview] Could not clear local git config:', err?.message);
    }
}

/**
 * Get the current remote URL for a repo (with credentials stripped for display).
 */
export async function getRemoteUrl(repoPath: string): Promise<string | undefined> {
    try {
        const { stdout } = await git(repoPath, ['remote', 'get-url', 'origin']);
        return stripCredentials(stdout.trim());
    } catch {
        return undefined;
    }
}
