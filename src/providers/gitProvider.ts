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

interface GitStatus {
    isGitRepo: boolean;
    localChanges: number; // uncommitted + staged
    ahead: number; // commits ahead of remote
    behind: number; // commits behind remote
    branch: string;
}

type GitConflictStrategy = 'ours' | 'theirs';
type GitCommandRunner = (cmd: string) => Promise<{ stdout: string; stderr: string }>;

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
    // Fallback: check what remote HEAD points to
    try {
        const { stdout } = await run('git symbolic-ref refs/remotes/origin/HEAD');
        const ref = stdout.trim(); // e.g. refs/remotes/origin/main
        return ref.replace(/^refs\/remotes\/origin\//, '');
    } catch {
        /* ignore */
    }
    return 'main'; // last-resort default
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

    // Stage changes; retry once after clearing lock if blocked
    try {
        await run('git add -A');
    } catch (err: any) {
        if (/index\.lock|another git process/i.test(err?.stderr ?? err?.message ?? '')) {
            clearIndexLock(projectPath);
            await run('git add -A');
        } else {
            throw err;
        }
    }

    // Write commit message to a temp file to avoid shell-escaping issues with
    // multi-line messages on Windows
    const tmpFile = writeCommitMsgFile(msg);
    try {
        await run(`git commit -F "${tmpFile.replace(/\\/g, '/')}"`);
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

async function gitSync(projectPath: string, commitMsg?: string): Promise<string> {
    // Step 0: Clear any stale lock file before doing anything
    clearIndexLock(projectPath);

    const rootIsRepo = await isGitRepo(projectPath);
    let mainResult = 'Sync complete';

    if (rootIsRepo) {
        const run = createGitRunner(projectPath);
        const branch = await getCurrentBranch(projectPath);

        // Step 1: Recover from any interrupted git state first
        await recoverInterruptedGitState(projectPath, 'ours');

        // Step 2: Commit any local changes
        const committed = await gitCommitLocal(projectPath, commitMsg);

        // Step 3: Check relationship with remote
        const { ahead, behind, diverged } = await getSyncDirection(projectPath);

        // Step 4: Handle based on relationship
        try {
            if (diverged) {
                // Both users made commits - use ours strategy (local wins conflicts)
                // This ensures user's changes are preserved
                try {
                    const { stdout, stderr } = await run(
                        `git merge -X ours origin/${branch} --no-edit`
                    );
                    const output = trimGitOutput(stdout, stderr);
                    // If merge did nothing useful, try pull instead
                    if (/already up to date/i.test(output) || output.includes('up-to-date')) {
                        await run(`git pull --no-edit -X ours origin ${branch}`);
                    }
                } catch {
                    // Merge failed - try pull with ours strategy
                    await run(`git pull --no-edit -X ours origin ${branch}`);
                }
            } else if (behind > 0) {
                // We're behind remote - pull and merge
                await run(`git pull --no-edit -X ours origin ${branch}`);
            }
            // If ahead only, no merge needed - just push
        } catch (err: any) {
            // Something went wrong - try aggressive recovery
            const recoveryResult = await aggressiveRecovery(projectPath);
            if (recoveryResult === 'recovered') {
                // Re-commit local changes after recovery
                const { stdout: statusOut } = await run('git status --porcelain');
                if (statusOut.trim()) {
                    await run('git add -A');
                    const files = statusOut.trim().split('\n').length;
                    await run(
                        `git commit -m "Recovery commit: ${files} changed file${files !== 1 ? 's' : ''}"`
                    );
                }
                // Now merge remote
                await run(`git pull --no-edit -X ours origin ${branch}`);
            } else {
                throw new Error('Sync failed - please resolve manually');
            }
        }

        // Step 5: Push result
        try {
            await run(`git push -u origin ${branch}`);
        } catch (err: any) {
            // Push failed - might be because remote advanced
            if (/rejected/i.test(err.stderr) || /non-fast-forward/i.test(err.stderr)) {
                // Pull latest and merge, then push
                await run('git fetch --quiet origin');
                await run(`git merge -X ours origin/${branch} --no-edit`);
                await run(`git push -u origin ${branch}`);
            } else {
                throw err;
            }
        }

        if (committed && (ahead > 0 || behind > 0 || diverged)) {
            mainResult = 'Synced changes';
        } else if (committed) {
            mainResult = 'Changes pushed';
        } else if (behind > 0 || diverged) {
            mainResult = 'Updated from remote';
        } else if (ahead > 0) {
            mainResult = 'Already up to date';
        }
    }

    // Sync all registered submodules using the same logic
    const submodulePaths = await findSubmodulePaths(projectPath);
    const submoduleSet = new Set(submodulePaths);
    for (const subPath of submodulePaths) {
        try {
            // Ensure the submodule working tree is checked out before syncing
            await createGitRunner(projectPath, 20000)(`git submodule update --init -- "${subPath.replace(/\\/g, '/')}"`);
            await gitSync(subPath, commitMsg);
        } catch {
            /* a failing submodule should not abort the main sync */
        }
    }

    // Also sync any independent nested repos (monorepo pattern where child dirs
    // are their own repos, not registered submodules)
    const nestedRepoPaths = findNestedRepoPaths(projectPath, submoduleSet);
    for (const nestedPath of nestedRepoPaths) {
        try {
            await gitSync(nestedPath, commitMsg);
        } catch {
            /* a failing nested repo should not abort the overall sync */
        }
    }

    return mainResult;
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
                            const accountsList = this.accounts.listAccounts();
                            const matched = accountsList.find(
                                (a) => a.provider === targetProvider
                            );
                            if (matched) accountId = matched.id;
                        }
                    }
                } catch {
                    // Not a git repo, add as plain project
                }
                this.manager.addProject({
                    name: projectName,
                    path: folder,
                    accountId,
                    repoUrl,
                });
                this.postState();
            }
        }
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
                    await this._validateAllTokensBackground();
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
                    vscode.commands.executeCommand('ultraview.openS3Backup');
                    break;
                }
                case 's3BackupProject': {
                    const project = this.manager.listProjects().find((p) => p.id === msg.id);
                    if (project) {
                        vscode.commands.executeCommand('ultraview.openS3Backup');
                        // Small delay so the panel opens before the backup triggers
                        setTimeout(() => {
                            vscode.commands.executeCommand('ultraview.s3BackupProjectById', msg.id);
                        }, 800);
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
                            const result = await gitPull(project.path);
                            vscode.window.showInformationMessage(`✓ ${project.name}: ${result}`);
                        } catch (err: any) {
                            vscode.window.showErrorMessage(
                                `Pull failed for ${project.name}: ${err.message}`
                            );
                        }
                        // Notify other IDEs that a git operation completed
                        this.store.write({ lastSyncAt: Date.now() });
                        await this._postSingleProjectState(project.id);
                    }
                    break;
                }
                case 'gitPush': {
                    const project = this.manager.listProjects().find((p) => p.id === msg.id);
                    if (project) {
                        try {
                            const result = await gitPush(project.path, msg.commitMsg);
                            vscode.window.showInformationMessage(`✓ ${project.name}: ${result}`);
                        } catch (err: any) {
                            vscode.window.showErrorMessage(
                                `Push failed for ${project.name}: ${err.message}`
                            );
                        }
                        // Notify other IDEs that a git operation completed
                        this.store.write({ lastSyncAt: Date.now() });
                        await this._postSingleProjectState(project.id);
                    }
                    break;
                }
                case 'gitSync': {
                    const project = this.manager.listProjects().find((p) => p.id === msg.id);
                    if (project) {
                        try {
                            const result = await gitSync(project.path, msg.commitMsg);
                            vscode.window.showInformationMessage(
                                `✓ ${project.name}: Sync complete`
                            );
                        } catch (err: any) {
                            vscode.window.showErrorMessage(
                                `Sync failed for ${project.name}: ${err.message}`
                            );
                        }
                        // Notify other IDEs that a git operation completed
                        this.store.write({ lastSyncAt: Date.now() });
                        await this._postSingleProjectState(project.id);
                    }
                    break;
                }
            }
        });

        // initial state
        this.postState();
    }

    async postState() {
        if (!this.view) return;
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

        const buildMsg = (gitStatuses: Record<string, GitStatus>) => ({
            type: 'state',
            projects,
            activeRepo,
            activeRepoName,
            accounts: accountsWithStatus,
            activeAccountId: activeAccountId || null,
            activeProjectId: activeProject?.id || null,
            gitStatuses,
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
        this._cachedGitStatuses = { ...this._cachedGitStatuses, ...localStatuses };
        if (this.view) this.view.webview.postMessage(buildMsg(this._cachedGitStatuses));

        // Pass 3: full check with git fetch — updates ahead/behind (slow, network)
        const remoteStatuses: Record<string, GitStatus> = {};
        await Promise.allSettled(
            projects.map(async (p) => {
                remoteStatuses[p.id] = await getProjectGitStatus(p.path);
            })
        );
        this._cachedGitStatuses = { ...this._cachedGitStatuses, ...remoteStatuses };
        if (this.view) this.view.webview.postMessage(buildMsg(this._cachedGitStatuses));
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

        // Watch everything except .git internals to avoid noise
        this._fsWatcher = vscode.workspace.createFileSystemWatcher(
            new vscode.RelativePattern(activeFolder, '**'),
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
        const project = projects.find((p) => p.id === projectId);
        if (!project) return;
        const localStatus = await getProjectLocalStatus(project.path, this._cachedGitStatuses[project.id]);
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
        });
    }

    /** Post state for a single project only (for targeted UI update) */
    public async _postSingleProjectState(projectId: string): Promise<void> {
        if (!this.view) return;
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
        const gitStatuses: Record<string, GitStatus> = {};
        const project = projects.find((p) => p.id === projectId);
        if (project) {
            gitStatuses[project.id] = await getProjectGitStatus(project.path);
        }
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

    /** Re-authenticate an existing OAuth account (refresh token). */
    private async _reAuthOAuth(accountId: string, provider: GitProviderType): Promise<void> {
        const browserProviders: Record<string, string> = {
            github: 'github',
            gitlab: 'gitlab',
            azure: 'microsoft',
        };
        const vsCodeProviderId = browserProviders[provider];
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

        const postPanelState = async () => {
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

            const buildMsg = (gitStatuses: Record<string, GitStatus>) => ({
                type: 'state',
                projects,
                activeRepo,
                activeRepoName,
                accounts: accountsWithStatus,
                activeAccountId: activeAccountId || null,
                activeProjectId: activeProject?.id || null,
                gitStatuses,
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

            panel.webview.postMessage(buildMsg(gitStatuses));
        };

        // Hot-reload when another IDE writes the shared sync file
        store.on('changed', postPanelState);
        panel.onDidDispose(() => store.off('changed', postPanelState));

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
                            const result = await gitPull(project.path);
                            vscode.window.showInformationMessage(`✓ ${project.name}: ${result}`);
                        } catch (err: any) {
                            vscode.window.showErrorMessage(
                                `Pull failed for ${project.name}: ${err.message}`
                            );
                        }
                        postPanelState();
                    }
                    break;
                }
                case 'gitPush': {
                    const project = manager.listProjects().find((p) => p.id === msg.id);
                    if (project) {
                        try {
                            const result = await gitPush(project.path, msg.commitMsg);
                            vscode.window.showInformationMessage(`✓ ${project.name}: ${result}`);
                        } catch (err: any) {
                            vscode.window.showErrorMessage(
                                `Push failed for ${project.name}: ${err.message}`
                            );
                        }
                        postPanelState();
                    }
                    break;
                }
                case 'gitSync': {
                    const project = manager.listProjects().find((p) => p.id === msg.id);
                    if (project) {
                        try {
                            const result = await gitSync(project.path, msg.commitMsg);
                            vscode.window.showInformationMessage(
                                `✓ ${project.name}: Sync complete`
                            );
                        } catch (err: any) {
                            vscode.window.showErrorMessage(
                                `Sync failed for ${project.name}: ${err.message}`
                            );
                        }
                        postPanelState();
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
