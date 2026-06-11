import * as vscode from 'vscode';
import * as childProcess from 'child_process';
import * as util from 'util';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { buildGitHtml } from '../git/gitUi';
import { GitProjects } from '../git/gitProjects';
import { GitAccounts } from '../git/gitAccounts';
import { GitProfile, GitProvider as GitProviderType, AuthMethod } from '../git/types';
import { applyLocalAccount, clearLocalAccount, getRemoteUrl } from '../git/gitCredentials';
import { SharedStore } from '../sync/sharedStore';
import { getS3Credentials } from '../s3backup';
import { ProjectCommand, scanCommands } from '../commands/commandScanner';

interface GitStatus {
    isGitRepo: boolean;
    localChanges: number; // uncommitted + staged
    ahead: number; // commits ahead of remote
    behind: number; // commits behind remote
    branch: string;
}

type GitConflictStrategy = 'ours' | 'theirs';
type GitCommandRunner = (cmd: string) => Promise<{ stdout: string; stderr: string }>;
const projectGitOpLocks = new Set<string>();

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
    try {
        return await op();
    } finally {
        projectGitOpLocks.delete(key);
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

    runScannedCommandInTerminal(picked.command);
}

function runScannedCommandInTerminal(command: ProjectCommand): void {
    const terminal = vscode.window.createTerminal({
        name: getScannedCommandTerminalName(command),
        cwd: command.cwd,
    });

    terminal.show(true);
    terminal.sendText(command.runCmd);
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
function createGitRunner(projectPath: string, timeout: number = 30000): GitCommandRunner {
    return (cmd: string) =>
        new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
            childProcess.execFile(
                'git',
                parseGitArgs(cmd),
                { cwd: projectPath, env: process.env, timeout, maxBuffer: 10 * 1024 * 1024 },
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
        if (fs.existsSync(lockFile)) {
            fs.unlinkSync(lockFile);
        }
    } catch {
        /* ignore – lock may be legitimately held */
    }
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
        await run('git add -A');
    } catch (err: any) {
        if (/index\.lock|another git process/i.test(err?.stderr ?? err?.message ?? '')) {
            clearIndexLock(projectPath);
            try {
                await run('git add -A');
            } catch {
                await tryGit(run, 'git add --ignore-errors -A');
            }
        } else {
            await tryGit(run, 'git add --ignore-errors -A');
        }
    }

    return hasStagedChanges(run);
}

async function commitStagedChanges(run: GitCommandRunner, tmpFile: string): Promise<void> {
    const commitFile = `"${tmpFile.replace(/\\/g, '/')}"`;
    try {
        await run(`git commit -F ${commitFile}`);
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

    const abortSteps: Array<{ label: string; cmd: string }> = [
        { label: 'merge', cmd: 'git merge --abort' },
        { label: 'rebase', cmd: 'git rebase --abort' },
        { label: 'cherry-pick', cmd: 'git cherry-pick --abort' },
        { label: 'revert', cmd: 'git revert --abort' },
    ];

    for (const step of abortSteps) {
        if (await tryGit(run, step.cmd)) {
            notes.push(`aborted stale ${step.label}`);
        }
    }

    await tryGit(run, 'git reset --merge');

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
    strategy: GitConflictStrategy
): Promise<string[]> {
    const run = createGitRunner(projectPath);
    const notes: string[] = [];

    await run(`git fetch --quiet origin ${branch}`);

    try {
        const { stdout, stderr } = await run(`git merge --no-edit -X ${strategy} origin/${branch}`);
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
        await run(`git checkout --${strategy} -- .`);
        await run('git add -A');

        const remaining = await listUnmergedFiles(run);
        if (remaining.length) {
            throw new Error(
                `Repository still has unmerged files after auto-resolution: ${remaining.join(', ')}`
            );
        }

        await run('git commit --no-edit');
        notes.push(
            `auto-resolved ${unmerged.length} conflicted file(s) using ${strategyLabel(strategy)} changes${backupBranch ? ` (backup: ${backupBranch})` : ''}`
        );
        return notes;
    }
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
        await run('git rev-parse --is-inside-work-tree');
    } catch {
        return empty;
    }

    const status: GitStatus = {
        isGitRepo: true,
        localChanges: 0,
        ahead: prevStatus?.ahead ?? 0,
        behind: prevStatus?.behind ?? 0,
        branch: prevStatus?.branch ?? '',
    };

    try {
        const { stdout: branchOut } = await run('git branch --show-current');
        status.branch = branchOut.trim();
    } catch { /* detached HEAD */ }

    try {
        const { stdout: statusOut } = await run('git status --porcelain');
        status.localChanges = statusOut.trim() ? statusOut.trim().split('\n').length : 0;
    } catch { /* ignore */ }

    return status;
}

async function getProjectGitStatus(projectPath: string): Promise<GitStatus> {
    const empty: GitStatus = { isGitRepo: false, localChanges: 0, ahead: 0, behind: 0, branch: '' };
    const run = createGitRunner(projectPath, 8000);

    try {
        // Check if dir exists and is a git repo
        await run('git rev-parse --is-inside-work-tree');
    } catch {
        return empty;
    }

    const status: GitStatus = { isGitRepo: true, localChanges: 0, ahead: 0, behind: 0, branch: '' };

    try {
        const { stdout: branchOut } = await run('git branch --show-current');
        status.branch = branchOut.trim();
    } catch {
        /* detached HEAD */
    }

    try {
        const { stdout: statusOut } = await run('git status --porcelain');
        status.localChanges = statusOut.trim() ? statusOut.trim().split('\n').length : 0;
    } catch {
        /* ignore */
    }

    try {
        // Fetch remote silently to compare ahead/behind
        await run('git fetch --quiet');
    } catch {
        /* offline or no remote */
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
async function resolveOrAttachHead(projectPath: string): Promise<string> {
    const run = createGitRunner(projectPath, 8000);

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

async function gitPush(projectPath: string, commitMsg?: string): Promise<string> {
    const run = createGitRunner(projectPath);
    const branch = await getCurrentBranch(projectPath);
    try {
        await gitCommitLocal(projectPath, commitMsg);
        const { stdout, stderr } = await run(`git push -u origin ${branch}`);
        return trimGitOutput(stdout, stderr) || 'Push complete';
    } catch (err: any) {
        throw new Error(formatGitError(err));
    }
}

interface SyncResult {
    status: 'fast-forward' | 'merged' | 'nothing-to-do' | 'pushed' | 'recovered';
    message: string;
}

async function getSyncDirection(
    projectPath: string
): Promise<{ ahead: number; behind: number; diverged: boolean }> {
    const run = createGitRunner(projectPath, 10000);

    try {
        await run('git fetch --quiet origin');
    } catch {
        /* fetch failed, try with whatever we have */
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

async function aggressiveRecovery(projectPath: string): Promise<string> {
    const run = createGitRunner(projectPath);
    const branch = await getCurrentBranch(projectPath);

    // Abort any ongoing operation
    for (const cmd of ['git merge --abort', 'git rebase --abort', 'git cherry-pick --abort']) {
        try {
            await run(cmd);
        } catch {
            /* ignore */
        }
    }

    try {
        // Hard reset to remote - this discards local uncommitted changes
        await run('git reset --hard HEAD');
        await run('git clean -fd');
        await run(`git fetch --quiet origin ${branch}`);
        await run(`git reset --hard origin/${branch}`);
        return 'recovered';
    } catch {
        // Last resort: force reset
        try {
            await run('git fetch --all');
            await run(`git reset --hard origin/${branch}`);
            return 'recovered';
        } catch {
            return 'recovery-failed';
        }
    }
}

/**
 * Returns paths of all registered git submodules within a repo.
 * Falls back to an empty list if the repo has no submodules or git isn't available.
 */
async function findSubmodulePaths(projectPath: string): Promise<string[]> {
    const run = createGitRunner(projectPath, 10000);
    try {
        const { stdout } = await run('git submodule status --recursive');
        if (!stdout.trim()) return [];
        return stdout
            .trim()
            .split(/\r?\n/)
            .map((line) => {
                // Format: [ +-U]<sha1> <relative-path> [(<describe>)]
                const match = line.trim().match(/^[+\-U ]?\S+\s+(\S+)/);
                return match ? path.join(projectPath, match[1]) : null;
            })
            .filter((p): p is string => p !== null);
    } catch {
        return [];
    }
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
 * Scans one level of subdirectories under projectPath looking for independent
 * git repos (directories with a .git entry that are NOT already in excludePaths).
 * Skips hidden dirs and node_modules.
 */
function findNestedRepoPaths(projectPath: string, excludePaths: Set<string> = new Set()): string[] {
    const results: string[] = [];
    try {
        const entries = fs.readdirSync(projectPath, { withFileTypes: true });
        for (const entry of entries) {
            if (!entry.isDirectory()) continue;
            if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
            const childPath = path.join(projectPath, entry.name);
            if (excludePaths.has(childPath)) continue;
            const gitEntry = path.join(childPath, '.git');
            if (fs.existsSync(gitEntry)) {
                results.push(childPath);
            }
        }
    } catch {
        /* ignore permission errors */
    }
    return results;
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
async function gitSync(projectPath: string, commitMsg?: string, remoteUrl?: string): Promise<string> {
    // ── sanity checks ────────────────────────────────────────────────────────
    clearIndexLock(projectPath);
    if (!(await isGitRepo(projectPath))) return 'Sync complete';

    const run = createGitRunner(projectPath);

    // ── auto-reattach detached HEAD ──────────────────────────────────────────
    const branch = await resolveOrAttachHead(projectPath);

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
    try {
        const dir = await getSyncDirection(projectPath);
        ahead = dir.ahead;
        behind = dir.behind;
        diverged = dir.diverged;
    } catch {
        // getSyncDirection already swallows most errors; if it still throws
        // (e.g. no remote branch yet after adding a fresh remote) carry on
        // — we'll just push below.
    }

    // ── merge remote changes if needed ──────────────────────────────────────
    try {
        if (diverged) {
            try {
                const { stdout, stderr } = await run(
                    `git merge -X ours origin/${branch} --no-edit`
                );
                const output = trimGitOutput(stdout, stderr);
                if (/already up to date/i.test(output)) {
                    await run(`git pull --no-edit -X ours origin ${branch}`);
                }
            } catch {
                // merge failed — try pull with ours strategy
                await run(`git pull --no-edit -X ours origin ${branch}`);
            }
        } else if (behind > 0) {
            await run(`git pull --no-edit -X ours origin ${branch}`);
        }
    } catch {
        // Pull/merge failed — aggressive recovery, then continue to push
        const recovered = await aggressiveRecovery(projectPath);
        if (recovered === 'recovered') {
            try {
                const { stdout: statusOut } = await run('git status --porcelain');
                if (statusOut.trim()) {
                    if (await stageChangesBestEffort(run, projectPath)) {
                        const count = statusOut.trim().split('\n').length;
                        const tmpFile = writeCommitMsgFile(
                            `Recovery commit: ${count} changed file${count !== 1 ? 's' : ''}`
                        );
                        try {
                            await commitStagedChanges(run, tmpFile);
                        } finally {
                            try { fs.unlinkSync(tmpFile); } catch { /* ignore */ }
                        }
                    }
                }
                await run(`git pull --no-edit -X ours origin ${branch}`);
            } catch { /* carry on to push regardless */ }
        }
    }

    // ── push ─────────────────────────────────────────────────────────────────
    try {
        await run(`git push -u origin ${branch}`);
    } catch (pushErr: any) {
        const stderr = pushErr?.stderr ?? '';
        if (/rejected|non-fast-forward/i.test(stderr)) {
            // Remote advanced while we were working — pull then retry
            await run(`git pull --no-edit -X ours origin ${branch}`);
            await run(`git push -u origin ${branch}`);
        } else {
            throw pushErr;
        }
    }

    // ── result summary ───────────────────────────────────────────────────────
    if (committed && (behind > 0 || diverged)) return 'Synced changes';
    if (committed) return 'Changes pushed';
    if (behind > 0 || diverged) return 'Updated from remote';
    return 'Up to date';
}

/** Syncs one repo safely — swallows errors so the caller's loop continues. */
async function gitSyncSafe(projectPath: string, commitMsg?: string, remoteUrl?: string): Promise<void> {
    try { await gitSync(projectPath, commitMsg, remoteUrl); } catch { /* never abort parent */ }
}

/** Syncs the root repo plus all submodules and independent nested repos. */
async function gitSyncAll(projectPath: string, commitMsg?: string, remoteUrl?: string): Promise<string> {
    const result = await gitSync(projectPath, commitMsg, remoteUrl);

    const submodulePaths = await findSubmodulePaths(projectPath);
    const submoduleSet = new Set(submodulePaths);
    for (const subPath of submodulePaths) {
        try {
            await createGitRunner(projectPath, 20000)(
                `git submodule update --init -- "${subPath.replace(/\\/g, '/')}"`
            );
        } catch { /* ignore init failures */ }
        await gitSyncSafe(subPath, commitMsg);
    }

    for (const nestedPath of findNestedRepoPaths(projectPath, submoduleSet)) {
        await gitSyncSafe(nestedPath, commitMsg);
    }

    return result;
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
    /** Monotonic guard so older async status refreshes cannot overwrite newer results */
    private _statusRefreshSeq = 0;
    /** Cached S3 credential check result to avoid repeated keychain reads */
    private _s3CredsCached: boolean | null = null;
    private _s3CredsCachedAt = 0;
    /** File system watcher for the active workspace folder (fast local change detection) */
    private _fsWatcher?: vscode.FileSystemWatcher;
    /** Debounce timer for the file system watcher */
    private _fsWatcherDebounce?: NodeJS.Timeout;
    constructor(context: vscode.ExtensionContext, store: SharedStore) {
        this.context = context;
        this.store = store;
        this.manager = new GitProjects(context, store);
        this.accounts = new GitAccounts(context, store);
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
        this.store.on('changed', () => this.postState());

        // When the panel becomes visible again (e.g. user switches sidebar tabs),
        // immediately push cached statuses so badges are visible without waiting.
        webviewView.onDidChangeVisibility(() => {
            if (webviewView.visible) {
                this.postState();
            }
        });

        // Watch the active workspace folder for file changes and update the open project instantly.
        this._setupFsWatcher();
        // Re-create watcher if the workspace changes (folder added/removed).
        vscode.workspace.onDidChangeWorkspaceFolders(() => this._setupFsWatcher());

        webviewView.webview.onDidReceiveMessage(async (msg) => {
            switch (msg.type) {
                case 'ready': {
                    // On ready, auto-apply credentials for the current project
                    await this._autoApplyOnOpen();
                    // Fire token validation in the background — do NOT await before postState
                    // so the webview renders immediately with cached data.
                    this._validateAllTokensBackground().then(() => {
                        if (this.view) this.postState();
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
                    const option = await vscode.window.showQuickPick(
                        [
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
                    if (option?.label.includes('SSH')) {
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
                        try {
                            const result = await runExclusiveProjectGitOp(project.path, () =>
                                gitPush(project.path, msg.commitMsg)
                            );
                            vscode.window.showInformationMessage(`✓ ${project.name}: ${result}`);
                        } catch (err: any) {
                            const errMsg = err.message || 'Unknown error';
                            if (/workflow/i.test(errMsg) && /scope/i.test(errMsg) && project.accountId) {
                                const acc = this.accounts.getAccount(project.accountId);
                                if (acc && acc.authMethod === 'oauth' && acc.provider === 'github') {
                                    vscode.window.showErrorMessage(
                                        `Push failed: GitHub token lacks 'workflow' scope.`,
                                        'Re-authenticate & Retry'
                                    ).then(async (action) => {
                                        if (action) {
                                            await this._reAuthOAuth(acc.id, acc.provider);
                                            try {
                                                const result = await gitPush(project.path, msg.commitMsg);
                                                vscode.window.showInformationMessage(`✓ ${project.name}: ${result}`);
                                                this.store.write({ lastSyncAt: Date.now() });
                                                this.postState();
                                            } catch (retryErr: any) {
                                                vscode.window.showErrorMessage(`Retry failed: ${retryErr.message || 'Unknown error'}`);
                                            }
                                        }
                                    });
                                    return; // Don't show default error yet, notification handles it
                                }
                            }
                            vscode.window.showErrorMessage(
                                `Push failed for ${project.name}: ${errMsg}`
                            );
                        }
                        // Notify other IDEs that a git operation completed
                        this.store.write({ lastSyncAt: Date.now() });
                        try {
                            await this._postSingleProjectState(project.id);
                        } finally {
                            notifyGitOpDone(this.view?.webview, project.id);
                        }
                    }
                    break;
                }
                case 'gitSync': {
                    const project = this.manager.listProjects().find((p) => p.id === msg.id);
                    if (project) {
                        try {
                            await runExclusiveProjectGitOp(project.path, async () => {
                                try {
                                    const result = await gitSyncAll(project.path, msg.commitMsg, project.repoUrl);
                                    vscode.window.showInformationMessage(`✓ ${project.name}: ${result}`);
                                } catch (err: any) {
                                    if (err?.code !== 'NO_REMOTE') throw err;
                                    // No remote configured — prompt user to connect one
                                    const picked = await this._promptAndAddRemote(
                                        project.path, project.id
                                    );
                                    if (picked) {
                                        // Retry sync now that remote is set up
                                        const result = await gitSyncAll(project.path, msg.commitMsg, picked);
                                        vscode.window.showInformationMessage(`✓ ${project.name}: ${result}`);
                                    }
                                }
                            });
                        } catch (err: any) {
                            const errMsg = err.message || 'Unknown error';
                            if (/workflow/i.test(errMsg) && /scope/i.test(errMsg) && project.accountId) {
                                const acc = this.accounts.getAccount(project.accountId);
                                if (acc && acc.authMethod === 'oauth' && acc.provider === 'github') {
                                    vscode.window.showErrorMessage(
                                        `Sync failed: GitHub token lacks 'workflow' scope.`,
                                        'Re-authenticate & Retry'
                                    ).then(async (action) => {
                                        if (action) {
                                            await this._reAuthOAuth(acc.id, acc.provider);
                                            try {
                                                const result = await gitSyncAll(project.path, msg.commitMsg, project.repoUrl);
                                                vscode.window.showInformationMessage(`✓ ${project.name}: ${result}`);
                                                this.store.write({ lastSyncAt: Date.now() });
                                                this.postState();
                                            } catch (retryErr: any) {
                                                vscode.window.showErrorMessage(`Retry failed: ${retryErr.message || 'Unknown error'}`);
                                            }
                                        }
                                    });
                                    return; // Don't show default error yet, notification handles it
                                }
                            }
                            vscode.window.showErrorMessage(
                                `Sync failed for ${project.name}: ${errMsg}`
                            );
                        }
                        this.store.write({ lastSyncAt: Date.now() });
                        try {
                            await this._postLocalProjectState(project.id);
                            await this._postSingleProjectState(project.id);
                        } finally {
                            notifyGitOpDone(this.view?.webview, project.id);
                        }
                    }
                    break;
                }
            }
        });

        // initial state
        this.postState();
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

    async postState() {
        if (!this.view) return;
        const refreshSeq = ++this._statusRefreshSeq;
        const projects = this.manager
            .listProjects()
            .slice()
            .sort((a, b) => (b.lastOpened ?? 0) - (a.lastOpened ?? 0));
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
        this.view.webview.postMessage(buildMsg(this._cachedGitStatuses));

        // Pass 2: fast local-only check (no network fetch) — updates localChanges badge quickly
        const localStatuses: Record<string, GitStatus> = {};
        await Promise.allSettled(
            projects.map(async (p) => {
                localStatuses[p.id] = await getProjectLocalStatus(p.path, this._cachedGitStatuses[p.id]);
            })
        );
        if (refreshSeq !== this._statusRefreshSeq || !this.view) return;
        this._cachedGitStatuses = { ...this._cachedGitStatuses, ...localStatuses };
        if (this.view) this.view.webview.postMessage(buildMsg(this._cachedGitStatuses));

        // Pass 3: full check with git fetch — updates ahead/behind for all projects.
        // Fetches are capped at 3 concurrent to avoid saturating the network/thread pool.
        // No TTL skipping — every refresh gets fresh remote status so badges are always current.
        const MAX_CONCURRENT = 3;
        const remoteStatuses: Record<string, GitStatus> = {};
        for (let i = 0; i < projects.length; i += MAX_CONCURRENT) {
            const batch = projects.slice(i, i + MAX_CONCURRENT);
            await Promise.allSettled(
                batch.map(async (p) => {
                    remoteStatuses[p.id] = await getProjectGitStatus(p.path);
                })
            );
        }

        if (Object.keys(remoteStatuses).length > 0) {
            if (refreshSeq !== this._statusRefreshSeq || !this.view) return;
            this._cachedGitStatuses = { ...this._cachedGitStatuses, ...remoteStatuses };
            if (this.view) this.view.webview.postMessage(buildMsg(this._cachedGitStatuses));
        }
    }

    /** Set up (or re-create) a file system watcher on the active workspace folder.
     *  When any file changes, the open project's local status is refreshed immediately. */
    private _setupFsWatcher(): void {
        // Dispose any previous watcher
        if (this._fsWatcher) {
            this._fsWatcher.dispose();
            this._fsWatcher = undefined;
        }
        const activeFolder = vscode.workspace.workspaceFolders?.[0];
        if (!activeFolder) return;

        // Watch source files only — exclude build artefacts and package dirs
        // to avoid a massive event stream from npm install / build runs.
        this._fsWatcher = vscode.workspace.createFileSystemWatcher(
            new vscode.RelativePattern(activeFolder, '{**/*.ts,**/*.tsx,**/*.js,**/*.jsx,**/*.py,**/*.go,**/*.rs,**/*.java,**/*.cs,**/*.html,**/*.css,**/*.json,**/*.md,**/*.env}'),
            false, false, false
        );

        const onFileEvent = () => {
            // Debounce: wait 400 ms of quiet before firing so rapid saves don't flood
            if (this._fsWatcherDebounce) clearTimeout(this._fsWatcherDebounce);
            this._fsWatcherDebounce = setTimeout(() => {
                const activeRepo = activeFolder.uri.fsPath;
                const project = this.manager.getProjectByPath(activeRepo);
                if (project) {
                    this._postLocalProjectState(project.id);
                }
            }, 400);
        };

        this._fsWatcher.onDidCreate(onFileEvent);
        this._fsWatcher.onDidChange(onFileEvent);
        this._fsWatcher.onDidDelete(onFileEvent);
    }

    /** Fast local-only update for a single project (no git fetch — just branch + localChanges). */
    public async _postLocalProjectState(projectId: string): Promise<void> {
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
        const project = projects.find((p) => p.id === projectId);
        if (!project) return;
        const localStatus = await getProjectLocalStatus(project.path, this._cachedGitStatuses[project.id]);
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

        const postPanelState = async () => {
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
            panel.webview.postMessage(buildMsg({}));

            // Then fetch git statuses in background and send again
            const gitStatuses: Record<string, GitStatus> = {};
            await Promise.allSettled(
                projects.map(async (p) => {
                    gitStatuses[p.id] = await getProjectGitStatus(p.path);
                })
            );

            if (refreshSeq !== panelStatusRefreshSeq) return;
            panel.webview.postMessage(buildMsg(gitStatuses));
        };

        // Hot-reload when another IDE writes the shared sync file
        store.on('changed', postPanelState);
        panel.onDidDispose(() => store.off('changed', postPanelState));

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
                            github: ['repo', 'read:user', 'user:email'],
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
                    const option = await vscode.window.showQuickPick(
                        [
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
                    if (option?.label.includes('SSH')) {
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
                        github: ['repo', 'read:user', 'user:email'],
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
                        try {
                            const result = await runExclusiveProjectGitOp(project.path, () =>
                                gitPush(project.path, msg.commitMsg)
                            );
                            vscode.window.showInformationMessage(`✓ ${project.name}: ${result}`);
                        } catch (err: any) {
                            vscode.window.showErrorMessage(
                                `Push failed for ${project.name}: ${err.message}`
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
                case 'gitSync': {
                    const project = manager.listProjects().find((p) => p.id === msg.id);
                    if (project) {
                        try {
                            await runExclusiveProjectGitOp(project.path, async () => {
                                try {
                                    await gitSyncAll(project.path, msg.commitMsg, project.repoUrl);
                                } catch (err: any) {
                                    if (err?.code !== 'NO_REMOTE') throw err;
                                    const picked = await promptAndAddRemotePanel(
                                        project.path, project.id
                                    );
                                    if (picked) {
                                        await gitSyncAll(project.path, msg.commitMsg, picked);
                                    }
                                }
                            });
                        } catch {
                            /* handled above */
                        }
                        try {
                            await postPanelState();
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
                        ['repo', 'read:user', 'user:email'],
                        { forceNewSession: true }
                    );
                    activeAccs.updateAccount(accountId, { token: session.accessToken });
                    webview?.postMessage({ type: 'accountUpdated', accountId });
                    vscode.window.showInformationMessage(
                        `Token updated for ${acct.username} via GitHub OAuth.`
                    );
                } catch (err: any) {
                    vscode.window.showErrorMessage(`OAuth failed: ${err?.message ?? String(err)}`);
                }
                return;
            }
        }

        const token = await vscode.window.showInputBox({
            prompt: 'Enter personal access token (with repo scope)',
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
                                    `git -c http.extraHeader="Authorization: Basic ${b64}" clone "${rawUrl}" "${safeCloneName}"`,
                                    { cwd: cloneDestPath, env: process.env }
                                );
                                cloned = true;
                            } catch {
                                /* fall through */
                            }
                        }
                        if (!cloned) {
                            await execAsync(`git clone "${rawUrl}" "${safeCloneName}"`, {
                                cwd: cloneDestPath,
                                env: process.env,
                            });
                        }

                        // ── 1b. Strip old git history — start fresh ───────────────────
                        const nodePath2 = require('path') as typeof import('path');
                        const nodeFs2 = require('fs') as typeof import('fs');
                        const gitDir = nodePath2.join(cloneFullPath, '.git');
                        nodeFs2.rmSync(gitDir, { recursive: true, force: true });
                        await execAsync('git init', { cwd: cloneFullPath, env: process.env });
                        await execAsync('git checkout -b main', {
                            cwd: cloneFullPath,
                            env: process.env,
                        }).catch(() =>
                            execAsync('git checkout -b master', {
                                cwd: cloneFullPath,
                                env: process.env,
                            })
                        );
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

                    await execAsync(`git clone "${cloneUrl}" "${repoName}"`, { cwd: destPath });

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
