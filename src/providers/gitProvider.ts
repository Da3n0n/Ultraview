import * as vscode from 'vscode';
import * as childProcess from 'child_process';
import * as util from 'util';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { buildGitHtml } from '../git/gitUi';
import { GitProjects } from '../git/gitProjects';
import { GitAccounts } from '../git/gitAccounts';
import { GitAccount, GitProfile, GitProvider as GitProviderType, AuthMethod } from '../git/types';
import { applyLocalAccount, clearLocalAccount, getRemoteUrl } from '../git/gitCredentials';
import { SharedStore } from '../sync/sharedStore';
import { getS3Credentials } from '../s3backup/s3BackupSettings';
import { ProjectCommand, scanCommands } from '../commands/commandScanner';
import { createCommandTerminal } from '../utils/commandTerminal';
import { vendorRepositories } from '../git/vendorRepositories';

interface GitStatus {
    isGitRepo: boolean;
    localChanges: number; // uncommitted + staged
    ahead: number; // commits ahead of remote
    behind: number; // commits behind remote
    branch: string;
}

type GitConflictStrategy = 'ours' | 'theirs';
type GitCommandRunner = (cmd: string) => Promise<{ stdout: string; stderr: string }>;
interface GitAuthContext {
    host: string;
    username: string;
    token: string;
}
const projectGitOpLocks = new Set<string>();
const legacyRewriteCheckedProjects = new Set<string>();

function projectLockKey(projectPath: string): string {
    const resolved = path.resolve(projectPath);
    return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

async function runExclusiveProjectGitOp<T>(projectPath: string, op: () => Promise<T>): Promise<T> {
    const key = projectLockKey(projectPath);
    if (projectGitOpLocks.has(key)) {
        throw new Error('A git operation is already running for this project. Please wait.');
    }
    projectGitOpLocks.add(key);
    let releaseDiskLock: (() => void) | undefined;
    try {
        releaseDiskLock = await acquireProjectGitLock(projectPath);
        return await op();
    } finally {
        releaseDiskLock?.();
        projectGitOpLocks.delete(key);
    }
}

async function acquireProjectGitLock(projectPath: string): Promise<() => void> {
    const gitEntry = path.join(projectPath, '.git');
    if (!fs.existsSync(gitEntry) || !fs.statSync(gitEntry).isDirectory()) {
        return () => undefined;
    }

    const lockPath = path.join(gitEntry, 'ultraview-sync.lock');
    const deadline = Date.now() + 5_000;
    while (true) {
        try {
            const handle = fs.openSync(lockPath, 'wx');
            fs.writeFileSync(handle, JSON.stringify({ pid: process.pid, startedAt: Date.now() }), 'utf8');
            fs.closeSync(handle);
            return () => {
                try { fs.unlinkSync(lockPath); } catch { /* already released */ }
            };
        } catch (err: any) {
            if (err?.code !== 'EEXIST') throw err;
            try {
                const lockData = JSON.parse(fs.readFileSync(lockPath, 'utf8')) as {
                    pid?: number;
                    startedAt?: number;
                };
                const age = Date.now() - fs.statSync(lockPath).mtimeMs;
                const ownerPid = Number(lockData.pid);
                // Extension-host reloads can leave a lock owned by this same
                // process after the in-memory operation set has been reset.
                // A closed/crashed IDE leaves a PID that no longer exists.
                if (ownerPid === process.pid || !isProcessRunning(ownerPid) || age > 10 * 60_000) {
                    fs.unlinkSync(lockPath);
                    continue;
                }
            } catch (lockErr: any) {
                // If the lock vanished, retry immediately. Invalid partial lock
                // files are safe to recover once they are no longer brand new.
                if (lockErr?.code === 'ENOENT') continue;
                try {
                    if (Date.now() - fs.statSync(lockPath).mtimeMs > 5_000) {
                        fs.unlinkSync(lockPath);
                        continue;
                    }
                } catch { continue; }
            }
            if (Date.now() >= deadline) {
                throw new Error('Another running IDE is actively syncing this project. Try again in a moment.');
            }
            await new Promise((resolve) => setTimeout(resolve, 250));
        }
    }
}

function isProcessRunning(pid: number): boolean {
    if (!Number.isInteger(pid) || pid <= 0) return false;
    try {
        process.kill(pid, 0);
        return true;
    } catch (err: any) {
        // EPERM means the process exists but belongs to another security context.
        return err?.code === 'EPERM';
    }
}

function notifyGitOpDone(webview: vscode.Webview | undefined, projectId: string): void {
    webview?.postMessage({ type: 'gitOpDone', projectId });
}

async function showProjectCommandPicker(projectPath: string, projectName: string): Promise<void> {
    if (!fs.existsSync(projectPath) || !fs.statSync(projectPath).isDirectory()) {
        vscode.window.showErrorMessage(`Project folder not found: ${projectPath}`);
        return;
    }

    const commands = await scanCommands(projectPath);
    if (!commands.length) {
        vscode.window.showInformationMessage(`No runnable commands found for ${projectName}.`);
        return;
    }

    const picked = await vscode.window.showQuickPick(
        commands.map((command) => ({
            label: `$(terminal) ${command.runCmd}`,
            description: getRelativeCommandCwd(projectPath, command.cwd),
            detail: command.description || command.displayName,
            command,
        })),
        {
            placeHolder: `Run a command from ${projectName}`,
            matchOnDescription: true,
            matchOnDetail: true,
        }
    );

    if (!picked) {
        return;
    }

    await runScannedCommandInTerminal(picked.command);
}

async function runScannedCommandInTerminal(command: ProjectCommand): Promise<void> {
    await createCommandTerminal(getScannedCommandTerminalName(command), command.cwd, command.runCmd);
}

function getScannedCommandTerminalName(command: ProjectCommand): string {
    const dirLabel = path.basename(command.cwd) || command.folderLabel || command.workspaceLabel;
    const commandLabel = command.name || command.runCmd;
    return `${dirLabel} / ${commandLabel}`.slice(0, 80);
}

function getRelativeCommandCwd(projectPath: string, commandCwd: string): string {
    const relativePath = path.relative(projectPath, commandCwd);
    return relativePath ? relativePath.split(path.sep).join('/') : '.';
}

/**
 * Split a "git <subcommand> [args...]" string into an args array suitable for
 * execFile, handling double- and single-quoted segments so quoted paths with
 * spaces are passed as a single argument without the quotes.
 */
function parseGitArgs(cmd: string): string[] {
    const rest = cmd.startsWith('git ') ? cmd.slice(4) : cmd;
    const args: string[] = [];
    let current = '';
    let inQuote = false;
    let quoteChar = '';
    for (const ch of rest) {
        if (inQuote) {
            if (ch === quoteChar) {
                inQuote = false;
            } else {
                current += ch;
            }
        } else if (ch === '"' || ch === "'") {
            inQuote = true;
            quoteChar = ch;
        } else if (ch === ' ') {
            if (current) {
                args.push(current);
                current = '';
            }
        } else {
            current += ch;
        }
    }
    if (current) args.push(current);
    return args;
}

/**
 * Creates a git command runner that uses execFile (no shell) to avoid the
 * Windows cmd.exe command-line length limit (8191 chars). Arguments are
 * passed directly to the git process, which is also safer against injection.
 */
function authContextFromAccount(account?: GitAccount): GitAuthContext | undefined {
    if (!account?.token || account.authMethod === 'ssh') return undefined;
    const host = account.provider === 'github'
        ? 'github.com'
        : account.provider === 'gitlab'
            ? 'gitlab.com'
            : 'dev.azure.com';
    return { host, username: account.username, token: account.token };
}

function createGitRunner(
    projectPath: string,
    timeout: number = 30000,
    auth?: GitAuthContext
): GitCommandRunner {
    return (cmd: string) =>
        new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
            const env: NodeJS.ProcessEnv = { ...process.env };
            if (auth) {
                // Pass the selected Project Manager account ephemerally to Git
                // and all recursive submodule child processes. Host scoping
                // prevents a GitHub token, for example, being sent to a GitLab
                // submodule. Nothing is written to .gitmodules or child config.
                const configIndex = Number.parseInt(env.GIT_CONFIG_COUNT ?? '0', 10) || 0;
                const basic = Buffer.from(`${auth.username}:${auth.token}`).toString('base64');
                env.GIT_CONFIG_COUNT = String(configIndex + 1);
                env[`GIT_CONFIG_KEY_${configIndex}`] = `http.https://${auth.host}/.extraHeader`;
                env[`GIT_CONFIG_VALUE_${configIndex}`] = `Authorization: Basic ${basic}`;
                env.GIT_TERMINAL_PROMPT = '0';
            }
            childProcess.execFile(
                'git',
                parseGitArgs(cmd),
                { cwd: projectPath, env, timeout, maxBuffer: 10 * 1024 * 1024 },
                (error, stdout, stderr) => {
                    const out = Buffer.isBuffer(stdout) ? stdout.toString('utf8') : (stdout ?? '');
                    const err = Buffer.isBuffer(stderr) ? stderr.toString('utf8') : (stderr ?? '');
                    if (error) {
                        const e = error as any;
                        e.stdout = out;
                        e.stderr = err;
                        reject(e);
                    } else {
                        resolve({ stdout: out, stderr: err });
                    }
                }
            );
        });
}

function trimGitOutput(stdout?: string, stderr?: string): string {
    return stdout?.trim() || stderr?.trim() || '';
}

function formatGitError(err: any): string {
    return err?.stderr?.trim() || err?.stdout?.trim() || err?.message || 'Git command failed';
}

function strategyLabel(strategy: GitConflictStrategy): 'local' | 'remote' {
    return strategy === 'ours' ? 'local' : 'remote';
}

/** Remove a stale index.lock file so git commands are not blocked. */
function clearIndexLock(projectPath: string): void {
    const lockFile = path.join(projectPath, '.git', 'index.lock');
    try {
        if (fs.existsSync(lockFile) && Date.now() - fs.statSync(lockFile).mtimeMs > 2 * 60_000) {
            fs.unlinkSync(lockFile);
        }
    } catch {
        /* ignore – lock may be legitimately held */
    }
}

/**
 * Detects the GitHub/GitLab "This repository moved" redirect hint that the
 * server prints on stderr (e.g. when an org renames a repo, or transfers it
 * to a new owner). Returns the new location URL if found, else undefined.
 *
 * Example stderr:
 *   remote: This repository moved. Please use the new location:
 *   remote:   https://github.com/Vizualflow/UnrealSync.git
 */
function parseMovedRepository(stderr: string): string | undefined {
    if (!stderr) return undefined;
    const m = stderr.match(/remote:\s*(?:This repository moved|Please use the new location)[\s\S]*?remote:\s*(\S+github\.com[^\s]+|\S+gitlab\.com[^\s]+|git@[^\s]+)/i);
    if (m && m[1]) return m[1].trim().replace(/\.git$/, '.git');
    // Fallback: any github.com / gitlab.com URL in the redirect block
    const m2 = stderr.match(/remote:\s*((?:https:\/\/(?:github\.com|gitlab\.com)\/[^\s]+|git@[^\s]+))/i);
    if (m2 && m2[1]) return m2[1].trim();
    return undefined;
}

/**
 * Updates the 'origin' remote URL to a new location. Re-embeds any credentials
 * that were on the existing origin URL so auth continues to work after the
 * redirect. Returns the new URL (without credentials) for display purposes.
 */
async function rewriteOriginRemote(
    projectPath: string,
    newUrl: string,
    run: GitCommandRunner
): Promise<string> {
    // Preserve any embedded credentials from the existing origin URL
    let credentialedNew = newUrl;
    try {
        const { stdout } = await run('git remote get-url origin');
        const current = stdout.trim();
        const credMatch = current.match(/^https:\/\/([^@\/:]+):([^@]+)@/);
        if (credMatch && newUrl.startsWith('https://')) {
            credentialedNew = newUrl.replace(
                'https://',
                `https://${credMatch[1]}:${credMatch[2]}@`
            );
        }
    } catch {
        /* no existing origin / no credentials — push as-is */
    }
    await run(`git remote set-url origin "${credentialedNew.replace(/"/g, '\\"')}"`);
    return newUrl;
}

/**
 * Detects transient network/server errors that should be retried with backoff.
 * These are NOT user errors (auth, scope, branch protection) — they're
 * momentary blips from the remote side or local connectivity.
 */
function isTransientGitError(stderr: string, message: string): boolean {
    const text = `${stderr || ''}\n${message || ''}`.toLowerCase();
    if (!text) return false;
    if (/internal server error|500|502|503|504|service unavailable|bad gateway|gateway timeout/.test(text)) return true;
    if (/connection (reset|refused|aborted|closed|dropped)/.test(text)) return true;
    if (/timed? ?out|timeout/.test(text) && !/stream timeout/i.test(text)) return true;
    if (/could not resolve host|temporary failure in name resolution/.test(text)) return true;
    if (/tls|ssl|econnreset|eai_again|enetunreach|enotfound/.test(text)) return true;
    if (/the remote end hung up unexpectedly/.test(text)) return true;
    if (/rpc failed/.test(text) && !/git-receive-pack not permitted/i.test(text)) return true;
    if (/empty reply from server/.test(text)) return true;
    if (/refused_stream|stream error.*refused|http2.*transport.*cannot retry/.test(text)) return true;
    return false;
}

function isLfsLockVerificationError(value: string): boolean {
    return /git lfs locking api|lfs.*locks\/verify|locksverify/i.test(value)
        && /does not support|refused_stream|stream error|transport.*cannot retry|failed to verify/i.test(value);
}

/**
 * Git LFS recommends disabling lock verification when a remote cannot provide
 * the optional locking endpoint. Scope the setting to the remote host and the
 * current repository; never copy credentials from the remote URL into config.
 */
async function disableUnsupportedLfsLockVerification(run: GitCommandRunner): Promise<string | undefined> {
    try {
        const { stdout } = await run('git remote get-url origin');
        const rawUrl = stdout.trim();
        let host: string | undefined;
        if (/^https?:\/\//i.test(rawUrl)) {
            host = new URL(rawUrl).hostname;
        } else {
            const sshMatch = rawUrl.match(/^[^@]+@([^:]+):/);
            host = sshMatch?.[1];
        }
        if (!host || !/^[a-z0-9.-]+$/i.test(host)) return undefined;
        await run(`git config --local lfs.https://${host}/.locksverify false`);
        return host;
    } catch {
        return undefined;
    }
}

/**
 * Wraps a git operation with up to 3 retries on transient errors. Uses
 * exponential backoff (500ms, 1s, 2s). Non-transient errors propagate
 * immediately so the caller can run real recovery (e.g. workflow scope fix).
 */
async function withTransientRetry<T>(
    op: () => Promise<T>,
    label: string,
    maxAttempts: number = 3
): Promise<T> {
    let lastErr: any;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        try {
            return await op();
        } catch (err: any) {
            lastErr = err;
            const stderr = err?.stderr ?? err?.message ?? '';
            if (!isTransientGitError(stderr, err?.message ?? '')) {
                throw err;
            }
            if (attempt >= maxAttempts) break;
            const delayMs = 500 * Math.pow(2, attempt - 1);
            await new Promise((r) => setTimeout(r, delayMs));
        }
    }
    throw lastErr;
}

/** Write commit message to a temp file and return its path. */
function writeCommitMsgFile(msg: string): string {
    const tmpFile = path.join(os.tmpdir(), `uv-commit-${Date.now()}.txt`);
    fs.writeFileSync(tmpFile, msg, 'utf8');
    return tmpFile;
}

async function hasStagedChanges(run: GitCommandRunner): Promise<boolean> {
    try {
        await run('git diff --cached --quiet');
        return false;
    } catch {
        return true;
    }
}

/**
 * Stage everything possible without allowing one unreadable/invalid vendor file
 * to block all other changes from being committed.
 */
async function stageChangesBestEffort(run: GitCommandRunner, projectPath: string): Promise<boolean> {
    try {
        await run("git add -A -- . :(exclude).git-rewrite/**");
    } catch (err: any) {
        if (/index\.lock|another git process/i.test(err?.stderr ?? err?.message ?? '')) {
            clearIndexLock(projectPath);
            try {
                await run("git add -A -- . :(exclude).git-rewrite/**");
            } catch {
                await tryGit(run, "git add --ignore-errors -A -- . :(exclude).git-rewrite/**");
            }
        } else {
            await tryGit(run, "git add --ignore-errors -A -- . :(exclude).git-rewrite/**");
        }
    }

    return hasStagedChanges(run);
}

/**
 * Removes scratch files produced by the old workflow-history rewrite code.
 * Those files live in the worktree, so a concurrent `git add -A` used to
 * commit them and then report hundreds of new changes while filter-branch ran.
 */
async function removeLegacyRewriteArtifacts(
    projectPath: string,
    run: GitCommandRunner
): Promise<boolean> {
    const projectKey = projectLockKey(projectPath);
    if (legacyRewriteCheckedProjects.has(projectKey)) return false;
    let changed = false;
    const rewriteDir = path.resolve(projectPath, '.git-rewrite');
    if (path.dirname(rewriteDir) !== path.resolve(projectPath)) {
        throw new Error('Refusing to clean an invalid .git-rewrite path.');
    }

    try {
        const { stdout } = await run('git ls-files .git-rewrite');
        if (stdout.trim()) {
            await run('git rm -r --cached --ignore-unmatch -- .git-rewrite');
            changed = true;
        }
    } catch {
        // The directory may only be untracked; it is still safe to remove.
    }

    try {
        if (fs.existsSync(rewriteDir)) {
            fs.rmSync(rewriteDir, { recursive: true, force: true });
            changed = true;
        }
    } catch (err: any) {
        throw new Error(`Could not remove stale .git-rewrite data: ${err?.message ?? String(err)}`);
    }

    // Keep Git's own exclude local to this clone; do not add tool internals to
    // the shared project .gitignore on every repository.
    try {
        const { stdout } = await run('git rev-parse --git-path info/exclude');
        const rawExcludePath = stdout.trim();
        const excludePath = path.isAbsolute(rawExcludePath)
            ? rawExcludePath
            : path.resolve(projectPath, rawExcludePath);
        let content = '';
        try { content = fs.readFileSync(excludePath, 'utf8'); } catch { /* create below */ }
        if (!/^\.git-rewrite\/$/m.test(content)) {
            fs.mkdirSync(path.dirname(excludePath), { recursive: true });
            const separator = content && !content.endsWith('\n') ? '\n' : '';
            fs.appendFileSync(excludePath, `${separator}.git-rewrite/\n`, 'utf8');
        }
    } catch { /* staging also excludes it explicitly */ }

    // Undo only the exact ignore block written by the former recovery path.
    // User-authored workflow ignore rules are left untouched.
    const gitignorePath = path.join(projectPath, '.gitignore');
    try {
        const content = fs.readFileSync(gitignorePath, 'utf8');
        const next = content.replace(
            /(?:^|\r?\n)# Auto-ignored: GitHub OAuth token lacks workflow scope\r?\n\.github\/workflows\/\r?\n?/,
            '\n'
        );
        if (next !== content) {
            fs.writeFileSync(gitignorePath, next.replace(/^\n/, ''), 'utf8');
            changed = true;
        }
    } catch { /* no legacy ignore block */ }

    legacyRewriteCheckedProjects.add(projectKey);
    return changed;
}

async function commitStagedChanges(run: GitCommandRunner, tmpFile: string): Promise<void> {
    const commitFile = `"${tmpFile.replace(/\\/g, '/')}"`;
    try {
        // Sync is unattended: avoid editor/signing prompts and hooks that can
        // hold the button indefinitely. The same bypass was already used as
        // the fallback, so make the reliable path the fast path.
        await run(`git -c commit.gpgSign=false commit --no-verify -F ${commitFile}`);
    } catch (err: any) {
        // Hooks and local signing settings should not prevent Ultraview from
        // syncing otherwise valid staged files.
        try {
            await run(`git -c commit.gpgSign=false commit --no-verify -F ${commitFile}`);
        } catch (retryErr: any) {
            if (!(await hasStagedChanges(run))) {
                return;
            }
            throw new Error(formatGitError(retryErr) || formatGitError(err));
        }
    }
}

async function listUnmergedFiles(run: GitCommandRunner): Promise<string[]> {
    try {
        const { stdout } = await run('git diff --name-only --diff-filter=U');
        return stdout
            .split(/\r?\n/)
            .map((line) => line.trim())
            .filter(Boolean);
    } catch {
        return [];
    }
}

async function tryGit(run: GitCommandRunner, cmd: string): Promise<boolean> {
    try {
        await run(cmd);
        return true;
    } catch {
        return false;
    }
}

async function createSafetyBranch(
    run: GitCommandRunner,
    prefix: string
): Promise<string | undefined> {
    const stamp = new Date()
        .toISOString()
        .replace(/[-:.TZ]/g, '')
        .slice(0, 14);
    const branchName = `ultraview-${prefix}-${stamp}`;
    try {
        await run(`git branch ${branchName} HEAD`);
        return branchName;
    } catch {
        return undefined;
    }
}

async function recoverInterruptedGitState(
    projectPath: string,
    strategy: GitConflictStrategy
): Promise<string[]> {
    const run = createGitRunner(projectPath);
    const notes: string[] = [];

    let gitDir = path.join(projectPath, '.git');
    try {
        const { stdout } = await run('git rev-parse --git-dir');
        gitDir = path.resolve(projectPath, stdout.trim());
    } catch { /* use normal .git location */ }

    const abortSteps: Array<{ label: string; cmd: string; markers: string[] }> = [
        { label: 'merge', cmd: 'git merge --abort', markers: ['MERGE_HEAD'] },
        { label: 'rebase', cmd: 'git rebase --abort', markers: ['rebase-merge', 'rebase-apply'] },
        { label: 'cherry-pick', cmd: 'git cherry-pick --abort', markers: ['CHERRY_PICK_HEAD'] },
        { label: 'revert', cmd: 'git revert --abort', markers: ['REVERT_HEAD'] },
    ];

    for (const step of abortSteps) {
        if (!step.markers.some((marker) => fs.existsSync(path.join(gitDir, marker)))) continue;
        if (await tryGit(run, step.cmd)) {
            notes.push(`aborted stale ${step.label}`);
        }
    }

    const unmerged = await listUnmergedFiles(run);
    if (!unmerged.length) {
        return notes;
    }

    const backupBranch = await createSafetyBranch(run, 'recovery');
    await run(`git checkout --${strategy} -- .`);
    await run('git add -A');

    const remaining = await listUnmergedFiles(run);
    if (remaining.length) {
        throw new Error(`Repository still has unmerged files: ${remaining.join(', ')}`);
    }

    notes.push(
        `resolved ${unmerged.length} stale conflicted file(s) using ${strategyLabel(strategy)} changes${backupBranch ? ` (backup: ${backupBranch})` : ''}`
    );

    return notes;
}

async function mergeRemoteBranch(
    projectPath: string,
    branch: string,
    strategy: GitConflictStrategy,
    alreadyFetched = false,
    auth?: GitAuthContext
): Promise<string[]> {
    const run = createGitRunner(projectPath, 30000, auth);
    const notes: string[] = [];

    // Fetch with auto-redirect on "Repository moved" (up to 3 attempts).
    // Sync's direction check has already fetched, so do not repeat that
    // network round trip on its normal behind/diverged path.
    for (let attempt = 1; !alreadyFetched && attempt <= 3; attempt++) {
        try {
            await withTransientRetry(
                () => run(`git fetch --quiet origin ${branch}`),
                'fetch'
            );
            break;
        } catch (fetchErr: any) {
            const stderr = fetchErr?.stderr ?? '';
            const moved = parseMovedRepository(stderr);
            if (moved) {
                const newUrl = await rewriteOriginRemote(projectPath, moved, run);
                console.log(`[Ultraview] origin redirected to ${newUrl} during fetch`);
                continue;
            }
            // Also catch non-stderr message form (some git builds put it in stdout)
            const movedStdout = parseMovedRepository(fetchErr?.stdout ?? '');
            if (movedStdout) {
                const newUrl = await rewriteOriginRemote(projectPath, movedStdout, run);
                console.log(`[Ultraview] origin redirected to ${newUrl} during fetch`);
                continue;
            }
            throw fetchErr;
        }
    }

    try {
        // Start with Git's normal three-way merge. `-X ours/theirs` would make
        // the command succeed by silently dropping the other machine's side of
        // every conflicting hunk, which is the opposite of a two-way sync.
        const { stdout, stderr } = await run(`git merge --no-edit origin/${branch}`);
        const output = trimGitOutput(stdout, stderr);
        if (output && !/^already up to date\.?$/i.test(output)) {
            notes.push(output);
        }
        return notes;
    } catch (err: any) {
        const unmerged = await listUnmergedFiles(run);
        if (!unmerged.length) {
            throw new Error(formatGitError(err));
        }

        const backupBranch = await createSafetyBranch(run, 'merge-backup');
        for (const relativePath of unmerged) {
            await resolveConflictPreservingBoth(projectPath, run, relativePath, strategy);
        }
        await stageChangesBestEffort(run, projectPath);

        const remaining = await listUnmergedFiles(run);
        if (remaining.length) {
            throw new Error(
                `Repository still has unmerged files after auto-resolution: ${remaining.join(', ')}`
            );
        }

        await run('git commit --no-edit');
        notes.push(
            `preserved both sides of ${unmerged.length} conflicted file(s)${backupBranch ? ` (backup: ${backupBranch})` : ''}`
        );
        return notes;
    }
}

function combineConflictMarkers(content: string): { content: string; resolved: boolean } {
    let resolved = false;
    const combined = content.replace(
        /^<<<<<<<[^\r\n]*\r?\n([\s\S]*?)^=======\r?\n([\s\S]*?)^>>>>>>>[^\r\n]*(?:\r?\n|$)/gm,
        (_match, local: string, remote: string) => {
            resolved = true;
            if (local === remote) return local;
            const separator = local.endsWith('\n') || remote.startsWith('\n') ? '' : '\n';
            return `${local}${separator}${remote}`;
        }
    );
    return { content: combined, resolved };
}

async function resolveConflictPreservingBoth(
    projectPath: string,
    run: GitCommandRunner,
    relativePath: string,
    fallbackStrategy: GitConflictStrategy
): Promise<void> {
    const quotedPath = `"${relativePath.replace(/"/g, '\\"')}"`;
    const absolutePath = path.resolve(projectPath, relativePath);
    const projectRoot = path.resolve(projectPath) + path.sep;
    if (!absolutePath.startsWith(projectRoot)) {
        throw new Error(`Refusing to resolve a conflict outside the project: ${relativePath}`);
    }

    // Gitlinks are commit pointers, not files. Trying to combine/copy them as
    // ordinary conflicts can corrupt the index or throw EISDIR. Resolve the
    // common case automatically when one pointer is an ancestor of the other;
    // a genuinely divergent vendor history is rare and must be surfaced rather
    // than silently discarding either dependency update.
    try {
        const { stdout: unmergedOut } = await run(`git ls-files -u -- ${quotedPath}`);
        const gitlinkStages = unmergedOut
            .replace(/\r/g, '')
            .split('\n')
            .map((line) => line.match(/^160000\s+([0-9a-f]+)\s+([123])\t/i))
            .filter((match): match is RegExpMatchArray => !!match);
        if (gitlinkStages.length) {
            const ours = gitlinkStages.find((match) => match[2] === '2')?.[1];
            const theirs = gitlinkStages.find((match) => match[2] === '3')?.[1];
            if (!ours || !theirs) {
                throw new Error(`Incomplete submodule pointer conflict for ${relativePath}`);
            }

            const subRun = createGitRunner(absolutePath, 30000);
            await tryGit(subRun, 'git fetch --quiet --prune origin');
            await tryGit(subRun, `git fetch --quiet origin ${ours}`);
            await tryGit(subRun, `git fetch --quiet origin ${theirs}`);

            let chosen: string | undefined;
            if (await tryGit(subRun, `git merge-base --is-ancestor ${ours} ${theirs}`)) {
                chosen = theirs;
            } else if (await tryGit(subRun, `git merge-base --is-ancestor ${theirs} ${ours}`)) {
                chosen = ours;
            }

            if (!chosen) {
                throw new Error(
                    `Submodule "${relativePath}" changed to two divergent commits (${ours.slice(0, 8)} and ${theirs.slice(0, 8)}). ` +
                    'Ultraview left the merge unresolved so neither vendor update is lost.'
                );
            }

            await run(`git update-index --add --cacheinfo 160000 ${chosen} ${quotedPath}`);
            await run(`git submodule update --init --recursive --checkout -- ${quotedPath}`);
            return;
        }
    } catch (err: any) {
        if (/Submodule |Incomplete submodule/.test(err?.message ?? '')) throw err;
        // Not a gitlink conflict; continue through the normal file resolver.
    }

    await tryGit(run, `git checkout --conflict=merge -- ${quotedPath}`);
    if (fs.existsSync(absolutePath) && fs.statSync(absolutePath).isFile()) {
        const buffer = fs.readFileSync(absolutePath);
        if (!buffer.includes(0)) {
            const result = combineConflictMarkers(buffer.toString('utf8'));
            if (result.resolved) {
                fs.writeFileSync(absolutePath, result.content, 'utf8');
                await run(`git add -- ${quotedPath}`);
                return;
            }
        }
    }

    // Binary and modify/delete conflicts cannot be meaningfully combined as
    // text. Keep the preferred copy at its original path and preserve the
    // other copy next to it, so neither machine's data is discarded.
    const otherStrategy = fallbackStrategy === 'ours' ? 'theirs' : 'ours';
    const suffix = otherStrategy === 'theirs' ? 'remote' : 'local';
    const preservedPath = `${absolutePath}.ultraview-${suffix}-conflict`;
    if (await tryGit(run, `git checkout --${otherStrategy} -- ${quotedPath}`)) {
        if (fs.existsSync(absolutePath)) {
            fs.copyFileSync(absolutePath, preservedPath);
        }
    }
    if (!(await tryGit(run, `git checkout --${fallbackStrategy} -- ${quotedPath}`))) {
        // Preferred side deleted the file: keep the surviving copy at the
        // canonical path as well as the explicitly named conflict copy.
        if (fs.existsSync(preservedPath)) {
            fs.copyFileSync(preservedPath, absolutePath);
        }
    }
    await run(`git add -A -- ${quotedPath} "${path.relative(projectPath, preservedPath).replace(/"/g, '\\"')}"`);
}

/**
 * Fast local-only status check (no network fetch). Returns branch + local changes.
 * Carries forward ahead/behind from a previous full check so buttons stay visible.
 */
async function getProjectLocalStatus(
    projectPath: string,
    prevStatus?: GitStatus
): Promise<GitStatus> {
    const empty: GitStatus = { isGitRepo: false, localChanges: 0, ahead: 0, behind: 0, branch: '' };
    const run = createGitRunner(projectPath, 5000);

    try {
        // One porcelain call both verifies the repository and returns its
        // branch plus working-tree changes. This replaces three Git process
        // launches per project on every panel refresh.
        const { stdout } = await run('git --no-optional-locks status --porcelain=v1 --branch');
        const lines = stdout.replace(/\r/g, '').split('\n').filter(Boolean);
        const header = lines[0]?.startsWith('## ') ? lines[0].slice(3) : '';
        let branch = header.split('...')[0];
        if (branch.startsWith('No commits yet on ')) branch = branch.slice('No commits yet on '.length);
        if (branch === 'HEAD (no branch)' || branch.startsWith('HEAD ')) branch = '';

        return {
            isGitRepo: true,
            localChanges: lines.slice(header ? 1 : 0).length,
            ahead: prevStatus?.ahead ?? 0,
            behind: prevStatus?.behind ?? 0,
            branch: branch || prevStatus?.branch || '',
        };
    } catch {
        return empty;
    }
}

const remoteStatusJobs = new Map<string, Promise<GitStatus>>();
let activeRemoteStatusJobs = 0;
const remoteStatusWaiters: Array<() => void> = [];

async function getProjectGitStatus(projectPath: string, localStatus?: GitStatus): Promise<GitStatus> {
    const key = path.resolve(projectPath);
    const existing = remoteStatusJobs.get(key);
    if (existing) return existing;
    const slot = new Promise<void>(resolve => {
        if (activeRemoteStatusJobs < 2) { activeRemoteStatusJobs++; resolve(); }
        else remoteStatusWaiters.push(resolve);
    });
    const pending = slot.then(async () => {
        const run = createGitRunner(projectPath, 8000);
        const status = localStatus
            ? { ...localStatus }
            : await getProjectLocalStatus(projectPath);
        if (!status.isGitRepo) return status;
        status.ahead = 0;
        status.behind = 0;

        // Fetch (with redirect-on-moved + transient retry) so the ahead/behind
        // badge reflects the *real* remote state and never gets stuck on stale
        // local refs. Quiet on success; soft-fail on outage so the badge still
        // shows whatever the last good fetch recorded.
        for (let attempt = 1; attempt <= 3; attempt++) {
            try {
                await withTransientRetry(
                    () => run('git fetch --quiet --prune --tags origin'),
                    'status-fetch'
                );
                break;
            } catch (fetchErr: any) {
                const stderr = fetchErr?.stderr ?? '';
                const stdout = fetchErr?.stdout ?? '';
                const moved = parseMovedRepository(stderr) || parseMovedRepository(stdout);
                if (moved) {
                    await rewriteOriginRemote(projectPath, moved, run);
                    continue;
                }
                break;
            }
        }

        try {
            const { stdout: revOut } = await run(
                'git rev-list --left-right --count HEAD...@{upstream}'
            );
            const parts = revOut.trim().split(/\s+/);
            status.ahead = parseInt(parts[0], 10) || 0;
            status.behind = parseInt(parts[1], 10) || 0;
        } catch {
            // No upstream configured — try origin/<branch> directly
            if (status.branch) {
                try {
                    const { stdout: revOut } = await run(
                        `git rev-list --left-right --count HEAD...origin/${status.branch}`
                    );
                    const parts = revOut.trim().split(/\s+/);
                    status.ahead = parseInt(parts[0], 10) || 0;
                    status.behind = parseInt(parts[1], 10) || 0;
                } catch {
                    /* no remote branch */
                }
            }
        }

        return status;
    }).finally(() => {
        remoteStatusJobs.delete(key);
        const next = remoteStatusWaiters.shift();
        if (next) next();
        else activeRemoteStatusJobs--;
    });
    remoteStatusJobs.set(key, pending);
    return pending;
}

async function getCurrentBranch(projectPath: string): Promise<string> {
    const run = createGitRunner(projectPath, 8000);
    try {
        const { stdout } = await run('git branch --show-current');
        const branch = stdout.trim();
        if (branch) {
            return branch;
        }
    } catch {
        /* detached HEAD */
    }
    // If HEAD is detached, prefer the configured upstream branch for this commit.
    try {
        const { stdout } = await run('git rev-parse --abbrev-ref --symbolic-full-name @{upstream}');
        const upstreamRef = stdout.trim(); // e.g. origin/master
        const match = upstreamRef.match(/^[^/]+\/(.+)$/);
        if (match && match[1]) {
            return match[1];
        }
    } catch {
        /* no upstream */
    }
    // Fallback: check what remote HEAD points to
    try {
        const { stdout } = await run('git symbolic-ref refs/remotes/origin/HEAD');
        const ref = stdout.trim(); // e.g. refs/remotes/origin/main
        return ref.replace(/^refs\/remotes\/origin\//, '');
    } catch {
        /* ignore */
    }

    // If local origin/HEAD is unavailable, ask the remote directly.
    try {
        const { stdout } = await run('git ls-remote --symref origin HEAD');
        const match = stdout.match(/ref:\s+refs\/heads\/([^\s]+)\s+HEAD/);
        if (match && match[1]) {
            return match[1];
        }
    } catch {
        /* ignore */
    }

    // Final fallback: prefer whichever common default branch actually exists.
    for (const fallback of ['main', 'master']) {
        try {
            await run(`git show-ref --verify --quiet refs/remotes/origin/${fallback}`);
            return fallback;
        } catch {
            /* try next */
        }
    }

    return 'main'; // absolute last-resort default
}

/**
 * Detects whether HEAD is detached. If it is, figures out the correct branch
 * (upstream → origin/HEAD → ls-remote → local branch check → 'main') and
 * checks it out automatically so subsequent git operations work normally.
 *
 * Always returns the resolved branch name. Never throws.
 */
async function resolveOrAttachHead(projectPath: string, auth?: GitAuthContext): Promise<string> {
    const run = createGitRunner(projectPath, 8000, auth);

    // Fast path: already on a named branch
    try {
        const { stdout } = await run('git branch --show-current');
        const branch = stdout.trim();
        if (branch) return branch;
    } catch { /* detached or error — fall through */ }

    // HEAD is detached — resolve the best target branch
    let targetBranch = 'main';

    // 1. Upstream of current detached HEAD
    try {
        const { stdout } = await run('git rev-parse --abbrev-ref --symbolic-full-name @{upstream}');
        const match = stdout.trim().match(/^[^/]+\/(.+)$/);
        if (match?.[1]) targetBranch = match[1];
    } catch { /* no upstream */ }

    if (targetBranch === 'main') {
        // 2. Local origin/HEAD symref
        try {
            const { stdout } = await run('git symbolic-ref refs/remotes/origin/HEAD');
            const ref = stdout.trim().replace(/^refs\/remotes\/origin\//, '');
            if (ref) targetBranch = ref;
        } catch { /* ignore */ }
    }

    if (targetBranch === 'main') {
        // 3. Ask remote directly (requires network)
        try {
            const { stdout } = await run('git ls-remote --symref origin HEAD');
            const match = stdout.match(/ref:\s+refs\/heads\/([^\s]+)\s+HEAD/);
            if (match?.[1]) targetBranch = match[1];
        } catch { /* offline or no remote */ }
    }

    if (targetBranch === 'main') {
        // 4. Check whether master or main actually exists locally or on remote
        for (const candidate of ['main', 'master']) {
            let found = false;
            try {
                await run(`git show-ref --verify --quiet refs/remotes/origin/${candidate}`);
                found = true;
            } catch { /* try local */ }
            if (!found) {
                try {
                    await run(`git show-ref --verify --quiet refs/heads/${candidate}`);
                    found = true;
                } catch { /* try next */ }
            }
            if (found) { targetBranch = candidate; break; }
        }
    }

    // Checkout — create the local branch tracking origin if it doesn't exist yet
    try {
        await run(`git checkout ${targetBranch}`);
    } catch {
        try {
            await run(`git checkout -b ${targetBranch} origin/${targetBranch}`);
        } catch { /* best effort — carry on regardless */ }
    }

    return targetBranch;
}

/**
 * Returns true if the repo has at least one configured remote.
 */
async function hasRemote(projectPath: string): Promise<boolean> {
    const run = createGitRunner(projectPath, 5000);
    try {
        const { stdout } = await run('git remote');
        return stdout.trim().length > 0;
    } catch {
        return false;
    }
}

async function gitPull(projectPath: string): Promise<string> {
    const notes = await recoverInterruptedGitState(projectPath, 'theirs');
    const branch = await getCurrentBranch(projectPath);

    try {
        const committed = await gitCommitLocal(projectPath);
        if (committed) {
            notes.push('committed local changes before pull');
        }

        notes.push(...(await mergeRemoteBranch(projectPath, branch, 'theirs')));
        return notes.length ? notes.join(' | ') : 'Pull complete';
    } catch (err: any) {
        throw new Error(formatGitError(err));
    }
}

async function gitCommitLocal(projectPath: string, commitMsg?: string): Promise<boolean> {
    // Clear any stale index lock before starting
    clearIndexLock(projectPath);

    const run = createGitRunner(projectPath);

    let statusOut: string;
    try {
        const result = await run('git status --porcelain');
        statusOut = result.stdout;
    } catch (err: any) {
        // If index.lock caused the failure, clear it and retry once
        if (/index\.lock|another git process/i.test(err?.stderr ?? err?.message ?? '')) {
            clearIndexLock(projectPath);
            const result = await run('git status --porcelain');
            statusOut = result.stdout;
        } else {
            throw err;
        }
    }

    if (!statusOut.trim()) {
        return false;
    }

    // Extract filenames for commit message (always include them)
    const files = statusOut
        .trim()
        .split('\n')
        .map((line) => {
            // git status --porcelain: first 2 chars are status, then space, then filename
            // Handle renamed files: " R  oldname → newname"
            const match = line.match(/^\s*[A-Z?]{1,2} (.+)$/i);
            return match ? match[1].trim() : '';
        })
        .filter(Boolean);
    if (files.length === 0) {
        return false;
    }

    let msg = commitMsg;
    if (!msg) {
        msg =
            `Update ${files.length} file${files.length !== 1 ? 's' : ''}:\n` +
            files.map((f) => `- ${f}`).join('\n');
    } else {
        // Append filenames even when custom message is provided
        msg = `${msg}\n\nFiles changed:\n` + files.map((f) => `- ${f}`).join('\n');
    }

    // A dirty nested/vendor repo or an invalid file can appear in status but
    // still be impossible to stage. Commit the valid files and leave the rest.
    if (!(await stageChangesBestEffort(run, projectPath))) {
        return false;
    }

    // Write commit message to a temp file to avoid shell-escaping issues with
    // multi-line messages on Windows
    const tmpFile = writeCommitMsgFile(msg);
    try {
        await commitStagedChanges(run, tmpFile);
    } finally {
        try { fs.unlinkSync(tmpFile); } catch { /* ignore */ }
    }

    return true;
}

/**
 * Detects a push failure caused by a GitHub OAuth token that lacks the
 * `workflow` scope, and recovers so the push can never trip the server-side
 * scope check again — regardless of how many commits ahead the local
 * branch is, and across every future sync.
 *
 * The recovery is permanent and self-healing. It is intentionally
 * aggressive because the only way to push WITHOUT a workflow-scoped token
 * is to make sure no commit being pushed ever contains a workflow file —
 * past, present, or future:
 *   1. Add `.github/workflows/` to the local `.gitignore` so `git add -A`
 *      (used by the extension's auto-commit) never re-stages the workflow
 *      file in any future commit. This is the critical fix — without it,
 *      every subsequent sync would re-commit the orphaned file and the
 *      push would fail again in a poison-pill loop.
 *   2. Amend the last commit to drop the workflow file from HEAD (cheap).
 *   3. Rewrite ALL branches' history with `git filter-branch --index-filter
 *      --all` so the workflow file is stripped from every commit being
 *      pushed — not just HEAD, since the server checks every new commit
 *      for workflow changes. `--all` ensures other local branches are
 *      clean too, so they can't reintroduce the file later.
 *   4. Verify the file is GONE from every commit reachable from any
 *      local ref. If it's still there, fall back to creating an orphan
 *      branch with a single squashed commit (which guarantees no
 *      workflow file in history) and force-push that.
 *   5. Push with `--force-with-lease` because history was rewritten
 *      (commit hashes changed). Lease guards against concurrent pushes
 *      that may have landed since the last fetch.
 *   6. Clean up `filter-branch`'s backup refs and run aggressive gc so
 *      no orphan workflow blob survives in the object store.
 *
 * Local workflow files on disk are DELETED (not just untracked) after
 * recovery — otherwise the next manual `git add .` from the user would
 * re-stage them and we'd be back in the same loop.
 *
 * Returns `true` if recovery was applied (caller should force-push),
 * `false` if no workflow files exist on disk, aren't tracked, and aren't
 * in history — meaning the original error was a real auth issue and the
 * caller should fall back to the re-authenticate prompt.
 */
async function recoverFromWorkflowScope(
    projectPath: string,
    run: GitCommandRunner
): Promise<boolean> {
    // Rewriting a shared branch is not a sync operation. It changes commit
    // identities for every machine and the old implementation also generated
    // a stageable `.git-rewrite` directory in the project. Keep the legacy
    // implementation unreachable unless a developer explicitly opts into it
    // for a one-off manual recovery.
    if (process.env.ULTRAVIEW_ALLOW_DESTRUCTIVE_WORKFLOW_REWRITE !== '1') {
        throw new Error(
            "GitHub rejected a workflow-file change because this credential lacks workflow permission. Add a GitHub PAT with repository and workflow access; Ultraview will not rewrite shared history or delete workflow files."
        );
    }

    const wfDir = path.join(projectPath, '.github', 'workflows');
    const wfSlash = '.github/workflows/';

    // Any workflow files on disk, tracked, or in history (any ref)?
    const hasOnDisk = fs.existsSync(wfDir);
    let hasTracked = false;
    let inHistoryAnyRef = false;
    let inHistoryHead = false;
    try {
        const { stdout } = await run('git ls-files .github/workflows/');
        hasTracked = stdout.trim().length > 0;
    } catch { /* assume none */ }
    try {
        const { stdout } = await run('git log --oneline -- .github/workflows/');
        inHistoryHead = stdout.trim().length > 0;
    } catch { /* assume none */ }
    try {
        // Check ALL refs (branches + tags) — filter-branch --all will rewrite
        // them all, so we need to know if ANY of them contain the file.
        const { stdout } = await run('git log --oneline --all -- .github/workflows/');
        inHistoryAnyRef = stdout.trim().length > 0;
    } catch { /* assume none */ }

    if (!hasOnDisk && !hasTracked && !inHistoryAnyRef && !inHistoryHead) return false;

    console.log(`[Ultraview] workflow-scope recovery: disk=${hasOnDisk} tracked=${hasTracked} headHist=${inHistoryHead} allHist=${inHistoryAnyRef}`);

    // Step 1: add `.github/workflows/` to .gitignore so the extension's
    // `git add -A` (and any manual `git add .`) never re-stages the file.
    // This is the permanent fix that breaks the poison-pill loop. The entry
    // is idempotent — we only append if it's not already present in any
    // common spelling.
    try {
        const giPath = path.join(projectPath, '.gitignore');
        let giContent = '';
        try { giContent = fs.readFileSync(giPath, 'utf8'); } catch { /* no .gitignore yet */ }
        const hasEntry = /^[ \t]*\.github[\\\/]workflows[\\\/]?[ \t]*$/m.test(giContent)
            || /^[ \t]*\.github[\\\/]workflows[ \t]*$/m.test(giContent);
        if (!hasEntry) {
            const sep = giContent && !giContent.endsWith('\n') ? '\n' : '';
            const addition =
                `${sep}# Auto-ignored: GitHub OAuth token lacks workflow scope\n` +
                `.github/workflows/\n`;
            fs.writeFileSync(giPath, giContent + addition, 'utf8');
        }
    } catch { /* best-effort — still try history rewrite below */ }

    // Step 2: cheap amend for the single-commit case. Runs BEFORE the
    // history rewrite so HEAD is already clean when filter-branch walks it.
    try {
        await run(`git rm -r --cached --ignore-unmatch ${wfSlash}`);
        await run('git commit --amend --no-edit');
    } catch { /* no-op when there's nothing to amend */ }

    // Step 3: rewrite ALL branches' history. Required because the workflow
    // file may be in any ancestor commit on any branch, and the server
    // rejects any push containing a workflow change.
    const filterRun = createGitRunner(projectPath, 300000); // 5 min
    let filterSucceeded = false;
    try {
        await filterRun(
            'git filter-branch -f --index-filter ' +
            `"git rm -rf --cached --ignore-unmatch ${wfSlash}" -- --all`
        );
        filterSucceeded = true;
    } catch (fbErr: any) {
        console.warn(`[Ultraview] filter-branch --all failed: ${fbErr?.stderr ?? fbErr?.message}`);
        // Fall back to HEAD-only rewrite
        try {
            await filterRun(
                'git filter-branch -f --index-filter ' +
                `"git rm -rf --cached --ignore-unmatch ${wfSlash}" HEAD`
            );
            filterSucceeded = true;
        } catch (fbErr2: any) {
            console.warn(`[Ultraview] filter-branch HEAD fallback also failed: ${fbErr2?.stderr ?? fbErr2?.message}`);
        }
    }

    // Step 3b: if filter-branch still left the file in some ref, nuke
    // those branches too. A single leftover branch with the file would
    // still get rejected on push.
    if (filterSucceeded) {
        try {
            const { stdout: stillHas } = await run('git log --oneline --all -- .github/workflows/');
            if (stillHas.trim().length > 0) {
                console.log('[Ultraview] filter-branch left workflows in some refs — deleting them');
                // Delete the refs that still contain workflow files
                const { stdout: refsOut } = await run('git log --all --pretty=format:%H -- .github/workflows/');
                // This is best-effort; if we can't clean, fall through to orphan fallback below.
            }
        } catch { /* ignore */ }
    }

    // Step 4: VERIFY the file is gone. If filter-branch couldn't do it,
    // fall back to creating an orphan branch with a single clean commit
    // and reset the current branch to it. This is the nuclear option but
    // it always works.
    let needsOrphanFallback = false;
    try {
        const { stdout: verifyOut } = await run('git log --oneline HEAD -- .github/workflows/');
        if (verifyOut.trim().length > 0) {
            needsOrphanFallback = true;
        }
    } catch { /* assume clean */ }

    if (needsOrphanFallback) {
        console.log('[Ultraview] filter-branch did not fully remove workflows — using reset fallback');
        try {
            // Save the current branch and parent
            const { stdout: branchOut } = await run('git rev-parse --abbrev-ref HEAD');
            const currentBranch = branchOut.trim() || 'main';
            // Find the first parent of HEAD (the commit BEFORE the workflow
            // was added, if such a commit exists). We rewrite HEAD so that
            // its tree matches the parent's tree but with our current
            // uncommitted changes re-applied.
            const { stdout: parentOut } = await run('git rev-parse HEAD~1');
            const parent = parentOut.trim();
            if (parent) {
                // Reset to the parent (soft, keeps index/working tree),
                // then remove workflows from index, then re-commit.
                await run(`git reset --soft ${parent}`);
                await run(`git rm -r --cached --ignore-unmatch ${wfSlash}`);
                // Stage any other pending changes and commit
                await run('git add -A');
                await run('git commit --no-edit -m "Sync commit"');
            } else {
                // HEAD has no parent (initial commit with workflows).
                // Delete the workflows from the working tree and the index
                // and recommit as a single clean commit.
                if (fs.existsSync(wfDir)) {
                    const wfFiles = fs.readdirSync(wfDir);
                    for (const f of wfFiles) {
                        try { fs.unlinkSync(path.join(wfDir, f)); } catch { /* ignore */ }
                    }
                }
                await run(`git rm -r --cached --ignore-unmatch ${wfSlash}`);
                await run('git add -A');
                await run('git commit --amend --no-edit');
            }
        } catch (orphanErr: any) {
            console.error(`[Ultraview] reset fallback failed: ${orphanErr?.stderr ?? orphanErr?.message}`);
            return false;
        }
    }

    // Step 5: delete the workflow files from the working tree. They
    // are now ignored by .gitignore so they won't be re-staged, but
    // leaving them on disk invites the user to re-add them later.
    try {
        if (fs.existsSync(wfDir)) {
            // Delete the files but keep the .github directory if it
            // contains other things (e.g. ISSUE_TEMPLATE).
            const wfFiles = fs.readdirSync(wfDir);
            for (const f of wfFiles) {
                try { fs.unlinkSync(path.join(wfDir, f)); } catch { /* ignore */ }
            }
            try { fs.rmdirSync(wfDir); } catch { /* dir may not be empty */ }
        }
    } catch { /* best-effort */ }

    // Step 6: clean up backup refs and gc.
    try {
        const { stdout: refsOut } = await filterRun('git for-each-ref --format=%(refname) refs/original/');
        const refs = refsOut.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
        for (const ref of refs) {
            await filterRun(`git update-ref -d "${ref}"`);
        }
    } catch { /* nothing to clean */ }
    try { await filterRun('git reflog expire --expire=now --all'); } catch { /* ignore */ }
    try { await filterRun('git gc --prune=now --aggressive'); } catch { /* ignore */ }

    // Final verification — if the file is STILL in any commit reachable
    // from HEAD after all our efforts, recovery failed. Bail so the
    // caller can surface a clear error.
    try {
        const { stdout: finalCheck } = await run('git log --oneline HEAD -- .github/workflows/');
        if (finalCheck.trim().length > 0) {
            console.error('[Ultraview] workflow recovery FAILED — file still in HEAD history');
            return false;
        }
    } catch { /* assume clean */ }

    console.log('[Ultraview] workflow-scope recovery succeeded');
    return true;
}

async function gitPush(projectPath: string, commitMsg?: string): Promise<string> {
    const run = createGitRunner(projectPath);
    const branch = await getCurrentBranch(projectPath);
    await gitCommitLocal(projectPath, commitMsg);

    // Try up to 4 times. Each iteration can either:
    //   1. Succeed (push lands)
    //   2. Hit a transient error → withTransientRetry retries with backoff
    //   3. Hit "Repository moved" → we rewrite origin and the next loop iteration
    //      uses the new URL automatically
    //   4. Hit "workflow scope" → we strip .github/workflows and force-push
    //   5. Anything else → propagate after exhausting redirects
    let lastErr: any;
    let workflowFilesExcluded = false;
    let redirectedFrom: string | undefined;
    let lfsLocksDisabledFor: string | undefined;
    for (let attempt = 1; attempt <= 4; attempt++) {
        try {
            const { stdout, stderr } = await withTransientRetry(
                () => run(`git push -u origin ${branch}`),
                'push'
            );
            const base = trimGitOutput(stdout, stderr) || 'Push complete';
            const parts: string[] = [];
            if (redirectedFrom) parts.push(`remote was at ${redirectedFrom}, now using ${(await getRemoteUrl(projectPath)) ?? 'new URL'}`);
            if (workflowFilesExcluded) parts.push('.github/workflows excluded from all history (token lacks workflow scope; re-authenticate to push them)');
            if (lfsLocksDisabledFor) parts.push(`Git LFS lock verification disabled for ${lfsLocksDisabledFor}`);
            return parts.length ? `${base} — ${parts.join(' | ')}` : base;
        } catch (err: any) {
            lastErr = err;
            const errMsg = formatGitError(err);
            const stderr = err?.stderr ?? '';
            const stdout = err?.stdout ?? '';

            // 1. Repository moved → update origin, retry on next iteration
            const moved = parseMovedRepository(stderr) || parseMovedRepository(stdout);
            if (moved) {
                if (!redirectedFrom) {
                    try {
                        redirectedFrom = (await run('git remote get-url origin')).stdout.trim();
                    } catch { /* ignore */ }
                }
                const newUrl = await rewriteOriginRemote(projectPath, moved, run);
                console.log(`[Ultraview] origin redirected to ${newUrl}`);
                continue;
            }

            // Git LFS can abort an otherwise valid push when its optional lock
            // endpoint is unsupported or repeatedly fails at the HTTP/2 layer.
            // Transient retries have already been exhausted by this point.
            if (!lfsLocksDisabledFor && isLfsLockVerificationError(errMsg)) {
                lfsLocksDisabledFor = await disableUnsupportedLfsLockVerification(run);
                if (lfsLocksDisabledFor) continue;
            }

            // 2. Workflow scope → strip .github/workflows and force-push
            if (/workflow/i.test(errMsg) && /scope/i.test(errMsg)) {
                if (await recoverFromWorkflowScope(projectPath, run)) {
                    workflowFilesExcluded = true;
                    try {
                        const { stdout, stderr } = await withTransientRetry(
                            () => run(`git push --force-with-lease -u origin ${branch}`),
                            'push-force'
                        );
                        const base = trimGitOutput(stdout, stderr) || 'Push complete';
                        return `${base} — .github/workflows excluded from all history (token lacks workflow scope; re-authenticate to push them)`;
                    } catch (retryErr: any) {
                        // If the post-recovery push hits "moved" (e.g. a
                        // redirect that we hadn't seen yet), loop back to
                        // the top so the redirect handler can fix origin
                        // first and then we push again.
                        const rStderr = retryErr?.stderr ?? '';
                        const rStdout = retryErr?.stdout ?? '';
                        if (parseMovedRepository(rStderr) || parseMovedRepository(rStdout)) {
                            lastErr = retryErr;
                            continue;
                        }
                        throw retryErr;
                    }
                }
            }

            // 3. Any other error → bail out
            throw new Error(errMsg);
        }
    }
    // Should not reach here, but if we do, surface the last error
    throw new Error(formatGitError(lastErr) || 'Push failed after retries');
}

interface SyncResult {
    status: 'fast-forward' | 'merged' | 'nothing-to-do' | 'pushed' | 'recovered';
    message: string;
}

async function getSyncDirection(
    projectPath: string,
    auth?: GitAuthContext
): Promise<{ ahead: number; behind: number; diverged: boolean }> {
    const run = createGitRunner(projectPath, 10000, auth);

    // Fetch with auto-redirect on "Repository moved" so a stale local origin
    // never blocks the status check (and so the badge reflects the real
    // remote state, not whatever the local ref cache remembers).
    for (let attempt = 1; attempt <= 3; attempt++) {
        try {
            await withTransientRetry(
                () => run('git fetch --quiet --prune --tags origin'),
                'fetch',
                2
            );
            break;
        } catch (fetchErr: any) {
            const stderr = fetchErr?.stderr ?? '';
            const stdout = fetchErr?.stdout ?? '';
            const moved = parseMovedRepository(stderr) || parseMovedRepository(stdout);
            if (moved) {
                await rewriteOriginRemote(projectPath, moved, run);
                continue;
            }
            // Soft-fail: keep going with whatever refs we already have so a
            // temporary outage doesn't blank the badge.
            break;
        }
    }

    try {
        const { stdout } = await run('git rev-list --left-right --count HEAD...@{upstream}');
        const parts = stdout.trim().split(/\s+/);
        const ahead = parseInt(parts[0], 10) || 0;
        const behind = parseInt(parts[1], 10) || 0;
        return { ahead, behind, diverged: ahead > 0 && behind > 0 };
    } catch {
        // No upstream - try origin/<branch>
        const branch = await getCurrentBranch(projectPath);
        try {
            const { stdout } = await run(
                `git rev-list --left-right --count HEAD...origin/${branch}`
            );
            const parts = stdout.trim().split(/\s+/);
            const ahead = parseInt(parts[0], 10) || 0;
            const behind = parseInt(parts[1], 10) || 0;
            return { ahead, behind, diverged: ahead > 0 && behind > 0 };
        } catch {
            return { ahead: 0, behind: 0, diverged: false };
        }
    }
}

interface SubmoduleStatusEntry {
    absolutePath: string;
    relativePath: string;
    state: 'clean' | 'different' | 'uninitialized' | 'conflicted';
}

/** Parse `git submodule status --recursive` without discarding its state prefix. */
function parseSubmoduleStatus(projectPath: string, stdout: string): SubmoduleStatusEntry[] {
    const entries: SubmoduleStatusEntry[] = [];
    for (const rawLine of stdout.replace(/\r/g, '').split('\n')) {
        if (!rawLine.trim()) continue;
        // Format: [ +-U]<sha1> <relative-path> [(<describe>)]
        const match = rawLine.match(/^([ +\-U])?[0-9a-f]+\s+(.+?)(?:\s+\([^)]+\))?\s*$/i);
        if (!match) continue;
        const prefix = match[1] || ' ';
        const relativePath = match[2];
        const state: SubmoduleStatusEntry['state'] = prefix === '-'
            ? 'uninitialized'
            : prefix === '+'
                ? 'different'
                : prefix === 'U'
                    ? 'conflicted'
                    : 'clean';
        entries.push({
            absolutePath: path.resolve(projectPath, relativePath),
            relativePath,
            state,
        });
    }
    return entries;
}

async function getSubmoduleEntries(projectPath: string): Promise<SubmoduleStatusEntry[]> {
    if (!fs.existsSync(path.join(projectPath, '.gitmodules'))) return [];
    const run = createGitRunner(projectPath, 20000);
    const { stdout } = await run('git submodule status --recursive');
    return parseSubmoduleStatus(projectPath, stdout);
}

/**
 * Synchronise .gitmodules URLs and initialise only missing checkouts. Existing
 * submodule worktrees are deliberately left alone so a normal Sync can never
 * discard an edited or locally advanced checkout before it has been saved.
 */
async function initialiseMissingSubmodules(
    projectPath: string,
    auth?: GitAuthContext
): Promise<SubmoduleStatusEntry[]> {
    if (!fs.existsSync(path.join(projectPath, '.gitmodules'))) return [];
    const run = createGitRunner(projectPath, 120000, auth);
    await run('git submodule sync --recursive');

    let entries = await getSubmoduleEntries(projectPath);
    for (const entry of entries.filter((item) => item.state === 'uninitialized')) {
        const relativePath = entry.relativePath.replace(/\\/g, '/');
        try {
            await run(`git submodule update --init --recursive --checkout -- "${relativePath}"`);
        } catch (err: any) {
            throw new Error(
                `Could not initialise submodule "${entry.relativePath}": ${formatGitError(err)}`
            );
        }
    }

    entries = await getSubmoduleEntries(projectPath);
    const unavailable = entries.filter(
        (item) => item.state === 'uninitialized' || item.state === 'conflicted'
    );
    if (unavailable.length) {
        throw new Error(
            `Submodule checkout needs attention: ${unavailable.map((item) => item.relativePath).join(', ')}`
        );
    }
    return entries;
}

function pathDepth(value: string): number {
    return path.resolve(value).split(path.sep).length;
}

function findImmediateSubmoduleParent(
    projectPath: string,
    childPath: string,
    allSubmodulePaths: string[]
): { parentPath: string; relativePath: string } {
    const child = path.resolve(childPath);
    const parent = allSubmodulePaths
        .map((candidate) => path.resolve(candidate))
        .filter((candidate) => candidate !== child && child.startsWith(candidate + path.sep))
        .sort((left, right) => right.length - left.length)[0] ?? path.resolve(projectPath);
    return { parentPath: parent, relativePath: path.relative(parent, child) };
}

async function getRecordedGitlink(parentPath: string, relativePath: string): Promise<string | undefined> {
    const run = createGitRunner(parentPath, 5000);
    try {
        const quotedPath = `"${relativePath.replace(/\\/g, '/').replace(/"/g, '\\"')}"`;
        const { stdout } = await run(`git ls-tree HEAD -- ${quotedPath}`);
        const match = stdout.match(/^160000\s+commit\s+([0-9a-f]+)/i);
        return match?.[1];
    } catch {
        return undefined;
    }
}

async function isWorkingTreeDirty(repoPath: string): Promise<boolean> {
    const run = createGitRunner(repoPath, 5000);
    const { stdout } = await run('git status --porcelain');
    return stdout.trim().length > 0;
}

async function getHeadCommit(repoPath: string): Promise<string> {
    const { stdout } = await createGitRunner(repoPath, 5000)('git rev-parse HEAD');
    return stdout.trim();
}

async function isHeadPublished(repoPath: string, auth?: GitAuthContext): Promise<boolean> {
    const run = createGitRunner(repoPath, 20000, auth);
    try {
        await withTransientRetry(() => run('git fetch --quiet --prune origin'), 'submodule-fetch', 2);
    } catch {
        // The normal sync below will surface authentication/network failures if
        // the commit actually needs to be pushed.
    }
    try {
        const { stdout } = await run('git branch -r --contains HEAD');
        return stdout.trim().length > 0;
    } catch {
        return false;
    }
}

async function ensureSubmoduleHasBranch(repoPath: string): Promise<string> {
    const run = createGitRunner(repoPath, 10000);
    const { stdout } = await run('git branch --show-current');
    const existing = stdout.trim();
    if (existing) return existing;

    // A checked-out submodule is normally detached. If it was edited, preserve
    // that exact base commit on a new branch instead of silently jumping to the
    // remote default branch and losing the user's chosen pointer.
    const stamp = new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14);
    const branchName = `ultraview-sync-${stamp}`;
    await run(`git checkout -b ${branchName} HEAD`);
    return branchName;
}

/**
 * Quickly checks whether a directory is a git repository root.
 */
async function isGitRepo(dirPath: string): Promise<boolean> {
    const run = createGitRunner(dirPath, 5000);
    try {
        await run('git rev-parse --is-inside-work-tree');
        return true;
    } catch {
        return false;
    }
}

/**
 * Sync a single git repo. Never throws on recoverable conditions.
 *
 * @param projectPath  Absolute path to the repo root.
 * @param commitMsg    Optional commit message prefix.
 * @param remoteUrl    If provided and no remote is configured, this URL is
 *                     added as `origin` automatically before syncing.
 *                     If omitted and no remote exists, throws { code: 'NO_REMOTE' }.
 *
 * Handles automatically:
 *  - Detached HEAD             → reattaches to correct branch (resolveOrAttachHead)
 *  - Stale index.lock          → cleared before any operation
 *  - Interrupted merge/rebase  → aborted & recovered first
 *  - No remote (with remoteUrl)→ remote added silently, then synced
 *  - No remote (no remoteUrl)  → throws { code: 'NO_REMOTE' } for caller to handle
 *  - Diverged history          → local-wins merge (-X ours) + aggressive fallback
 *  - Push rejected             → pull-then-retry once
 *  - Push fails for other reason → retried after re-pull; throws if still failing
 *  - Offline / temp network err→ push errors surfaced so caller can notify user
 */
async function gitSync(
    projectPath: string,
    commitMsg?: string,
    remoteUrl?: string,
    auth?: GitAuthContext
): Promise<string> {
    // ── sanity checks ────────────────────────────────────────────────────────
    clearIndexLock(projectPath);
    if (!(await isGitRepo(projectPath))) return 'Sync complete';

    const run = createGitRunner(projectPath, 30000, auth);

    // Self-heal repositories affected by the former filter-branch recovery
    // before status is counted or local changes are committed.
    await removeLegacyRewriteArtifacts(projectPath, run);

    // ── auto-reattach detached HEAD ──────────────────────────────────────────
    const branch = await resolveOrAttachHead(projectPath, auth);

    // ── recover from interrupted git state ──────────────────────────────────
    await recoverInterruptedGitState(projectPath, 'ours');

    // ── commit local changes ─────────────────────────────────────────────────
    const committed = await gitCommitLocal(projectPath, commitMsg);

    // ── ensure a remote exists ───────────────────────────────────────────────
    const remoteExists = await hasRemote(projectPath);
    if (!remoteExists) {
        if (remoteUrl) {
            // Auto-add the remote from the stored project repoUrl
            await run(`git remote add origin "${remoteUrl.replace(/"/g, '')}"`);
        } else {
            // Caller must prompt the user — never silently commit-only
            throw { code: 'NO_REMOTE' };
        }
    }

    // ── fetch + compute divergence ───────────────────────────────────────────
    let ahead = 0;
    let behind = 0;
    let diverged = false;
    let workflowFilesExcluded = false;
    try {
        const dir = await getSyncDirection(projectPath, auth);
        ahead = dir.ahead;
        behind = dir.behind;
        diverged = dir.diverged;
    } catch {
        // getSyncDirection already swallows most errors; if it still throws
        // (e.g. no remote branch yet after adding a fresh remote) carry on
        // — we'll just push below.
    }

    // ── merge remote changes if needed ──────────────────────────────────────
    if (diverged || behind > 0) {
        await mergeRemoteBranch(projectPath, branch, 'ours', true, auth);
    }

    // ── push ─────────────────────────────────────────────────────────────────
    // Robust push loop that handles, in order:
    //   1. "Repository moved" → update origin, retry
    //   2. Transient errors  → withTransientRetry handles backoff
    //   3. "non-fast-forward"→ pull + retry (one pass)
    //   4. "workflow scope"   → strip .github/workflows + force-push
    //   5. Anything else     → bubble up after exhausting redirects/recoveries
    let pushAttempts = 0;
    let pushDone = false;
    let lastPushErr: any;
    let redirectedDuringPush = false;
    let lfsLocksDisabledFor: string | undefined;
    while (!pushDone && pushAttempts < 4) {
        pushAttempts++;
        try {
            await withTransientRetry(
                () => run(`git push -u origin ${branch}`),
                'sync-push',
                2
            );
            pushDone = true;
        } catch (pushErr: any) {
            lastPushErr = pushErr;
            const stderr = pushErr?.stderr ?? '';
            const stdout = pushErr?.stdout ?? '';
            const errMsg = formatGitError(pushErr);

            // 1. Repository moved → fix origin, loop and retry push
            const moved = parseMovedRepository(stderr) || parseMovedRepository(stdout);
            if (moved) {
                const newUrl = await rewriteOriginRemote(projectPath, moved, run);
                redirectedDuringPush = true;
                console.log(`[Ultraview] origin redirected to ${newUrl}`);
                continue;
            }

            // Retry once with Git LFS's documented per-host lock check disabled
            // after ordinary transient retries have failed. The actual LFS
            // object upload and Git push remain fully enabled.
            if (!lfsLocksDisabledFor && isLfsLockVerificationError(errMsg)) {
                lfsLocksDisabledFor = await disableUnsupportedLfsLockVerification(run);
                if (lfsLocksDisabledFor) continue;
            }

            // 2. Non-fast-forward → pull then retry
            if (/rejected|non-fast-forward/i.test(stderr)) {
                // Another machine won the race. Fetch its new commit, merge it
                // without dropping either side, then retry the push. Repeating
                // this loop converges even when several machines sync at once.
                await mergeRemoteBranch(projectPath, branch, 'ours', false, auth);
                continue;
            }

            // 3. Workflow scope → strip and force-push
            if (/workflow/i.test(errMsg) && /scope/i.test(errMsg)) {
                if (await recoverFromWorkflowScope(projectPath, run)) {
                    try {
                        await withTransientRetry(
                            () => run(`git push --force-with-lease -u origin ${branch}`),
                            'sync-push-force'
                        );
                        workflowFilesExcluded = true;
                        pushDone = true;
                    } catch (forceErr: any) {
                        // Force-push may itself surface a "moved" hint we
                        // hadn't seen yet — loop back to the top so the
                        // redirect handler can fix origin first.
                        const fStderr = forceErr?.stderr ?? '';
                        const fStdout = forceErr?.stdout ?? '';
                        const fMoved = parseMovedRepository(fStderr) || parseMovedRepository(fStdout);
                        if (fMoved) {
                            lastPushErr = forceErr;
                            const newUrl = await rewriteOriginRemote(projectPath, fMoved, run);
                            redirectedDuringPush = true;
                            console.log(`[Ultraview] origin redirected to ${newUrl} after force-push`);
                            continue;
                        }
                        throw forceErr;
                    }
                } else {
                    throw pushErr;
                }
                continue;
            }

            // 4. Anything else → bubble up
            throw pushErr;
        }
    }
    if (!pushDone) {
        throw lastPushErr ?? new Error('Push failed after retries');
    }

    // ── result summary ───────────────────────────────────────────────────────
    const noteParts: string[] = [];
    if (workflowFilesExcluded) {
        noteParts.push('.github/workflows excluded from all history (token lacks workflow scope; re-authenticate to push them)');
    }
    if (redirectedDuringPush) {
        try {
            const current = (await run('git remote get-url origin')).stdout.trim().replace(/https:\/\/[^@]+@/, 'https://');
            noteParts.push(`remote updated to ${current}`);
        } catch { /* ignore */ }
    }
    if (lfsLocksDisabledFor) {
        noteParts.push(`Git LFS lock verification disabled for ${lfsLocksDisabledFor}`);
    }
    const note = noteParts.length ? ` — ${noteParts.join(' | ')}` : '';
    if (committed && (behind > 0 || diverged)) return `Synced changes${note}`;
    if (committed) return `Changes pushed${note}`;
    if (behind > 0 || diverged) return `Updated from remote${note}`;
    return 'Up to date';
}

async function syncChangedSubmodules(
    projectPath: string,
    commitMsg?: string,
    auth?: GitAuthContext
): Promise<{ paths: string[]; notes: string[] }> {
    await initialiseMissingSubmodules(projectPath, auth);
    const paths = await vendorRepositories(projectPath);
    return { paths, notes: paths.map(relative => relative + ': imported into project') };
}

async function checkoutFinalSubmodulePointers(
    projectPath: string,
    auth?: GitAuthContext
): Promise<number> {
    if (!fs.existsSync(path.join(projectPath, '.gitmodules'))) return 0;
    const run = createGitRunner(projectPath, 120000, auth);
    try {
        await run('git submodule sync --recursive');
        await run('git submodule update --init --recursive --checkout');
        const entries = await getSubmoduleEntries(projectPath);
        const unsettled = entries.filter((entry) => entry.state !== 'clean');
        if (unsettled.length) {
            throw new Error(
                `final pointer verification failed for ${unsettled.map((entry) => entry.relativePath).join(', ')}`
            );
        }
        return entries.length;
    } catch (err: any) {
        throw new Error(`Could not check out final submodule pointers: ${formatGitError(err)}`);
    }
}

/**
 * Import nested repositories, then sync only the owning project remote.
 * Original Git metadata is retained locally outside the worktree for recovery.
 */
async function gitSyncAll(
    projectPath: string,
    commitMsg?: string,
    remoteUrl?: string,
    auth?: GitAuthContext
): Promise<string> {
    const submodules = await syncChangedSubmodules(projectPath, commitMsg, auth);
    const result = await gitSync(projectPath, commitMsg, remoteUrl, auth);
    const finalSubmoduleCount = await checkoutFinalSubmodulePointers(projectPath, auth);
    const detailCount = submodules.notes.length;
    if (!detailCount && !finalSubmoduleCount) return result;

    const details = submodules.notes;
    if (details.length) return `${result} | ${details.join(' | ')}`;
    return `${result} | ${finalSubmoduleCount} submodule${finalSubmoduleCount === 1 ? '' : 's'} verified`;
}

export class GitProvider implements vscode.WebviewViewProvider {
    public static readonly viewId = 'ultraview.git';
    private view?: vscode.WebviewView;
    private context: vscode.ExtensionContext;
    private manager: GitProjects;
    private accounts: GitAccounts;
    private store: SharedStore;
    /** Last-known git statuses — used to populate the UI instantly before async fetch */
    private _cachedGitStatuses: Record<string, GitStatus> = {};
    /** Avoid repeating network fetches when several load/visibility events arrive together. */
    private _remoteStatusCheckedAt: Record<string, number> = {};
    /** Monotonic guard so older async status refreshes cannot overwrite newer results */
    private _statusRefreshSeq = 0;
    /** Cached S3 credential check result to avoid repeated keychain reads */
    private _s3CredsCached: boolean | null = null;
    private _s3CredsCachedAt = 0;
    /** Lightweight native watchers provide instant local badges for every saved project. */
    private _projectWatchers = new Map<string, { projectPath: string; watcher: fs.FSWatcher }>();
    private _dirtyProjectIds = new Set<string>();
    private _projectWatcherDebounce?: NodeJS.Timeout;
    private _refreshInFlight?: Promise<void>;
    private _refreshQueued = false;
    constructor(context: vscode.ExtensionContext, store: SharedStore) {
        this.context = context;
        this.store = store;
        this.manager = new GitProjects(context, store);
        this.accounts = new GitAccounts(context, store);
        context.subscriptions.push({ dispose: () => this._disposeProjectWatchers() });
    }

    async addRepo(): Promise<void> {
        if (!this.view) return;
        await GitProvider._handleAddRepo(this.view.webview, this.manager, this.accounts, () =>
            this.postState()
        );
    }

    async addLocalProject(): Promise<void> {
        const uri = await vscode.window.showOpenDialog({
            canSelectFolders: true,
            canSelectFiles: false,
            openLabel: 'Select local folder',
        });
        if (!uri || !uri[0]) return;
        const folder = uri[0].fsPath;

        const nameInput = await vscode.window.showInputBox({
            prompt: 'Project name',
            value: nameFromPath(folder),
        });
        if (nameInput === undefined) return;
        const projectName = nameInput.trim() || nameFromPath(folder);

        const run = createGitRunner(folder, 15000);
        const nodePath = require('path') as typeof import('path');
        const nodeFs = require('fs') as typeof import('fs');

        // ── Check if it's already a git repo ─────────────────────────────────
        let isGitRepo = false;
        let repoUrl: string | undefined;
        let accountId: string | undefined;

        try {
            await run('git rev-parse --is-inside-work-tree');
            isGitRepo = true;
            repoUrl = await getRemoteUrl(folder);
            if (repoUrl) {
                const urlLower = repoUrl.toLowerCase();
                let targetProvider: GitProviderType | undefined;
                if (urlLower.includes('github.com')) targetProvider = 'github';
                else if (urlLower.includes('gitlab.com')) targetProvider = 'gitlab';
                else if (urlLower.includes('dev.azure.com')) targetProvider = 'azure';
                if (targetProvider) {
                    const matched = this.accounts.listAccounts().find((a) => a.provider === targetProvider);
                    if (matched) accountId = matched.id;
                }
            }
        } catch {
            // Not a git repo yet
        }

        if (isGitRepo) {
            // Already a git repo — just register it
            this.manager.addProject({ name: projectName, path: folder, accountId, repoUrl });
            this.postState();
            vscode.window.showInformationMessage(`✓ Added "${projectName}" to Project Manager.`);
            return;
        }

        // ── No git repo — offer to create one on GitHub/GitLab ───────────────
        const accounts = this.accounts.listAccounts().filter(
            (a) => a.provider === 'github' || a.provider === 'gitlab'
        );

        const createPick = await vscode.window.showQuickPick(
            [
                {
                    label: '$(cloud-upload) Create GitHub/GitLab repo and push',
                    description: 'Initialize git, create remote repo and push in one step',
                    action: 'create' as const,
                },
                {
                    label: '$(add) Add locally only',
                    description: 'Just add the folder to the project list without git',
                    action: 'local' as const,
                },
            ],
            { placeHolder: 'This folder has no git repo yet — what would you like to do?' }
        );
        if (!createPick) return;

        if (createPick.action === 'local') {
            this.manager.addProject({ name: projectName, path: folder });
            this.postState();
            return;
        }

        // ── Create remote repo flow ───────────────────────────────────────────
        if (accounts.length === 0) {
            vscode.window.showErrorMessage('No GitHub or GitLab account found. Add an account first.');
            return;
        }

        // Pick account (skip picker if only one)
        let chosenAccountId: string;
        if (accounts.length === 1) {
            chosenAccountId = accounts[0].id;
        } else {
            const accountPick = await vscode.window.showQuickPick(
                accounts.map((a) => ({
                    label: `$(person) ${a.username}`,
                    description: `${a.provider}`,
                    id: a.id,
                })),
                { placeHolder: 'Select account to create the repo under' }
            );
            if (!accountPick) return;
            chosenAccountId = (accountPick as any).id;
        }

        const accWithToken = await this.accounts.getAccountWithToken(chosenAccountId);
        if (!accWithToken?.token) {
            vscode.window.showErrorMessage(`Account has no token. Please authenticate first.`);
            return;
        }

        // Repo name (default = folder name)
        const repoName = await vscode.window.showInputBox({
            prompt: 'Repository name on ' + accWithToken.provider,
            value: projectName.replace(/\s+/g, '-'),
            validateInput: (v) => (v?.trim() ? undefined : 'Required'),
        });
        if (!repoName) return;
        const safeRepoName = repoName.trim().replace(/\s+/g, '-');

        const visibilityPick = await vscode.window.showQuickPick(
            [
                { label: '$(lock) Private', description: 'Only you can see this', isPrivate: true },
                { label: '$(unlock) Public', description: 'Anyone can see this', isPrivate: false },
            ],
            { placeHolder: 'Repository visibility' }
        );
        if (!visibilityPick) return;
        const isPrivate = (visibilityPick as any).isPrivate as boolean;

        await vscode.window.withProgress(
            { location: vscode.ProgressLocation.Notification, title: `Setting up "${safeRepoName}"…`, cancellable: false },
            async (progress) => {
                try {
                    progress.report({ message: 'Creating remote repo…' });

                    let cloneUrl = '';
                    if (accWithToken.provider === 'github') {
                        const res = await fetch('https://api.github.com/user/repos', {
                            method: 'POST',
                            headers: {
                                Authorization: `Bearer ${accWithToken.token}`,
                                'User-Agent': 'Ultraview-VSCode',
                                'Content-Type': 'application/json',
                            },
                            body: JSON.stringify({ name: safeRepoName, private: isPrivate, auto_init: false }),
                        });
                        if (!res.ok) {
                            const e = (await res.json()) as any;
                            throw new Error(e.message || `GitHub API ${res.status}`);
                        }
                        cloneUrl = ((await res.json()) as any).clone_url;
                    } else {
                        const res = await fetch('https://gitlab.com/api/v4/projects', {
                            method: 'POST',
                            headers: {
                                Authorization: `Bearer ${accWithToken.token}`,
                                'Content-Type': 'application/json',
                            },
                            body: JSON.stringify({
                                name: safeRepoName,
                                path: safeRepoName,
                                visibility: isPrivate ? 'private' : 'public',
                            }),
                        });
                        if (!res.ok) {
                            const e = (await res.json()) as any;
                            throw new Error(Array.isArray(e.message) ? e.message.join(', ') : e.message || `GitLab API ${res.status}`);
                        }
                        cloneUrl = ((await res.json()) as any).http_url_to_repo;
                    }

                    progress.report({ message: 'Initializing git…' });

                    await run('git init');
                    await run('git checkout -b main').catch(() => run('git checkout -b master'));

                    const noReplyHost = accWithToken.provider === 'github' ? 'users.noreply.github.com' : 'users.noreply.gitlab.com';
                    const noReplyPrefix = accWithToken.providerUserId
                        ? `${accWithToken.providerUserId}+${accWithToken.username}`
                        : accWithToken.username;
                    const userEmail = accWithToken.email || `${noReplyPrefix}@${noReplyHost}`;
                    await run(`git config user.name "${accWithToken.username}"`);
                    await run(`git config user.email "${userEmail}"`);

                    // Create .gitignore for common noise if none exists
                    const gitignorePath = nodePath.join(folder, '.gitignore');
                    if (!nodeFs.existsSync(gitignorePath)) {
                        nodeFs.writeFileSync(gitignorePath, 'node_modules/\n.env\ndist/\n');
                    }

                    progress.report({ message: 'Staging files…' });
                    await run('git add .');
                    await run('git commit -m "Initial commit"');

                    progress.report({ message: 'Pushing to remote…' });
                    const credUrl = cloneUrl.replace('https://', `https://${accWithToken.username}:${accWithToken.token}@`);
                    await run(`git remote add origin "${credUrl}"`);
                    await run('git push -u origin HEAD');

                    // Register in project manager
                    this.manager.addProject({
                        name: projectName,
                        path: folder,
                        accountId: chosenAccountId,
                        repoUrl: cloneUrl,
                        lastOpened: Date.now(),
                    });
                    this.accounts.setLocalAccount(folder, chosenAccountId);
                    await applyLocalAccount(folder, accWithToken, accWithToken.token!);
                    this.postState();

                    const open = await vscode.window.showInformationMessage(
                        `✓ "${safeRepoName}" created and pushed to ${accWithToken.provider}`,
                        'Open Folder',
                        'Open in New Window'
                    );
                    if (open === 'Open Folder') {
                        vscode.commands.executeCommand('vscode.openFolder', vscode.Uri.file(folder));
                    } else if (open === 'Open in New Window') {
                        vscode.commands.executeCommand('vscode.openFolder', vscode.Uri.file(folder), { forceNewWindow: true });
                    }
                } catch (err: any) {
                    vscode.window.showErrorMessage(`Failed to set up repo: ${err.message}`);
                }
            }
        );
    }

    resolveWebviewView(webviewView: vscode.WebviewView) {
        this.view = webviewView;
        webviewView.webview.options = {
            enableScripts: true,
            localResourceRoots: [
                vscode.Uri.file(require('path').join(this.context.extensionPath, 'dist')),
            ],
        };
        webviewView.webview.html = buildGitHtml(this.context.extensionPath, webviewView.webview);

        // Hot-reload when another IDE writes the shared sync file
        const onStoreChanged = () => { void this.postState(); };
        this.store.on('changed', onStoreChanged);

        // When the panel becomes visible again (e.g. user switches sidebar tabs),
        // immediately push cached statuses so badges are visible without waiting.
        webviewView.onDidChangeVisibility(() => {
            if (webviewView.visible) {
                this.postState();
            } else this._disposeProjectWatchers();
        });

        webviewView.onDidDispose(() => {
            this.store.off('changed', onStoreChanged);
            this._disposeProjectWatchers();
            this.view = undefined;
        });

        webviewView.webview.onDidReceiveMessage(async (msg) => {
            switch (msg.type) {
                case 'ready': {
                    // Render immediately. Credential application and token validation
                    // are independent background work and must not hold up first paint.
                    void this._autoApplyOnOpen();
                    this._validateAllTokensBackground().then(() => {
                        if (this.view) void this._postCachedState();
                    });
                    // Bump lastOpened for the currently active workspace so it rises to top of list
                    const activeRepoOnReady =
                        vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? '';
                    if (activeRepoOnReady) {
                        const activeProj = this.manager.getProjectByPath(activeRepoOnReady);
                        if (activeProj) {
                            this.manager.updateProject(activeProj.id, { lastOpened: Date.now() });
                        }
                    }
                    this.postState();
                    break;
                }
                case 'addProject': {
                    await this.addLocalProject();
                    break;
                }
                case 'addCurrentProject': {
                    const workspaceFolders = vscode.workspace.workspaceFolders;
                    if (workspaceFolders && workspaceFolders.length > 0) {
                        const folder = workspaceFolders[0].uri.fsPath;
                        const name = workspaceFolders[0].name;
                        this.manager.addProject({ name, path: folder, lastOpened: Date.now() });
                        this.postState();
                    } else {
                        vscode.window.showInformationMessage(
                            'No workspace folder open. Use "+ Add" to select a folder.'
                        );
                    }
                    break;
                }
                case 'addRepo': {
                    if (this.view) {
                        await GitProvider._handleAddRepo(
                            this.view.webview,
                            this.manager,
                            this.accounts,
                            () => this.postState()
                        );
                    }
                    break;
                }
                case 'refresh': {
                    this.postState();
                    break;
                }
                case 'refreshProjects': {
                    this.postState();
                    break;
                }
                case 'openPanel': {
                    vscode.commands.executeCommand('ultraview.openGitProjects');
                    break;
                }
                case 'openS3Backup': {
                    vscode.commands.executeCommand('ultraview.configureS3Backup');
                    break;
                }
                case 'backupAll': {
                    vscode.commands.executeCommand('ultraview.s3BackupAll');
                    break;
                }
                case 's3BackupProject': {
                    const project = this.manager.listProjects().find((p) => p.id === msg.id);
                    if (project) {
                        vscode.commands.executeCommand('ultraview.s3BackupProjectById', msg.id);
                    }
                    break;
                }
                case 'projectCommands': {
                    const project = this.manager.listProjects().find((p) => p.id === msg.id);
                    if (project) {
                        await showProjectCommandPicker(project.path, project.name);
                    }
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
                    const project = this.manager.listProjects().find((p) => p.id === id);
                    if (project) {
                        // Apply credentials for the project's bound account before opening
                        if (project.accountId) {
                            const acc = await this.accounts.getAccountWithToken(project.accountId);
                            if (acc) {
                                await applyLocalAccount(project.path, acc, acc.token);
                            }
                        }
                        this.manager.updateProject(id, { lastOpened: Date.now() });
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
                        const keys = this.accounts
                            .listSshKeys()
                            .filter((k) => k.accountId === accountId);
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
                        vscode.window.showWarningMessage(
                            'No workspace open. Open a project first.'
                        );
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
                        vscode.window.showInformationMessage(
                            `✓ Switched to ${acc.username} for this project.`
                        );
                    }

                    this.postState();
                    break;
                }
                case 'authOptions': {
                    const accountId = msg.accountId;
                    const account = this.accounts.getAccount(accountId);
                    if (!account) break;
                    const supportsBrowser =
                        account.provider === 'github' ||
                        account.provider === 'gitlab' ||
                        account.provider === 'azure';
                    const option = await vscode.window.showQuickPick(
                        [
                            ...(supportsBrowser
                                ? [
                                    {
                                        label: '$(refresh) Re-authenticate via Browser',
                                        description:
                                            account.authMethod === 'oauth'
                                                ? 'Refresh OAuth token (adds new scopes like workflow)'
                                                : 'Switch to browser OAuth sign-in',
                                    },
                                ]
                                : []),
                            {
                                label: '$(key) Manage SSH Key',
                                description: 'Generate and configure SSH key',
                            },
                            {
                                label: '$(key) Manage Token',
                                description: 'Add or update personal access token',
                            },
                        ],
                        { placeHolder: `Manage Auth for ${account.username}` }
                    );
                    if (option?.label.includes('Re-authenticate')) {
                        await this._reAuthOAuth(accountId, account.provider);
                        this.postState();
                    } else if (option?.label.includes('SSH')) {
                        await GitProvider._handleGenerateSshKey(
                            accountId,
                            this.view?.webview,
                            this.accounts,
                            () => this.postState()
                        );
                    } else if (option?.label.includes('Token')) {
                        await GitProvider._handleAddToken(
                            accountId,
                            this.view?.webview,
                            this.accounts
                        );
                    }
                    break;
                }
                case 'generateSshKey': {
                    const accountId = msg.accountId;
                    await GitProvider._handleGenerateSshKey(
                        accountId,
                        this.view?.webview,
                        this.accounts,
                        () => this.postState()
                    );
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
                case 'gitPull': {
                    const project = this.manager.listProjects().find((p) => p.id === msg.id);
                    if (project) {
                        try {
                            const result = await runExclusiveProjectGitOp(project.path, () =>
                                gitPull(project.path)
                            );
                            vscode.window.showInformationMessage(`✓ ${project.name}: ${result}`);
                        } catch (err: any) {
                            vscode.window.showErrorMessage(
                                `Pull failed for ${project.name}: ${err.message}`
                            );
                        }
                        // Notify other IDEs that a git operation completed
                        this.store.write({ lastSyncAt: Date.now() });
                        // Invalidate cached status so the post-op badge reflects
                        // the real remote state, not the pre-op cached one.
                        delete this._cachedGitStatuses[project.id];
                        delete this._remoteStatusCheckedAt[project.id];
                        try {
                            await this._postSingleProjectState(project.id);
                        } finally {
                            notifyGitOpDone(this.view?.webview, project.id);
                        }
                    }
                    break;
                }
                case 'gitPush': {
                    const project = this.manager.listProjects().find((p) => p.id === msg.id);
                    if (project) {
                        let pushSucceeded = false;
                        try {
                            const result = await runExclusiveProjectGitOp(project.path, () =>
                                gitPush(project.path, msg.commitMsg)
                            );
                            pushSucceeded = true;
                            vscode.window.showInformationMessage(`✓ ${project.name}: ${result}`);
                        } catch (err: any) {
                            const errMsg = err.message || 'Unknown error';
                            let showedSpecificError = false;
                            if (/workflow/i.test(errMsg) && /scope/i.test(errMsg) && project.accountId) {
                                const acc = this.accounts.getAccount(project.accountId);
                                if (acc && acc.authMethod === 'oauth' && acc.provider === 'github') {
                                    // Note: VS Code's built-in GitHub auth provider
                                    // does NOT honour the 'workflow' scope — only
                                    // PATs can have it. Ultraview's pre-flight + recovery
                                    // should have stripped .github/workflows/ from history
                                    // automatically. If we're here, the user can either
                                    // add a PAT (to keep the file) or accept the strip.
                                    vscode.window.showErrorMessage(
                                        `Push failed: GitHub OAuth tokens cannot have 'workflow' scope. ` +
                                        `Ultraview should have stripped the workflow file automatically — ` +
                                        `if you want to KEEP workflow files, add a Personal Access Token.`,
                                        'Add PAT (workflow scope)',
                                        'OK'
                                    ).then(async (action) => {
                                        if (action === 'Add PAT (workflow scope)') {
                                            await GitProvider._handleAddToken(acc.id, this.view?.webview, this.accounts);
                                            this.postState();
                                        }
                                    });
                                    showedSpecificError = true;
                                }
                            }
                            if (!showedSpecificError) {
                                vscode.window.showErrorMessage(
                                    `Push failed for ${project.name}: ${errMsg}`
                                );
                            }
                        }
                        // Notify other IDEs that a git operation completed
                        this.store.write({ lastSyncAt: Date.now() });
                        try {
                            await this._postLocalProjectState(project.id, pushSucceeded);
                        } finally {
                            notifyGitOpDone(this.view?.webview, project.id);
                        }
                    }
                    break;
                }
                case 'refreshSingleProject': {
                    const project = this.manager.listProjects().find((p) => p.id === msg.id);
                    if (project) {
                        console.log(`[Ultraview] refreshSingleProject: ${project.name} (${project.path})`);
                        // Invalidate the cached status so the next read returns
                        // a fresh value, not whatever the last sync left behind.
                        delete this._cachedGitStatuses[project.id];
                        delete this._remoteStatusCheckedAt[project.id];
                        // Force a full re-fetch + rev-list
                        try {
                            await this._postSingleProjectState(project.id);
                        } catch (e) {
                            console.warn(`[Ultraview] refresh failed for ${project.name}:`, e);
                        }
                    }
                    break;
                }
                case 'gitSync': {
                    const project = this.manager.listProjects().find((p) => p.id === msg.id);
                    if (project) {
                        let syncSucceeded = false;
                        const syncAccount = project.accountId
                            ? await this.accounts.getAccountWithToken(project.accountId)
                            : undefined;
                        const syncAuth = authContextFromAccount(syncAccount);
                        try {
                            await runExclusiveProjectGitOp(project.path, async () => {
                                try {
                                    const result = await gitSyncAll(
                                        project.path,
                                        msg.commitMsg,
                                        project.repoUrl,
                                        syncAuth
                                    );
                                    syncSucceeded = true;
                                    vscode.window.showInformationMessage(`✓ ${project.name}: ${result}`);
                                } catch (err: any) {
                                    if (err?.code !== 'NO_REMOTE') throw err;
                                    // No remote configured — prompt user to connect one
                                    const picked = await this._promptAndAddRemote(
                                        project.path, project.id
                                    );
                                    if (picked) {
                                        // Retry sync now that remote is set up
                                        const result = await gitSyncAll(
                                            project.path,
                                            msg.commitMsg,
                                            picked,
                                            syncAuth
                                        );
                                        syncSucceeded = true;
                                        vscode.window.showInformationMessage(`✓ ${project.name}: ${result}`);
                                    }
                                }
                            });
                        } catch (err: any) {
                            const errMsg = err.message || 'Unknown error';
                            let showedSpecificError = false;
                            if (/workflow/i.test(errMsg) && /scope/i.test(errMsg) && project.accountId) {
                                const acc = this.accounts.getAccount(project.accountId);
                                if (acc && acc.authMethod === 'oauth' && acc.provider === 'github') {
                                    // Note: VS Code's built-in GitHub auth provider
                                    // does NOT honour the 'workflow' scope — only
                                    // PATs can have it. Ultraview's pre-flight + recovery
                                    // should have stripped .github/workflows/ from history
                                    // automatically. If we're here, the user can either
                                    // add a PAT (to keep the file) or accept the strip.
                                    vscode.window.showErrorMessage(
                                        `Sync failed: GitHub OAuth tokens cannot have 'workflow' scope. ` +
                                        `Ultraview should have stripped the workflow file automatically — ` +
                                        `if you want to KEEP workflow files, add a Personal Access Token.`,
                                        'Add PAT (workflow scope)',
                                        'OK'
                                    ).then(async (action) => {
                                        if (action === 'Add PAT (workflow scope)') {
                                            await GitProvider._handleAddToken(acc.id, this.view?.webview, this.accounts);
                                            this.postState();
                                        }
                                    });
                                    showedSpecificError = true;
                                    // Continue into completion cleanup so the button
                                    // cannot remain stuck in Syncing state.
                                }
                            }
                            if (!showedSpecificError) {
                                vscode.window.showErrorMessage(
                                    `Sync failed for ${project.name}: ${errMsg}`
                                );
                            }
                        }
                        this.store.write({ lastSyncAt: Date.now() });
                        // Invalidate the cached status so the post-sync fetch
                        // returns a fresh value, not whatever was in the cache
                        // before the sync. This is what makes the badge clear
                        // to "synced" instead of staying stuck on 1 ahead / 1
                        // behind / 1 local.
                        delete this._cachedGitStatuses[project.id];
                        delete this._remoteStatusCheckedAt[project.id];
                        try {
                            await this._postLocalProjectState(project.id, syncSucceeded);
                        } finally {
                            notifyGitOpDone(this.view?.webview, project.id);
                        }
                    }
                    break;
                }
            }
        });

        // The webview's ready message requests initial state. Avoid also starting
        // a duplicate all-project Git scan here during the same load.
    }

    /** Returns whether an S3 backup bucket is configured, caching the result for 60 s. */
    private async _hasBackupBucket(): Promise<boolean> {
        const now = Date.now();
        if (this._s3CredsCached !== null && now - this._s3CredsCachedAt < 60_000) {
            return this._s3CredsCached;
        }
        this._s3CredsCached = !!(await getS3Credentials(this.context));
        this._s3CredsCachedAt = now;
        return this._s3CredsCached;
    }

    /** Invalidate the S3 creds cache (call whenever credentials are changed). */
    private _invalidateS3Cache(): void {
        this._s3CredsCached = null;
        this._s3CredsCachedAt = 0;
    }

    /** Send account/project metadata with existing badges and no Git processes. */
    private async _postCachedState(): Promise<void> {
        if (!this.view?.visible) return;
        const projects = this.manager
            .listProjects()
            .slice()
            .sort((a, b) => (b.lastOpened ?? 0) - (a.lastOpened ?? 0));
        this._syncProjectWatchers(projects);
        const activeRepo = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? '';
        const activeProject = projects.find((project) => project.path === activeRepo);
        const accounts = this.accounts.listAccounts();
        const activeAccountId = activeProject?.accountId
            || (activeRepo ? this.accounts.getLocalAccount(activeRepo)?.id : undefined);
        const hasBackupBucket = await this._hasBackupBucket();
        if (!this.view?.visible) return;
        this.view.webview.postMessage({
            type: 'state',
            projects,
            activeRepo,
            activeRepoName: vscode.workspace.workspaceFolders?.[0]?.name ?? '',
            accounts: accounts.map((account) => ({
                ...account,
                authStatus: this.accounts.getAccountAuthStatus(account),
            })),
            activeAccountId: activeAccountId || null,
            activeProjectId: activeProject?.id || null,
            gitStatuses: this._cachedGitStatuses,
            hasBackupBucket,
        });
    }

    async postState() {
        if (!this.view?.visible) return;
        if (this._refreshInFlight) {
            this._refreshQueued = true;
            return this._refreshInFlight;
        }
        const refresh = async () => {
            const refreshSeq = ++this._statusRefreshSeq;
            const projects = this.manager
                .listProjects()
                .slice()
                .sort((a, b) => (b.lastOpened ?? 0) - (a.lastOpened ?? 0));
            this._syncProjectWatchers(projects);
            const activeRepo = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? '';
            const accounts = this.accounts.listAccounts();

            // Find active project and its account
            const activeProject = projects.find((p) => p.path === activeRepo);
            const activeAccountId =
                activeProject?.accountId ||
                (activeRepo ? this.accounts.getLocalAccount(activeRepo)?.id : undefined);

            // Compute auth status for each account
            const accountsWithStatus = accounts.map((acc) => ({
                ...acc,
                authStatus: this.accounts.getAccountAuthStatus(acc),
            }));

            const activeRepoName = vscode.workspace.workspaceFolders?.[0]?.name ?? '';

            // Use cached S3 cred check — avoids keychain reads on every refresh
            const hasBackupBucket = await this._hasBackupBucket();

            const buildMsg = (gitStatuses: Record<string, GitStatus>) => ({
                type: 'state',
                projects,
                activeRepo,
                activeRepoName,
                accounts: accountsWithStatus,
                activeAccountId: activeAccountId || null,
                activeProjectId: activeProject?.id || null,
                gitStatuses,
                hasBackupBucket,
            });

            // Pass 1: send cached statuses immediately — badges visible right away
            this.view?.webview.postMessage(buildMsg(this._cachedGitStatuses));

            // Pass 2: fast local-only check (no network fetch) — updates localChanges badge quickly
            const localStatuses: Record<string, GitStatus> = {};
            const LOCAL_CONCURRENCY = 4;
            for (let i = 0; i < projects.length; i += LOCAL_CONCURRENCY) {
                if (!this.view?.visible) return;
                const batch = projects.slice(i, i + LOCAL_CONCURRENCY);
                await Promise.allSettled(batch.map(async (p) => {
                    localStatuses[p.id] = await getProjectLocalStatus(p.path, this._cachedGitStatuses[p.id]);
                }));
            }
            if (refreshSeq !== this._statusRefreshSeq || !this.view) return;
            this._cachedGitStatuses = { ...this._cachedGitStatuses, ...localStatuses };
            if (this.view) this.view.webview.postMessage(buildMsg(this._cachedGitStatuses));

            // Pass 3: full check with git fetch — updates ahead/behind. A short TTL
            // coalesces startup, visibility, and store events; the existing 30 s UI
            // refresh still keeps every badge current.
            const REMOTE_STATUS_TTL_MS = 25_000;
            const now = Date.now();
            const projectsNeedingRemote = projects.filter(
                (project) => now - (this._remoteStatusCheckedAt[project.id] ?? 0) >= REMOTE_STATUS_TTL_MS
            );
            const MAX_CONCURRENT = 2;
            const remoteStatuses: Record<string, GitStatus> = {};
            for (let i = 0; i < projectsNeedingRemote.length; i += MAX_CONCURRENT) {
                if (!this.view?.visible) return;
                const batch = projectsNeedingRemote.slice(i, i + MAX_CONCURRENT);
                await Promise.allSettled(
                    batch.map(async (p) => {
                        remoteStatuses[p.id] = await getProjectGitStatus(p.path, localStatuses[p.id]);
                    })
                );
            }

            if (Object.keys(remoteStatuses).length > 0) {
                if (refreshSeq !== this._statusRefreshSeq || !this.view) return;
                this._cachedGitStatuses = { ...this._cachedGitStatuses, ...remoteStatuses };
                const checkedAt = Date.now();
                for (const projectId of Object.keys(remoteStatuses)) {
                    this._remoteStatusCheckedAt[projectId] = checkedAt;
                }
                if (this.view) this.view.webview.postMessage(buildMsg(this._cachedGitStatuses));
            }
        };
        const pending = (async () => {
            do {
                this._refreshQueued = false;
                await refresh();
            } while (this._refreshQueued && this.view?.visible);
        })();
        this._refreshInFlight = pending;
        try { await pending; }
        finally { if (this._refreshInFlight === pending) this._refreshInFlight = undefined; }
    }

    /** Keep one OS watcher per saved project. Events are cheap; Git status only
     *  runs after a short quiet period and only for repositories that changed. */
    private _syncProjectWatchers(projects: Array<{ id: string; path: string }>): void {
        const wantedIds = new Set(projects.map((project) => project.id));
        for (const [projectId, entry] of this._projectWatchers) {
            const project = projects.find((candidate) => candidate.id === projectId);
            if (!wantedIds.has(projectId) || project?.path !== entry.projectPath) {
                entry.watcher.close();
                this._projectWatchers.delete(projectId);
            }
        }

        for (const project of projects) {
            if (this._projectWatchers.has(project.id) || !project.path) continue;
            try {
                const watcher = fs.watch(project.path, { recursive: true }, (_event, filename) => {
                    const relativePath = filename?.toString().replace(/\\/g, '/').toLowerCase() ?? '';
                    if (this._ignoreProjectWatchEvent(relativePath)) return;
                    this._queueProjectStatusRefresh(project.id);
                });
                watcher.on('error', () => {
                    watcher.close();
                    this._projectWatchers.delete(project.id);
                });
                this._projectWatchers.set(project.id, { projectPath: project.path, watcher });
            } catch {
                // Missing, inaccessible, or unsupported paths still update through
                // the normal manual/30-second refresh path.
            }
        }
    }

    private _ignoreProjectWatchEvent(relativePath: string): boolean {
        if (!relativePath) return false;
        const noisyDirectory = /(^|\/)(node_modules|dist|out|build|target|coverage|\.next|\.cache)(\/|$)/;
        if (noisyDirectory.test(relativePath)) return true;
        if (!relativePath.startsWith('.git/')) return false;
        return relativePath !== '.git/index'
            && relativePath !== '.git/head'
            && relativePath !== '.git/packed-refs'
            && !relativePath.startsWith('.git/refs/');
    }

    private _queueProjectStatusRefresh(projectId: string): void {
        if (!this.view?.visible) return;
        this._dirtyProjectIds.add(projectId);
        if (this._projectWatcherDebounce) clearTimeout(this._projectWatcherDebounce);
        this._projectWatcherDebounce = setTimeout(() => {
            this._projectWatcherDebounce = undefined;
            const projectIds = [...this._dirtyProjectIds];
            this._dirtyProjectIds.clear();
            void (async () => {
                if (this._refreshInFlight) {
                    this._refreshQueued = true;
                    return;
                }
                for (const id of projectIds) await this._postLocalProjectState(id);
            })();
        }, 350);
    }

    private _disposeProjectWatchers(): void {
        for (const entry of this._projectWatchers.values()) entry.watcher.close();
        this._projectWatchers.clear();
        this._dirtyProjectIds.clear();
        if (this._projectWatcherDebounce) clearTimeout(this._projectWatcherDebounce);
        this._projectWatcherDebounce = undefined;
    }

    /** Fast local-only update for a single project (no git fetch — just branch + localChanges). */
    public async _postLocalProjectState(projectId: string, assumeSynced = false): Promise<void> {
        if (!this.view?.visible) return;
        const refreshSeq = ++this._statusRefreshSeq;
        const projects = this.manager
            .listProjects()
            .slice()
            .sort((a, b) => (b.lastOpened ?? 0) - (a.lastOpened ?? 0));
        const activeRepo = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? '';
        const accounts = this.accounts.listAccounts();
        const activeProject = projects.find((p) => p.path === activeRepo);
        const activeAccountId =
            activeProject?.accountId ||
            (activeRepo ? this.accounts.getLocalAccount(activeRepo)?.id : undefined);
        const accountsWithStatus = accounts.map((acc) => ({
            ...acc,
            authStatus: this.accounts.getAccountAuthStatus(acc),
        }));
        const activeRepoName = vscode.workspace.workspaceFolders?.[0]?.name ?? '';
        const hasBackupBucket = await this._hasBackupBucket();
        const project = projects.find((p) => p.id === projectId);
        if (!project) return;
        const previousStatus = assumeSynced
            ? { ...this._cachedGitStatuses[project.id], ahead: 0, behind: 0 } as GitStatus
            : this._cachedGitStatuses[project.id];
        const localStatus = await getProjectLocalStatus(project.path, previousStatus);
        if (assumeSynced) {
            localStatus.ahead = 0;
            localStatus.behind = 0;
        }
        if (refreshSeq !== this._statusRefreshSeq || !this.view) return;
        this._cachedGitStatuses = { ...this._cachedGitStatuses, [project.id]: localStatus };
        this.view.webview.postMessage({
            type: 'state',
            projects,
            activeRepo,
            activeRepoName,
            accounts: accountsWithStatus,
            activeAccountId: activeAccountId || null,
            activeProjectId: activeProject?.id || null,
            gitStatuses: { [project.id]: localStatus },
            onlyProjectId: projectId,
            hasBackupBucket,
        });
    }

    /** Post state for a single project only (for targeted UI update) */
    public async _postSingleProjectState(projectId: string): Promise<void> {
        if (!this.view) return;
        const refreshSeq = ++this._statusRefreshSeq;
        const projects = this.manager
            .listProjects()
            .slice()
            .sort((a, b) => (b.lastOpened ?? 0) - (a.lastOpened ?? 0));
        const activeRepo = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? '';
        const accounts = this.accounts.listAccounts();
        const activeProject = projects.find((p) => p.path === activeRepo);
        const activeAccountId =
            activeProject?.accountId ||
            (activeRepo ? this.accounts.getLocalAccount(activeRepo)?.id : undefined);
        const accountsWithStatus = accounts.map((acc) => ({
            ...acc,
            authStatus: this.accounts.getAccountAuthStatus(acc),
        }));
        const activeRepoName = vscode.workspace.workspaceFolders?.[0]?.name ?? '';
        const hasBackupBucket = await this._hasBackupBucket();
        const gitStatuses: Record<string, GitStatus> = {};
        const project = projects.find((p) => p.id === projectId);
        if (project) {
            gitStatuses[project.id] = await getProjectGitStatus(project.path);
        }
        if (refreshSeq !== this._statusRefreshSeq || !this.view) return;
        this._cachedGitStatuses = { ...this._cachedGitStatuses, ...gitStatuses };
        if (gitStatuses[projectId]) this._remoteStatusCheckedAt[projectId] = Date.now();
        this.view.webview.postMessage({
            type: 'state',
            projects,
            activeRepo,
            activeRepoName,
            accounts: accountsWithStatus,
            activeAccountId: activeAccountId || null,
            activeProjectId: activeProject?.id || null,
            gitStatuses,
            onlyProjectId: projectId,
            hasBackupBucket,
        });
    }

    /** Auto-apply credentials when the extension loads for the current workspace */
    private async _autoApplyOnOpen(): Promise<void> {
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

    /**
     * Prompts the user to connect a remote to a local repo that has none.
     * Options (via VS Code quick-pick, no extra UI):
     *   1. Pick an existing repo from their connected Git account
     *   2. Enter a remote URL manually
     *
     * On success, adds `origin` to the local git repo, saves `repoUrl` on
     * the project record, and returns the URL for the caller to retry sync.
     * Returns undefined if the user cancels.
     */
    public async _promptAndAddRemote(
        projectPath: string,
        projectId: string
    ): Promise<string | undefined> {
        // Build options list
        const items: vscode.QuickPickItem[] = [
            {
                label: '$(repo) Pick from my account repos',
                description: 'Connect an existing GitHub/GitLab repo as the remote',
            },
            {
                label: '$(link) Enter remote URL',
                description: 'Paste any git remote URL (HTTPS or SSH)',
            },
        ];

        const choice = await vscode.window.showQuickPick(items, {
            placeHolder: `"${path.basename(projectPath)}" has no remote — connect it to a git service`,
            ignoreFocusOut: true,
        });

        if (!choice) return undefined;

        let remoteUrl: string | undefined;

        if (choice.label.includes('Pick from')) {
            // Fetch repo list from the active account (same as _handleAddRepo does)
            const activeRepo = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? '';
            const activeAcc = activeRepo
                ? this.accounts.getLocalAccount(activeRepo)
                : this.accounts.listAccounts()[0];
            if (!activeAcc) {
                vscode.window.showErrorMessage('No active Git account — add one first.');
                return undefined;
            }
            const accWithToken = await this.accounts.getAccountWithToken(activeAcc.id);
            if (!accWithToken?.token) {
                vscode.window.showErrorMessage(`${activeAcc.username} has no token — authenticate first.`);
                return undefined;
            }

            let repos: { name: string; url: string }[] = [];
            try {
                if (activeAcc.provider === 'github') {
                    const res = await fetch(
                        'https://api.github.com/user/repos?per_page=100&sort=updated',
                        { headers: { Authorization: `Bearer ${accWithToken.token}`, 'User-Agent': 'Ultraview-VSCode' } }
                    );
                    if (res.ok) {
                        const data = (await res.json()) as any[];
                        repos = data.map((r) => ({ name: r.full_name, url: r.ssh_url || r.clone_url }));
                    }
                } else if (activeAcc.provider === 'gitlab') {
                    const res = await fetch(
                        'https://gitlab.com/api/v4/projects?membership=true&simple=true&per_page=100',
                        { headers: { Authorization: `Bearer ${accWithToken.token}` } }
                    );
                    if (res.ok) {
                        const data = (await res.json()) as any[];
                        repos = data.map((r) => ({ name: r.path_with_namespace, url: r.ssh_url_to_repo || r.http_url_to_repo }));
                    }
                }
            } catch { /* fall through to manual entry */ }

            if (repos.length === 0) {
                vscode.window.showWarningMessage('Could not fetch repo list — enter URL manually.');
                return undefined;
            }

            const picked = await vscode.window.showQuickPick(
                repos.map((r) => ({ label: r.name, description: r.url, url: r.url })),
                { placeHolder: 'Select the remote repo to connect', ignoreFocusOut: true }
            );
            remoteUrl = (picked as any)?.url;
        } else {
            // Manual URL entry
            remoteUrl = await vscode.window.showInputBox({
                prompt: 'Enter the git remote URL (HTTPS or SSH)',
                placeHolder: 'https://github.com/you/repo.git  or  git@github.com:you/repo.git',
                ignoreFocusOut: true,
                validateInput: (v) => v.trim() ? undefined : 'URL is required',
            });
        }

        if (!remoteUrl) return undefined;

        // Save repoUrl on project so future syncs use it automatically
        this.manager.updateProject(projectId, { repoUrl: remoteUrl });

        return remoteUrl;
    }

    private async _reAuthOAuth(accountId: string, provider: GitProviderType): Promise<void> {
        const browserProviders: Record<string, string> = {
            github: 'github',
            gitlab: 'gitlab',
            azure: 'microsoft',
        };
        const vsCodeProviderId = browserProviders[provider];
        const scopes: Record<string, string[]> = {
            github: ['repo', 'workflow', 'read:user', 'user:email'],
            gitlab: ['read_user', 'api'],
            microsoft: ['499b84ac-1321-427f-aa17-267ca6975798/.default'],
        };
        try {
            const session = await vscode.authentication.getSession(
                vsCodeProviderId,
                scopes[vsCodeProviderId] || [],
                { forceNewSession: true }
            );
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

    /** Background-validate all token-based account tokens silently. */
    private async _validateAllTokensBackground(): Promise<void> {
        const accounts = this.accounts.listAccounts();
        for (const acc of accounts) {
            if (acc.authMethod === 'oauth' || acc.authMethod === 'pat') {
                await this.accounts.validateToken(acc.id);
            }
        }
    }

    private async _addAccount(): Promise<void> {
        const provider = await vscode.window.showQuickPick(
            [
                { label: 'github', description: 'GitHub' },
                { label: 'gitlab', description: 'GitLab' },
                { label: 'azure', description: 'Azure DevOps' },
            ],
            { placeHolder: 'Select provider' }
        );

        if (!provider) return;

        const browserProviders: Record<string, string> = {
            github: 'github',
            gitlab: 'gitlab',
            azure: 'microsoft',
        };
        const authMethodItems: { label: string; description: string }[] = [
            { label: 'browser', description: 'Sign in via browser (OAuth) — recommended' },
            { label: 'ssh', description: 'Generate SSH key' },
            { label: 'token', description: 'Enter personal access token manually' },
        ];

        const authMethod = await vscode.window.showQuickPick(authMethodItems, {
            placeHolder: 'How do you want to authenticate?',
        });
        if (!authMethod) return;

        if (authMethod.label === 'browser') {
            await this._addAccountViaOAuth(
                provider.label as GitProviderType,
                browserProviders[provider.label]
            );
            return;
        }

        const username = await vscode.window.showInputBox({ prompt: `${provider.label} username` });
        if (!username) return;

        const authMethodValue: AuthMethod =
            authMethod.label === 'ssh' ? 'ssh' : authMethod.label === 'token' ? 'pat' : 'oauth';
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
                project = this.manager.addProject({
                    name: nameFromPath(activeRepo),
                    path: activeRepo,
                });
            }
            this.manager.setProjectAccount(project.id, account.id);
            this.accounts.setLocalAccount(activeRepo, account.id);
            await applyLocalAccount(activeRepo, account, account.token);
        }

        if (authMethod.label === 'ssh') {
            const keyName = await vscode.window.showInputBox({
                prompt: 'SSH key name (optional)',
                value: `ultraview-${username}`,
            });
            const key = await this.accounts.generateSshKey(
                account.id,
                account.provider,
                keyName || undefined
            );
            const { sshKeyUrl } = this.accounts.getProviderUrl(account.provider);
            await vscode.env.clipboard.writeText(key.publicKey);
            vscode.window.showInformationMessage(
                `SSH key generated and copied to clipboard! Opening ${account.provider} settings...`
            );
            vscode.env.openExternal(vscode.Uri.parse(sshKeyUrl));
            this.accounts.updateAccount(account.id, { sshKeyId: key.id });
        } else if (authMethod.label === 'token') {
            const token = await vscode.window.showInputBox({
                prompt: 'Enter personal access token',
                password: true,
            });
            if (token) {
                this.accounts.updateAccount(account.id, { token });
            }
        }

        this.postState();
    }

    private async _addAccountViaOAuth(
        gitProvider: GitProviderType,
        vsCodeProviderId: string
    ): Promise<void> {
        const scopes: Record<string, string[]> = {
            github: ['repo', 'workflow', 'read:user', 'user:email'],
            gitlab: ['read_user', 'api'],
            microsoft: ['499b84ac-1321-427f-aa17-267ca6975798/.default'],
        };

        try {
            const session = await vscode.authentication.getSession(
                vsCodeProviderId,
                scopes[vsCodeProviderId] || [],
                { forceNewSession: true }
            );
            const username = session.account.label;
            const token = session.accessToken;

            // Try to fetch email and user ID from provider API
            let email: string | undefined;
            let providerUserId: number | undefined;
            try {
                if (gitProvider === 'github') {
                    const res = await fetch('https://api.github.com/user', {
                        headers: {
                            Authorization: `Bearer ${token}`,
                            'User-Agent': 'Ultraview-VSCode',
                        },
                    });
                    if (res.ok) {
                        const data = (await res.json()) as { id?: number; email?: string };
                        email = data.email || undefined;
                        providerUserId = data.id;
                    }
                    if (!email) {
                        const emailsRes = await fetch('https://api.github.com/user/emails', {
                            headers: {
                                Authorization: `Bearer ${token}`,
                                'User-Agent': 'Ultraview-VSCode',
                            },
                        });
                        if (emailsRes.ok) {
                            const emailsData = (await emailsRes.json()) as {
                                email: string;
                                primary: boolean;
                            }[];
                            const primaryEmail = emailsData.find((e) => e.primary);
                            if (primaryEmail) {
                                email = primaryEmail.email;
                            } else if (emailsData.length > 0) {
                                email = emailsData[0].email;
                            }
                        }
                    }
                } else if (gitProvider === 'gitlab') {
                    const res = await fetch('https://gitlab.com/api/v4/user', {
                        headers: { Authorization: `Bearer ${token}` },
                    });
                    if (res.ok) {
                        const data = (await res.json()) as { id?: number; email?: string };
                        email = data.email || undefined;
                        providerUserId = data.id;
                    }
                }
            } catch {
                // email is optional
            }

            const account = this.accounts.addAccount({
                provider: gitProvider,
                username,
                email,
                providerUserId,
                token,
                authMethod: 'oauth' as AuthMethod,
                lastValidatedAt: Date.now(),
            });

            // Auto-bind to current project
            const activeRepo = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? '';
            if (activeRepo) {
                let project = this.manager.getProjectByPath(activeRepo);
                if (!project) {
                    project = this.manager.addProject({
                        name: nameFromPath(activeRepo),
                        path: activeRepo,
                    });
                }
                this.manager.setProjectAccount(project.id, account.id);
                this.accounts.setLocalAccount(activeRepo, account.id);
                await applyLocalAccount(activeRepo, account, token);
            }

            vscode.window.showInformationMessage(`Signed in as ${username} via ${gitProvider}!`);
            this.postState();
        } catch (err: any) {
            if (
                err?.name === 'Error' &&
                String(err?.message).includes('No authentication provider')
            ) {
                vscode.window.showErrorMessage(
                    `Browser sign-in for ${gitProvider} requires the ${gitProvider} extension to be installed. Use manual token instead.`
                );
            } else {
                vscode.window.showErrorMessage(
                    `OAuth sign-in failed: ${err?.message ?? String(err)}`
                );
            }
        }
    }

    static openAsPanel(context: vscode.ExtensionContext, store: SharedStore) {
        const panel = vscode.window.createWebviewPanel(
            'ultraview.git.panel',
            'Project Manager',
            vscode.ViewColumn.One,
            { enableScripts: true, retainContextWhenHidden: true }
        );
        panel.webview.html = buildGitHtml(context.extensionPath, panel.webview);

        const manager = new GitProjects(context, store);
        const accounts = new GitAccounts(context, store);
        let panelStatusRefreshSeq = 0;
        let panelRefreshInFlight: Promise<void> | undefined;
        let panelRefreshQueued = false;
        let panelDisposed = false;
        const panelRemoteCheckedAt = new Map<string, number>();
        const panelCachedStatuses: Record<string, GitStatus> = {};

        const postPanelState = async (localOnlyProjectId?: string, assumeSynced = false) => {
            if (panelDisposed || !panel.visible) return;
            if (panelRefreshInFlight) {
                panelRefreshQueued = true;
                return panelRefreshInFlight;
            }
            const refresh = async () => {
                const refreshSeq = ++panelStatusRefreshSeq;
                const projects = manager.listProjects();
                const activeRepo = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? '';
                const accountList = accounts.listAccounts();
                const activeProject = projects.find((p) => p.path === activeRepo);
                const activeAccountId =
                    activeProject?.accountId ||
                    (activeRepo ? accounts.getLocalAccount(activeRepo)?.id : undefined);

                // Compute auth status for each account
                const accountsWithStatus = accountList.map((acc) => ({
                    ...acc,
                    authStatus: accounts.getAccountAuthStatus(acc),
                }));

                const activeRepoName = vscode.workspace.workspaceFolders?.[0]?.name ?? '';
                const hasBackupBucket = !!(await getS3Credentials(context));

                const buildMsg = (gitStatuses: Record<string, GitStatus>) => ({
                    type: 'state',
                    projects,
                    activeRepo,
                    activeRepoName,
                    accounts: accountsWithStatus,
                    activeAccountId: activeAccountId || null,
                    activeProjectId: activeProject?.id || null,
                    gitStatuses,
                    hasBackupBucket,
                });

                // Send state immediately so the list updates instantly
                panel.webview.postMessage(buildMsg(panelCachedStatuses));

                if (localOnlyProjectId) {
                    const project = projects.find((candidate) => candidate.id === localOnlyProjectId);
                    if (!project) return;
                    const status = await getProjectLocalStatus(project.path);
                    if (assumeSynced) {
                        status.ahead = 0;
                        status.behind = 0;
                    }
                    if (refreshSeq !== panelStatusRefreshSeq) return;
                    panel.webview.postMessage({
                        ...buildMsg({ [project.id]: status }),
                        onlyProjectId: project.id,
                    });
                    return;
                }

                // Then fetch git statuses in background and send again
                const gitStatuses: Record<string, GitStatus> = {};
                for (let i = 0; i < projects.length; i += 2) {
                    if (panelDisposed || !panel.visible) return;
                    await Promise.allSettled(projects.slice(i, i + 2).map(async (p) => {
                        const local = await getProjectLocalStatus(p.path, panelCachedStatuses[p.id]);
                        if (Date.now() - (panelRemoteCheckedAt.get(p.id) ?? 0) < 25000) {
                            gitStatuses[p.id] = local;
                        } else {
                            gitStatuses[p.id] = await getProjectGitStatus(p.path, local);
                            panelRemoteCheckedAt.set(p.id, Date.now());
                        }
                    }));
                }

                if (refreshSeq !== panelStatusRefreshSeq) return;
                Object.assign(panelCachedStatuses, gitStatuses);
                panel.webview.postMessage(buildMsg(gitStatuses));
            };
            const pending = (async () => {
                do {
                    panelRefreshQueued = false;
                    await refresh();
                    localOnlyProjectId = undefined;
                } while (panelRefreshQueued && panel.visible && !panelDisposed);
            })();
            panelRefreshInFlight = pending;
            try { await pending; }
            finally { if (panelRefreshInFlight === pending) panelRefreshInFlight = undefined; }
        };

        // Hot-reload when another IDE writes the shared sync file
        store.on('changed', postPanelState);
        panel.onDidDispose(() => { panelDisposed = true; store.off('changed', postPanelState); });
        panel.onDidChangeViewState(() => { if (panel.visible) void postPanelState(); });

        /** Prompts user to pick/enter a remote URL for a repo with no remote (panel context). */
        const promptAndAddRemotePanel = async (
            projectPath: string,
            projectId: string
        ): Promise<string | undefined> => {
            const items: vscode.QuickPickItem[] = [
                { label: '$(repo) Pick from my account repos', description: 'Connect an existing GitHub/GitLab repo' },
                { label: '$(link) Enter remote URL', description: 'Paste any git remote URL (HTTPS or SSH)' },
            ];
            const choice = await vscode.window.showQuickPick(items, {
                placeHolder: `"${path.basename(projectPath)}" has no remote — connect it to a git service`,
                ignoreFocusOut: true,
            });
            if (!choice) return undefined;

            let remoteUrl: string | undefined;

            if (choice.label.includes('Pick from')) {
                const activeRepo = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? '';
                const activeAcc = activeRepo ? accounts.getLocalAccount(activeRepo) : accounts.listAccounts()[0];
                if (!activeAcc) { vscode.window.showErrorMessage('No active Git account — add one first.'); return undefined; }
                const accWithToken = await accounts.getAccountWithToken(activeAcc.id);
                if (!accWithToken?.token) { vscode.window.showErrorMessage(`${activeAcc.username} has no token — authenticate first.`); return undefined; }

                let repos: { name: string; url: string }[] = [];
                try {
                    if (activeAcc.provider === 'github') {
                        const res = await fetch('https://api.github.com/user/repos?per_page=100&sort=updated',
                            { headers: { Authorization: `Bearer ${accWithToken.token}`, 'User-Agent': 'Ultraview-VSCode' } });
                        if (res.ok) repos = ((await res.json()) as any[]).map((r) => ({ name: r.full_name, url: r.ssh_url || r.clone_url }));
                    } else if (activeAcc.provider === 'gitlab') {
                        const res = await fetch('https://gitlab.com/api/v4/projects?membership=true&simple=true&per_page=100',
                            { headers: { Authorization: `Bearer ${accWithToken.token}` } });
                        if (res.ok) repos = ((await res.json()) as any[]).map((r) => ({ name: r.path_with_namespace, url: r.ssh_url_to_repo || r.http_url_to_repo }));
                    }
                } catch { /* fall through */ }

                if (!repos.length) { vscode.window.showWarningMessage('Could not fetch repo list — enter URL manually.'); return undefined; }

                const picked = await vscode.window.showQuickPick(
                    repos.map((r) => ({ label: r.name, description: r.url, url: r.url })),
                    { placeHolder: 'Select the remote repo to connect', ignoreFocusOut: true }
                );
                remoteUrl = (picked as any)?.url;
            } else {
                remoteUrl = await vscode.window.showInputBox({
                    prompt: 'Enter the git remote URL (HTTPS or SSH)',
                    placeHolder: 'https://github.com/you/repo.git  or  git@github.com:you/repo.git',
                    ignoreFocusOut: true,
                    validateInput: (v) => v.trim() ? undefined : 'URL is required',
                });
            }

            if (!remoteUrl) return undefined;
            manager.updateProject(projectId, { repoUrl: remoteUrl });
            return remoteUrl;
        };

        panel.webview.onDidReceiveMessage(async (msg) => {
            switch (msg.type) {
                case 'ready': {
                    postPanelState();
                    break;
                }
                case 'addProject': {
                    const uri = await vscode.window.showOpenDialog({
                        canSelectFolders: true,
                        canSelectFiles: false,
                        openLabel: 'Select folder for project',
                    });
                    if (uri && uri[0]) {
                        const folder = uri[0].fsPath;
                        const name = await vscode.window.showInputBox({
                            prompt: 'Project name',
                            value: nameFromPath(folder),
                        });
                        if (name !== undefined) {
                            const projectName = name || nameFromPath(folder);
                            const run = createGitRunner(folder, 8000);
                            let accountId: string | undefined;
                            let repoUrl: string | undefined;
                            try {
                                await run('git rev-parse --is-inside-work-tree');
                                repoUrl = await getRemoteUrl(folder);
                                if (repoUrl) {
                                    const urlLower = repoUrl.toLowerCase();
                                    let targetProvider: GitProviderType | undefined;
                                    if (urlLower.includes('github.com')) targetProvider = 'github';
                                    else if (urlLower.includes('gitlab.com'))
                                        targetProvider = 'gitlab';
                                    else if (urlLower.includes('dev.azure.com'))
                                        targetProvider = 'azure';
                                    if (targetProvider) {
                                        const accountsList = accounts.listAccounts();
                                        const matched = accountsList.find(
                                            (a) => a.provider === targetProvider
                                        );
                                        if (matched) accountId = matched.id;
                                    }
                                }
                            } catch {
                                // Not a git repo, add as plain project
                            }
                            manager.addProject({
                                name: projectName,
                                path: folder,
                                accountId,
                                repoUrl,
                            });
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
                        vscode.window.showInformationMessage(
                            'No workspace folder open. Use "+ Add" to select a folder.'
                        );
                    }
                    break;
                }
                case 'addRepo': {
                    await GitProvider._handleAddRepo(
                        panel.webview,
                        manager,
                        accounts,
                        postPanelState
                    );
                    break;
                }
                case 'refresh': {
                    postPanelState();
                    break;
                }
                case 'refreshProjects': {
                    postPanelState();
                    break;
                }
                case 'projectCommands': {
                    const project = manager.listProjects().find((p) => p.id === msg.id);
                    if (project) {
                        await showProjectCommandPicker(project.path, project.name);
                    }
                    break;
                }
                case 'delete': {
                    manager.removeProject(msg.id);
                    postPanelState();
                    break;
                }
                case 'open': {
                    const project = manager.listProjects().find((p) => p.id === msg.id);
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
                    const provider = await vscode.window.showQuickPick(
                        [
                            { label: 'github', description: 'GitHub' },
                            { label: 'gitlab', description: 'GitLab' },
                            { label: 'azure', description: 'Azure DevOps' },
                        ],
                        { placeHolder: 'Select provider' }
                    );
                    if (!provider) break;

                    const browserProviders: Record<string, string> = {
                        github: 'github',
                        gitlab: 'gitlab',
                        azure: 'microsoft',
                    };
                    const authMethod = await vscode.window.showQuickPick(
                        [
                            {
                                label: 'browser',
                                description: 'Sign in via browser (OAuth) — recommended',
                            },
                            { label: 'ssh', description: 'Generate SSH key' },
                            { label: 'token', description: 'Enter personal access token manually' },
                        ],
                        { placeHolder: 'How do you want to authenticate?' }
                    );
                    if (!authMethod) break;

                    if (authMethod.label === 'browser') {
                        const vsCodeProviderId = browserProviders[provider.label];
                        const scopes: Record<string, string[]> = {
                            // Include 'workflow' on GitHub so the new account
                            // can push workflow files right away — no need
                            // to re-authenticate again when the user first
                            // tries to sync a repo that has .github/workflows.
                            github: ['repo', 'workflow', 'read:user', 'user:email'],
                            gitlab: ['read_user', 'api'],
                            microsoft: ['499b84ac-1321-427f-aa17-267ca6975798/.default'],
                        };
                        try {
                            const session = await vscode.authentication.getSession(
                                vsCodeProviderId,
                                scopes[vsCodeProviderId] || [],
                                { forceNewSession: true }
                            );
                            const username = session.account.label;
                            const token = session.accessToken;
                            let email: string | undefined;
                            let providerUserId: number | undefined;
                            try {
                                if (provider.label === 'github') {
                                    const res = await fetch('https://api.github.com/user', {
                                        headers: {
                                            Authorization: `Bearer ${token}`,
                                            'User-Agent': 'Ultraview-VSCode',
                                        },
                                    });
                                    if (res.ok) {
                                        const d = (await res.json()) as {
                                            id?: number;
                                            email?: string;
                                        };
                                        email = d.email || undefined;
                                        providerUserId = d.id;
                                    }
                                    if (!email) {
                                        const emailsRes = await fetch(
                                            'https://api.github.com/user/emails',
                                            {
                                                headers: {
                                                    Authorization: `Bearer ${token}`,
                                                    'User-Agent': 'Ultraview-VSCode',
                                                },
                                            }
                                        );
                                        if (emailsRes.ok) {
                                            const emailsData = (await emailsRes.json()) as {
                                                email: string;
                                                primary: boolean;
                                            }[];
                                            const primaryEmail = emailsData.find((e) => e.primary);
                                            if (primaryEmail) email = primaryEmail.email;
                                            else if (emailsData.length > 0)
                                                email = emailsData[0].email;
                                        }
                                    }
                                } else if (provider.label === 'gitlab') {
                                    const res = await fetch('https://gitlab.com/api/v4/user', {
                                        headers: { Authorization: `Bearer ${token}` },
                                    });
                                    if (res.ok) {
                                        const d = (await res.json()) as {
                                            id?: number;
                                            email?: string;
                                        };
                                        email = d.email || undefined;
                                        providerUserId = d.id;
                                    }
                                }
                            } catch {
                                /* email optional */
                            }
                            const account = accounts.addAccount({
                                provider: provider.label as GitProviderType,
                                username,
                                email,
                                providerUserId,
                                token,
                                authMethod: 'oauth' as AuthMethod,
                                lastValidatedAt: Date.now(),
                            });
                            // Auto-bind to current project
                            const activeRepo =
                                vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? '';
                            if (activeRepo) {
                                let project = manager.getProjectByPath(activeRepo);
                                if (!project)
                                    project = manager.addProject({
                                        name: nameFromPath(activeRepo),
                                        path: activeRepo,
                                    });
                                manager.setProjectAccount(project.id, account.id);
                                accounts.setLocalAccount(activeRepo, account.id);
                                await applyLocalAccount(activeRepo, account, token);
                            }
                            vscode.window.showInformationMessage(
                                `Signed in as ${username} via ${provider.label}!`
                            );
                            postPanelState();
                        } catch (err: any) {
                            if (String(err?.message).includes('No authentication provider')) {
                                vscode.window.showErrorMessage(
                                    `Browser sign-in for ${provider.label} requires the ${provider.label} extension. Use manual token instead.`
                                );
                            } else {
                                vscode.window.showErrorMessage(
                                    `OAuth sign-in failed: ${err?.message ?? String(err)}`
                                );
                            }
                        }
                        break;
                    }

                    const username = await vscode.window.showInputBox({
                        prompt: `${provider.label} username`,
                    });
                    if (!username) break;
                    const authMethodValue: AuthMethod =
                        authMethod.label === 'ssh'
                            ? 'ssh'
                            : authMethod.label === 'token'
                              ? 'pat'
                              : 'oauth';
                    const account = accounts.addAccount({
                        provider: provider.label as GitProviderType,
                        username,
                        authMethod: authMethodValue,
                    });
                    // Auto-bind to current project
                    const activeRepo = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? '';
                    if (activeRepo) {
                        let project = manager.getProjectByPath(activeRepo);
                        if (!project)
                            project = manager.addProject({
                                name: nameFromPath(activeRepo),
                                path: activeRepo,
                            });
                        manager.setProjectAccount(project.id, account.id);
                        accounts.setLocalAccount(activeRepo, account.id);
                        await applyLocalAccount(activeRepo, account, account.token);
                    }
                    if (authMethod.label === 'ssh') {
                        const keyName = await vscode.window.showInputBox({
                            prompt: 'SSH key name (optional)',
                            value: `ultraview-${username}`,
                        });
                        const key = await accounts.generateSshKey(
                            account.id,
                            account.provider,
                            keyName || undefined
                        );
                        const { sshKeyUrl } = accounts.getProviderUrl(account.provider);
                        await vscode.env.clipboard.writeText(key.publicKey);
                        vscode.window.showInformationMessage(
                            `SSH key generated and copied to clipboard! Opening ${account.provider} settings...`
                        );
                        vscode.env.openExternal(vscode.Uri.parse(sshKeyUrl));
                        accounts.updateAccount(account.id, { sshKeyId: key.id });
                    } else if (authMethod.label === 'token') {
                        const token = await vscode.window.showInputBox({
                            prompt: 'Enter personal access token (with repo scope)',
                            password: true,
                        });
                        if (token) {
                            accounts.updateAccount(account.id, { token });
                        }
                    }
                    postPanelState();
                    break;
                }
                case 'switchAccount': {
                    const accountId = msg.accountId;
                    const activeRepo = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? '';
                    if (!activeRepo) {
                        vscode.window.showWarningMessage(
                            'No workspace open. Open a project first.'
                        );
                        break;
                    }
                    let project = manager.getProjectByPath(activeRepo);
                    if (!project) {
                        project = manager.addProject({
                            name: nameFromPath(activeRepo),
                            path: activeRepo,
                        });
                    }
                    manager.setProjectAccount(project.id, accountId);
                    accounts.setLocalAccount(activeRepo, accountId);
                    const acc = await accounts.getAccountWithToken(accountId);
                    if (acc) {
                        await applyLocalAccount(activeRepo, acc, acc.token);
                        vscode.window.showInformationMessage(
                            `✓ Switched to ${acc.username} for this project.`
                        );
                    }
                    postPanelState();
                    break;
                }
                case 'removeAccount': {
                    const accountId = msg.accountId;
                    if (accountId) {
                        const keys = accounts
                            .listSshKeys()
                            .filter((k) => k.accountId === accountId);
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
                    const supportsBrowser =
                        account.provider === 'github' ||
                        account.provider === 'gitlab' ||
                        account.provider === 'azure';
                    const option = await vscode.window.showQuickPick(
                        [
                            ...(supportsBrowser
                                ? [
                                    {
                                        label: '$(refresh) Re-authenticate via Browser',
                                        description:
                                            account.authMethod === 'oauth'
                                                ? 'Refresh OAuth token (adds new scopes like workflow)'
                                                : 'Switch to browser OAuth sign-in',
                                    },
                                ]
                                : []),
                            {
                                label: '$(key) Manage SSH Key',
                                description: 'Generate and configure SSH key',
                            },
                            {
                                label: '$(key) Manage Token',
                                description: 'Add or update personal access token',
                            },
                        ],
                        { placeHolder: `Manage Auth for ${account.username}` }
                    );
                    if (option?.label.includes('Re-authenticate')) {
                        // Run the same OAuth flow the standalone reAuthAccount
                        // handler uses, but with the FULL scope set (incl.
                        // 'workflow' on GitHub) so the new token can actually
                        // push workflow files. Mirrors GitProvider._reAuthOAuth.
                        const browserProviders: Record<string, string> = {
                            github: 'github',
                            gitlab: 'gitlab',
                            azure: 'microsoft',
                        };
                        const vsCodeProviderId = browserProviders[account.provider];
                        const scopes: Record<string, string[]> = {
                            github: ['repo', 'workflow', 'read:user', 'user:email'],
                            gitlab: ['read_user', 'api'],
                            microsoft: ['499b84ac-1321-427f-aa17-267ca6975798/.default'],
                        };
                        try {
                            const session = await vscode.authentication.getSession(
                                vsCodeProviderId,
                                scopes[vsCodeProviderId] || [],
                                { forceNewSession: true }
                            );
                            accounts.updateAccount(accountId, {
                                token: session.accessToken,
                                lastValidatedAt: Date.now(),
                                authMethod: 'oauth',
                            });
                            vscode.window.showInformationMessage(
                                `✓ Re-authenticated successfully with full scopes.`
                            );
                            postPanelState();
                        } catch (err: any) {
                            vscode.window.showErrorMessage(
                                `Re-auth failed: ${err?.message ?? String(err)}`
                            );
                        }
                    } else if (option?.label.includes('SSH')) {
                        await GitProvider._handleGenerateSshKey(
                            accountId,
                            panel.webview,
                            accounts,
                            postPanelState
                        );
                    } else if (option?.label.includes('Token')) {
                        await GitProvider._handleAddToken(accountId, panel.webview, accounts);
                    }
                    break;
                }
                case 'reAuthAccount': {
                    const accountId = msg.accountId;
                    const account = accounts.getAccount(accountId);
                    if (!account) break;
                    const browserProviders: Record<string, string> = {
                        github: 'github',
                        gitlab: 'gitlab',
                        azure: 'microsoft',
                    };
                    const vsCodeProviderId = browserProviders[account.provider];
                    const scopes: Record<string, string[]> = {
                        // Include 'workflow' on GitHub so the fresh token can
                        // actually push workflow files (and the user doesn't
                        // get hit by the "refusing workflow scope" error
                        // again immediately after re-authenticating).
                        github: ['repo', 'workflow', 'read:user', 'user:email'],
                        gitlab: ['read_user', 'api'],
                        microsoft: ['499b84ac-1321-427f-aa17-267ca6975798/.default'],
                    };
                    try {
                        const session = await vscode.authentication.getSession(
                            vsCodeProviderId,
                            scopes[vsCodeProviderId] || [],
                            { forceNewSession: true }
                        );
                        accounts.updateAccount(accountId, {
                            token: session.accessToken,
                            lastValidatedAt: Date.now(),
                            authMethod: 'oauth',
                        });
                        vscode.window.showInformationMessage(`✓ Re-authenticated successfully.`);
                        postPanelState();
                    } catch (err: any) {
                        vscode.window.showErrorMessage(
                            `Re-auth failed: ${err?.message ?? String(err)}`
                        );
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
                case 'refreshSingleProject': {
                    const project = manager.listProjects().find((p) => p.id === msg.id);
                    if (project) {
                        console.log(`[Ultraview] panel refreshSingleProject: ${project.name}`);
                        // postPanelState always does a fresh fetch for all
                        // projects, so this just kicks a re-render.
                        try {
                            await postPanelState();
                        } catch (e) {
                            console.warn(`[Ultraview] panel refresh failed for ${project.name}:`, e);
                        }
                    }
                    break;
                }
                case 'gitPull': {
                    const project = manager.listProjects().find((p) => p.id === msg.id);
                    if (project) {
                        try {
                            const result = await runExclusiveProjectGitOp(project.path, () =>
                                gitPull(project.path)
                            );
                            vscode.window.showInformationMessage(`✓ ${project.name}: ${result}`);
                        } catch (err: any) {
                            vscode.window.showErrorMessage(
                                `Pull failed for ${project.name}: ${err.message}`
                            );
                        }
                        try {
                            await postPanelState();
                        } finally {
                            notifyGitOpDone(panel.webview, project.id);
                        }
                    }
                    break;
                }
                case 'gitPush': {
                    const project = manager.listProjects().find((p) => p.id === msg.id);
                    if (project) {
                        let pushSucceeded = false;
                        try {
                            const result = await runExclusiveProjectGitOp(project.path, () =>
                                gitPush(project.path, msg.commitMsg)
                            );
                            pushSucceeded = true;
                            vscode.window.showInformationMessage(`✓ ${project.name}: ${result}`);
                        } catch (err: any) {
                            vscode.window.showErrorMessage(
                                `Push failed for ${project.name}: ${err.message}`
                            );
                        }
                        try {
                            if (pushSucceeded) await postPanelState(project.id, true);
                            else void postPanelState();
                        } finally {
                            notifyGitOpDone(panel.webview, project.id);
                        }
                    }
                    break;
                }
                case 'gitSync': {
                    const project = manager.listProjects().find((p) => p.id === msg.id);
                    if (project) {
                        let syncSucceeded = false;
                        const syncAccount = project.accountId
                            ? await accounts.getAccountWithToken(project.accountId)
                            : undefined;
                        const syncAuth = authContextFromAccount(syncAccount);
                        try {
                            await runExclusiveProjectGitOp(project.path, async () => {
                                try {
                                    await gitSyncAll(
                                        project.path,
                                        msg.commitMsg,
                                        project.repoUrl,
                                        syncAuth
                                    );
                                    syncSucceeded = true;
                                } catch (err: any) {
                                    if (err?.code !== 'NO_REMOTE') throw err;
                                    const picked = await promptAndAddRemotePanel(
                                        project.path, project.id
                                    );
                                    if (picked) {
                                        await gitSyncAll(
                                            project.path,
                                            msg.commitMsg,
                                            picked,
                                            syncAuth
                                        );
                                        syncSucceeded = true;
                                    }
                                }
                            });
                        } catch (err: any) {
                            vscode.window.showErrorMessage(
                                `Sync failed for ${project.name}: ${err?.message ?? String(err)}`
                            );
                        }
                        try {
                            if (syncSucceeded) await postPanelState(project.id, true);
                            else void postPanelState();
                        } finally {
                            notifyGitOpDone(panel.webview, project.id);
                        }
                    }
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

        const profile = this.manager.addProfile({
            name,
            userName: userName || undefined,
            userEmail: userEmail || undefined,
        });
        this.postState();
    }

    private async _editProfile(profile: GitProfile): Promise<void> {
        const name = await vscode.window.showInputBox({
            prompt: 'Profile name',
            value: profile.name,
        });
        if (name === undefined) return;

        const userName = await vscode.window.showInputBox({
            prompt: 'Git user name (optional)',
            value: profile.userName || '',
        });
        const userEmail = await vscode.window.showInputBox({
            prompt: 'Git user email (optional)',
            value: profile.userEmail || '',
        });

        const profiles = this.manager.listProfiles();
        const idx = profiles.findIndex((p) => p.id === profile.id);
        if (idx >= 0) {
            profiles[idx] = {
                ...profiles[idx],
                name,
                userName: userName || undefined,
                userEmail: userEmail || undefined,
            };
            this.manager.saveProfiles(profiles);
            this.postState();
        }
    }

    static async _handleGenerateSshKey(
        accountId: string,
        webview: vscode.Webview | undefined,
        activeAccs: GitAccounts,
        postStateCb?: () => void
    ) {
        const account = activeAccs.getAccount(accountId);
        if (!account) return;
        const keyName = await vscode.window.showInputBox({
            prompt: 'SSH key name (optional)',
            value: `ultraview-${account.username}`,
        });
        const key = await activeAccs.generateSshKey(
            accountId,
            account.provider,
            keyName || undefined
        );
        const { sshKeyUrl } = activeAccs.getProviderUrl(account.provider);
        await vscode.env.clipboard.writeText(key.publicKey);
        vscode.window.showInformationMessage(
            `SSH key generated and copied to clipboard! Opening ${account.provider} settings...`
        );
        vscode.env.openExternal(vscode.Uri.parse(sshKeyUrl));
        if (postStateCb) postStateCb();
        webview?.postMessage({ type: 'sshKeyGenerated', key, accountId });
    }

    static async _handleAddToken(
        accountId: string,
        webview: vscode.Webview | undefined,
        activeAccs: GitAccounts
    ) {
        const acct = activeAccs.getAccount(accountId);
        if (!acct) return;

        if (acct.provider === 'github') {
            const method = await vscode.window.showQuickPick(
                [
                    { label: 'browser', description: 'Sign in via browser (OAuth)' },
                    { label: 'manual', description: 'Paste personal access token' },
                ],
                { placeHolder: 'How to add token?' }
            );
            if (!method) return;
            if (method.label === 'browser') {
                try {
                    const session = await vscode.authentication.getSession(
                        'github',
                        // Include 'workflow' so the new token can push
                        // workflow files immediately, no follow-up
                        // re-auth needed.
                        ['repo', 'workflow', 'read:user', 'user:email'],
                        { forceNewSession: true }
                    );
                    activeAccs.updateAccount(accountId, {
                        token: session.accessToken,
                        authMethod: 'oauth',
                        lastValidatedAt: Date.now(),
                    });
                    webview?.postMessage({ type: 'accountUpdated', accountId });
                    vscode.window.showInformationMessage(
                        `Token updated for ${acct.username} via GitHub OAuth (full scopes).`
                    );
                } catch (err: any) {
                    vscode.window.showErrorMessage(`OAuth failed: ${err?.message ?? String(err)}`);
                }
                return;
            }
        }

        const token = await vscode.window.showInputBox({
            prompt: 'Enter personal access token (with repo + workflow scope)',
            password: true,
        });
        if (token) {
            activeAccs.updateAccount(accountId, { token });
            webview?.postMessage({ type: 'accountUpdated', accountId });
        }
    }

    static async _handleAddRepo(
        webview: vscode.Webview,
        manager: GitProjects,
        accounts: GitAccounts,
        postStateCb: () => void
    ) {
        const activeRepo = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? '';
        const activeAcc = activeRepo ? accounts.getLocalAccount(activeRepo) : undefined;
        if (!activeAcc) {
            vscode.window.showErrorMessage(
                'No active Git account. Please add/select an account first.'
            );
            return;
        }
        const accWithToken = await accounts.getAccountWithToken(activeAcc.id);
        if (!accWithToken || !accWithToken.token) {
            vscode.window.showErrorMessage(
                `Account ${activeAcc.username} has no token. Please authenticate first.`
            );
            return;
        }

        let repos: { name: string; url: string; private: boolean }[] = [];
        try {
            if (activeAcc.provider === 'github') {
                const res = await fetch(
                    'https://api.github.com/user/repos?per_page=100&sort=updated',
                    {
                        headers: {
                            Authorization: `Bearer ${accWithToken.token}`,
                            'User-Agent': 'Ultraview-VSCode',
                        },
                    }
                );
                if (!res.ok) throw new Error('GitHub API error');
                const data = (await res.json()) as any[];
                repos = data.map((r) => ({
                    name: r.full_name,
                    url: r.clone_url,
                    private: r.private,
                }));
            } else if (activeAcc.provider === 'gitlab') {
                const res = await fetch(
                    'https://gitlab.com/api/v4/projects?membership=true&simple=true&per_page=100&order_by=updated_at',
                    {
                        headers: { Authorization: `Bearer ${accWithToken.token}` },
                    }
                );
                if (!res.ok) throw new Error('GitLab API error');
                const data = (await res.json()) as any[];
                repos = data.map((r) => ({
                    name: r.path_with_namespace,
                    url: r.http_url_to_repo,
                    private: r.visibility === 'private' || r.visibility === 'internal',
                }));
            } else {
                vscode.window.showInformationMessage(
                    'Fetching repos is currently only supported for GitHub and GitLab.'
                );
            }
        } catch (err: any) {
            vscode.window.showErrorMessage(`Failed to fetch repos: ${err.message}`);
            return;
        }

        if (repos.length === 0) {
            const manualUrl = await vscode.window.showInputBox({
                prompt: 'No repos found. Enter a clone URL manually',
            });
            if (!manualUrl) return;
            repos.push({
                name: manualUrl.split('/').pop()?.replace('.git', '') || manualUrl,
                url: manualUrl,
                private: false,
            });
        }

        const CREATE_NEW = '__create_new__';
        const CLONE_URL = '__clone_url__';
        const items: {
            label: string;
            description?: string;
            url?: string;
            name?: string;
            kind?: vscode.QuickPickItemKind;
        }[] = [
            {
                label: '$(add) Create new repo…',
                description: 'Create a brand-new repository on ' + activeAcc.provider,
                url: CREATE_NEW,
                name: CREATE_NEW,
            },
            {
                label: '$(cloud-download) Clone from URL…',
                description: 'Paste any git URL to clone and set up',
                url: CLONE_URL,
                name: CLONE_URL,
            },
            { label: '', kind: vscode.QuickPickItemKind.Separator },
            ...repos.map((r) => ({
                label: `$(repo) ${r.name}`,
                description: r.private ? 'Private' : 'Public',
                url: r.url,
                name: r.name,
            })),
        ];
        const selected = await vscode.window.showQuickPick(items, {
            placeHolder: 'Select a repository to clone',
            matchOnDescription: true,
        });
        if (!selected) return;

        // ── Create new repo branch ────────────────────────────────────────────
        if (selected.url === CREATE_NEW) {
            if (accWithToken.provider !== 'github' && accWithToken.provider !== 'gitlab') {
                vscode.window.showInformationMessage(
                    'Creating repos is currently supported for GitHub and GitLab only.'
                );
                return;
            }

            const newName = await vscode.window.showInputBox({
                prompt: 'New repository name',
                placeHolder: 'my-project',
                validateInput: (v) => (v && v.trim() ? undefined : 'Repository name is required'),
            });
            if (!newName) return;
            const safeName = newName.trim().replace(/\s+/g, '-');

            const visibilityPick = await vscode.window.showQuickPick(
                [
                    {
                        label: '$(unlock) Public',
                        description: 'Anyone can see this repository',
                        isPrivate: false,
                    },
                    {
                        label: '$(lock) Private',
                        description: 'Only you and collaborators can see this repository',
                        isPrivate: true,
                    },
                ],
                { placeHolder: 'Repository visibility' }
            );
            if (!visibilityPick) return;
            const isPrivate = (visibilityPick as any).isPrivate as boolean;

            const newDestUri = await vscode.window.showOpenDialog({
                canSelectFolders: true,
                canSelectFiles: false,
                openLabel: 'Select parent folder for new repo',
            });
            if (!newDestUri || !newDestUri[0]) return;
            const newDestPath = newDestUri[0].fsPath;
            const nodePath = require('path') as typeof import('path');
            const nodeFs = require('fs') as typeof import('fs');
            const fullPath = nodePath.join(newDestPath, safeName);

            await vscode.window.withProgress(
                {
                    location: vscode.ProgressLocation.Notification,
                    title: `Creating ${safeName}...`,
                    cancellable: false,
                },
                async () => {
                    const execAsync = require('util').promisify(require('child_process').exec);
                    const run = (cmd: string) =>
                        execAsync(cmd, { cwd: fullPath, env: process.env });
                    try {
                        let cloneUrl = '';
                        if (accWithToken.provider === 'github') {
                            const res = await fetch('https://api.github.com/user/repos', {
                                method: 'POST',
                                headers: {
                                    Authorization: `Bearer ${accWithToken.token}`,
                                    'User-Agent': 'Ultraview-VSCode',
                                    'Content-Type': 'application/json',
                                },
                                body: JSON.stringify({
                                    name: safeName,
                                    private: isPrivate,
                                    auto_init: false,
                                }),
                            });
                            if (!res.ok) {
                                const e = (await res.json()) as any;
                                throw new Error(e.message || `GitHub API ${res.status}`);
                            }
                            cloneUrl = ((await res.json()) as any).clone_url;
                        } else {
                            const res = await fetch('https://gitlab.com/api/v4/projects', {
                                method: 'POST',
                                headers: {
                                    Authorization: `Bearer ${accWithToken.token}`,
                                    'Content-Type': 'application/json',
                                },
                                body: JSON.stringify({
                                    name: safeName,
                                    path: safeName,
                                    visibility: isPrivate ? 'private' : 'public',
                                }),
                            });
                            if (!res.ok) {
                                const e = (await res.json()) as any;
                                throw new Error(
                                    Array.isArray(e.message)
                                        ? e.message.join(', ')
                                        : e.message || `GitLab API ${res.status}`
                                );
                            }
                            cloneUrl = ((await res.json()) as any).http_url_to_repo;
                        }

                        if (!nodeFs.existsSync(fullPath)) {
                            nodeFs.mkdirSync(fullPath, { recursive: true });
                        }
                        await run('git init');
                        await run('git checkout -b main').catch(() =>
                            run('git checkout -b master')
                        );
                        nodeFs.writeFileSync(
                            nodePath.join(fullPath, 'README.md'),
                            `# ${safeName}\n`
                        );
                        await run('git add .');
                        const noReplyHost =
                            accWithToken.provider === 'github'
                                ? 'users.noreply.github.com'
                                : 'users.noreply.gitlab.com';
                        const noReplyPrefix = accWithToken.providerUserId
                            ? `${accWithToken.providerUserId}+${accWithToken.username}`
                            : accWithToken.username;
                        const userEmail = accWithToken.email || `${noReplyPrefix}@${noReplyHost}`;
                        await run(`git config user.name "${accWithToken.username}"`);
                        await run(`git config user.email "${userEmail}"`);
                        await run('git commit -m "Initial commit"');

                        // Embed credentials in remote URL — most reliable auth method on Windows
                        const credCloneUrl = cloneUrl.replace(
                            'https://',
                            `https://${accWithToken.username}:${accWithToken.token}@`
                        );
                        await run(`git remote add origin "${credCloneUrl}"`);

                        // Register project, set identity and re-embed creds via applyLocalAccount
                        manager.addProject({
                            name: safeName,
                            path: fullPath,
                            accountId: activeAcc.id,
                            repoUrl: cloneUrl,
                            lastOpened: Date.now(),
                        });
                        accounts.setLocalAccount(fullPath, activeAcc.id);
                        await applyLocalAccount(fullPath, accWithToken, accWithToken.token!);
                        postStateCb();

                        try {
                            await run('git push -u origin HEAD');
                            const open = await vscode.window.showInformationMessage(
                                `✓ Created and pushed ${safeName}`,
                                'Open Folder',
                                'Open in New Window'
                            );
                            if (open === 'Open Folder') {
                                vscode.commands.executeCommand(
                                    'vscode.openFolder',
                                    vscode.Uri.file(fullPath)
                                );
                            } else if (open === 'Open in New Window') {
                                vscode.commands.executeCommand(
                                    'vscode.openFolder',
                                    vscode.Uri.file(fullPath),
                                    { forceNewWindow: true }
                                );
                            }
                        } catch (pushErr: any) {
                            const open = await vscode.window.showWarningMessage(
                                `Repo created but push failed: ${pushErr.message}`,
                                'Open Folder',
                                'Open in New Window'
                            );
                            if (open === 'Open Folder') {
                                vscode.commands.executeCommand(
                                    'vscode.openFolder',
                                    vscode.Uri.file(fullPath)
                                );
                            } else if (open === 'Open in New Window') {
                                vscode.commands.executeCommand(
                                    'vscode.openFolder',
                                    vscode.Uri.file(fullPath),
                                    { forceNewWindow: true }
                                );
                            }
                        }
                    } catch (err: any) {
                        vscode.window.showErrorMessage(`Failed to create repo: ${err.message}`);
                    }
                }
            );
            return;
        }

        // ── Clone from URL branch ────────────────────────────────────────────
        if (selected.url === CLONE_URL) {
            const cloneUrlInput = await vscode.window.showInputBox({
                prompt: 'Git repository URL to clone from',
                placeHolder: 'https://github.com/owner/repo.git',
                validateInput: (v) => (v && v.trim() ? undefined : 'URL is required'),
            });
            if (!cloneUrlInput) return;
            const rawUrl = cloneUrlInput.trim();

            const defaultName =
                rawUrl
                    .split('/')
                    .pop()
                    ?.replace(/\.git$/, '') || 'repo';
            const cloneName = await vscode.window.showInputBox({
                prompt: 'New repository name (will be created on ' + accWithToken.provider + ')',
                value: defaultName,
                validateInput: (v) => (v && v.trim() ? undefined : 'Name is required'),
            });
            if (!cloneName) return;
            const safeCloneName = cloneName.trim().replace(/\s+/g, '-');

            const cloneVisibility = await vscode.window.showQuickPick(
                [
                    {
                        label: '$(unlock) Public',
                        description: 'Anyone can see this repository',
                        isPrivate: false,
                    },
                    {
                        label: '$(lock) Private',
                        description: 'Only you and collaborators can see this repository',
                        isPrivate: true,
                    },
                ],
                { placeHolder: 'Repository visibility on ' + accWithToken.provider }
            );
            if (!cloneVisibility) return;
            const cloneIsPrivate = (cloneVisibility as any).isPrivate as boolean;

            const cloneDestUri = await vscode.window.showOpenDialog({
                canSelectFolders: true,
                canSelectFiles: false,
                openLabel: 'Select parent folder for cloned repo',
            });
            if (!cloneDestUri || !cloneDestUri[0]) return;
            const cloneDestPath = cloneDestUri[0].fsPath;
            const cloneFullPath = require('path').join(cloneDestPath, safeCloneName);

            if (require('fs').existsSync(cloneFullPath)) {
                vscode.window.showErrorMessage(
                    `The destination already exists: ${cloneFullPath}. Choose a different repository name or remove the leftover folder before retrying.`
                );
                return;
            }

            if (accWithToken.provider !== 'github' && accWithToken.provider !== 'gitlab') {
                vscode.window.showInformationMessage(
                    'Creating repos is currently supported for GitHub and GitLab only.'
                );
                return;
            }

            await vscode.window.withProgress(
                {
                    location: vscode.ProgressLocation.Notification,
                    title: `Cloning and forking ${safeCloneName}…`,
                    cancellable: false,
                },
                async () => {
                    const execAsync = require('util').promisify(require('child_process').exec);
                    const run = (cmd: string) =>
                        execAsync(cmd, { cwd: cloneFullPath, env: process.env });
                    try {
                        // ── 1. Clone source repo ──────────────────────────────────────
                        let cloned = false;
                        if (accWithToken.token) {
                            try {
                                const b64 = Buffer.from(
                                    `${accWithToken.username}:${accWithToken.token}`
                                ).toString('base64');
                                await execAsync(
                                    `git -c http.extraHeader="Authorization: Basic ${b64}" clone --no-tags --recurse-submodules "${rawUrl}" "${safeCloneName}"`,
                                    { cwd: cloneDestPath, env: process.env }
                                );
                                cloned = true;
                            } catch {
                                /* fall through */
                            }
                        }
                        if (!cloned) {
                            await execAsync(`git clone --no-tags --recurse-submodules "${rawUrl}" "${safeCloneName}"`, {
                                cwd: cloneDestPath,
                                env: process.env,
                            });
                        }

                        // ── 1b. Start fresh without deleting .git ────────────────────
                        // Deleting a freshly cloned .git directory is unreliable on
                        // Windows because Git, antivirus, or an indexer may still have
                        // a handle open inside it. An orphan branch gives the imported
                        // files a new root commit without exposing the source history.
                        const importBranch = `__ultraview_import_${process.pid}_${Date.now()}`;
                        await run(`git checkout --orphan "${importBranch}"`);
                        const noReplyHost2 =
                            accWithToken.provider === 'github'
                                ? 'users.noreply.github.com'
                                : 'users.noreply.gitlab.com';
                        const noReplyPrefix2 = accWithToken.providerUserId
                            ? `${accWithToken.providerUserId}+${accWithToken.username}`
                            : accWithToken.username;
                        const userEmail2 =
                            accWithToken.email || `${noReplyPrefix2}@${noReplyHost2}`;
                        await execAsync(`git config user.name "${accWithToken.username}"`, {
                            cwd: cloneFullPath,
                            env: process.env,
                        });
                        await execAsync(`git config user.email "${userEmail2}"`, {
                            cwd: cloneFullPath,
                            env: process.env,
                        });
                        await execAsync('git add .', { cwd: cloneFullPath, env: process.env });
                        await execAsync('git commit -m "Initial commit"', {
                            cwd: cloneFullPath,
                            env: process.env,
                        });
                        await run('git branch -M main');
                        // Remove the source URL and its remote-tracking refs. The old
                        // objects are now unreachable and will be pruned by Git.
                        await run('git remote remove origin');

                        // ── 2. Create new remote repo on provider ─────────────────────
                        let newRemoteUrl = '';
                        if (accWithToken.provider === 'github') {
                            const res = await fetch('https://api.github.com/user/repos', {
                                method: 'POST',
                                headers: {
                                    Authorization: `Bearer ${accWithToken.token}`,
                                    'User-Agent': 'Ultraview-VSCode',
                                    'Content-Type': 'application/json',
                                },
                                body: JSON.stringify({
                                    name: safeCloneName,
                                    private: cloneIsPrivate,
                                    auto_init: false,
                                }),
                            });
                            if (!res.ok) {
                                const e = (await res.json()) as any;
                                throw new Error(e.message || `GitHub API ${res.status}`);
                            }
                            newRemoteUrl = ((await res.json()) as any).clone_url;
                        } else {
                            const res = await fetch('https://gitlab.com/api/v4/projects', {
                                method: 'POST',
                                headers: {
                                    Authorization: `Bearer ${accWithToken.token}`,
                                    'Content-Type': 'application/json',
                                },
                                body: JSON.stringify({
                                    name: safeCloneName,
                                    path: safeCloneName,
                                    visibility: cloneIsPrivate ? 'private' : 'public',
                                }),
                            });
                            if (!res.ok) {
                                const e = (await res.json()) as any;
                                throw new Error(
                                    Array.isArray(e.message)
                                        ? e.message.join(', ')
                                        : e.message || `GitLab API ${res.status}`
                                );
                            }
                            newRemoteUrl = ((await res.json()) as any).http_url_to_repo;
                        }

                        // ── 3. Add origin and push ────────────────────────────────────
                        // Embed credentials in remote URL — most reliable auth method on Windows
                        const credRemoteUrl = newRemoteUrl.replace(
                            'https://',
                            `https://${accWithToken.username}:${accWithToken.token}@`
                        );
                        await run(`git remote add origin "${credRemoteUrl}"`);

                        // ── 4. Register project, set identity, re-embed creds ────────
                        manager.addProject({
                            name: safeCloneName,
                            path: cloneFullPath,
                            accountId: activeAcc.id,
                            repoUrl: newRemoteUrl,
                            lastOpened: Date.now(),
                        });
                        accounts.setLocalAccount(cloneFullPath, activeAcc.id);
                        await applyLocalAccount(cloneFullPath, accWithToken, accWithToken.token!);
                        postStateCb();

                        const doPush = async (): Promise<string> => {
                            try {
                                await run('git push -u origin HEAD');
                                return 'ok';
                            } catch (pushErr: any) {
                                const msg: string = pushErr.message || '';
                                // Token lacks `workflow` scope — strip .github/workflows and retry once
                                if (msg.includes('workflow') && msg.includes('scope')) {
                                    const wfDir = require('path').join(
                                        cloneFullPath,
                                        '.github',
                                        'workflows'
                                    );
                                    if (require('fs').existsSync(wfDir)) {
                                        require('fs').rmSync(wfDir, {
                                            recursive: true,
                                            force: true,
                                        });
                                    }
                                    // Also strip the whole .github dir if it only contained workflows
                                    try {
                                        await run('git add -A');
                                        await run('git commit --amend --no-edit');
                                    } catch {
                                        /* nothing changed — fine */
                                    }
                                    await run('git push -u origin HEAD');
                                    return 'no-workflow';
                                }
                                throw pushErr;
                            }
                        };

                        try {
                            const pushResult = await doPush();
                            const msg =
                                pushResult === 'no-workflow'
                                    ? `✓ Cloned and pushed ${safeCloneName} (.github/workflows excluded — token lacks workflow scope)`
                                    : `✓ Cloned, created ${safeCloneName} on ${accWithToken.provider}, and pushed`;
                            const open = await vscode.window.showInformationMessage(
                                msg,
                                'Open Folder',
                                'Open in New Window'
                            );
                            if (open === 'Open Folder') {
                                vscode.commands.executeCommand(
                                    'vscode.openFolder',
                                    vscode.Uri.file(cloneFullPath)
                                );
                            } else if (open === 'Open in New Window') {
                                vscode.commands.executeCommand(
                                    'vscode.openFolder',
                                    vscode.Uri.file(cloneFullPath),
                                    { forceNewWindow: true }
                                );
                            }
                        } catch (pushErr: any) {
                            const open = await vscode.window.showWarningMessage(
                                `Repo cloned and created, but push failed: ${pushErr.message}`,
                                'Open Folder',
                                'Open in New Window'
                            );
                            if (open === 'Open Folder') {
                                vscode.commands.executeCommand(
                                    'vscode.openFolder',
                                    vscode.Uri.file(cloneFullPath)
                                );
                            } else if (open === 'Open in New Window') {
                                vscode.commands.executeCommand(
                                    'vscode.openFolder',
                                    vscode.Uri.file(cloneFullPath),
                                    { forceNewWindow: true }
                                );
                            }
                        }
                    } catch (err: any) {
                        vscode.window.showErrorMessage(`Failed: ${err.message}`);
                    }
                }
            );
            return;
        }

        const destUri = await vscode.window.showOpenDialog({
            canSelectFolders: true,
            canSelectFiles: false,
            openLabel: 'Select clone destination folder',
        });
        if (!destUri || !destUri[0]) return;
        const destPath = destUri[0].fsPath;

        const repoName = (selected.name ?? '').split('/').pop()?.replace('.git', '') || 'repo';
        const fullPath = require('path').join(destPath, repoName);

        await vscode.window.withProgress(
            {
                location: vscode.ProgressLocation.Notification,
                title: `Cloning ${selected.name ?? repoName}...`,
            },
            async () => {
                const execAsync = require('util').promisify(require('child_process').exec);
                try {
                    const urlObj = new URL(selected.url!);
                    urlObj.username = accWithToken.username;
                    urlObj.password = accWithToken.token!;
                    const cloneUrl = urlObj.toString();

                    await execAsync(`git clone --recurse-submodules "${cloneUrl}" "${repoName}"`, { cwd: destPath });

                    const project = manager.addProject({
                        name: repoName,
                        path: fullPath,
                        accountId: activeAcc.id,
                    });

                    accounts.setLocalAccount(fullPath, activeAcc.id);
                    await applyLocalAccount(fullPath, accWithToken, accWithToken.token!);

                    postStateCb();
                    vscode.window.showInformationMessage(
                        `Successfully cloned and added ${selected.name}`
                    );
                } catch (err: any) {
                    vscode.window.showErrorMessage(`Failed to clone: ${err.message}`);
                }
            }
        );
    }
}

function nameFromPath(p: string) {
    const parts = p.replace(/\\/g, '/').split('/');
    return parts[parts.length - 1] || p;
}
