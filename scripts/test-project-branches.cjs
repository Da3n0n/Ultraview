const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const cp = require('node:child_process');
const Module = require('node:module');
const vm = require('node:vm');
const ts = require('typescript');
let choose = () => undefined;
let enter = () => undefined;
const window = {
    showQuickPick: async items => choose(items),
    showInputBox: async options => enter(options),
};
function load(file, mocks = {}) {
    const filename = path.resolve(file), m = new Module(filename, module);
    m.filename = filename; m.paths = Module._nodeModulePaths(path.dirname(filename));
    const originalRequire = m.require.bind(m);
    m.require = name => mocks[name] || originalRequire(name);
    m._compile(ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
        compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
    }).outputText, filename);
    return m.exports;
}
const { pickProjectBranch } = load('src/git/projectBranches.ts', { vscode: { window } });
const { verifyProjectSync, assertNoImportedGitlinks } = load('src/git/syncVerification.ts');
const source = fs.readFileSync('src/providers/gitProvider.ts', 'utf8');
const parsed = ts.createSourceFile('provider.ts', source, ts.ScriptTarget.Latest, true);
const names = ['parseGitArgs', 'createGitRunner', 'trimGitOutput', 'getProjectLocalStatus',
    'getProjectGitStatus', 'getCurrentBranch', 'getSyncDirection', 'mergeRemoteBranch', 'gitSync', 'gitSyncAll', 'gitPush', 'gitPull'];
const code = parsed.statements.filter(n => ts.isFunctionDeclaration(n) && names.includes(n.name?.text))
    .map(n => n.getText(parsed)).join('\n');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'uv-project-branches-'));
const git = (cwd, ...args) => cp.execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
function init(dir, bare = false) {
    fs.mkdirSync(dir, { recursive: true }); git(dir, 'init', '-b', 'main', ...(bare ? ['--bare'] : []));
    if (!bare) { git(dir, 'config', 'user.name', 'Test'); git(dir, 'config', 'user.email', 'test@example.invalid'); }
}
function commit(dir) { git(dir, 'add', '-A'); git(dir, 'commit', '-qm', 'fixture'); }
const context = {
    remoteStatusJobs: new Map(), activeRemoteStatusJobs: 0, remoteStatusWaiters: [],
    Buffer, process, console, path, childProcess: cp,
    clearIndexLock() {}, isGitRepo: async () => true, removeLegacyRewriteArtifacts: async () => {},
    resolveOrAttachHead: async dir => git(dir, 'branch', '--show-current'),
    recoverInterruptedGitState: async () => [], hasRemote: async () => true,
    gitCommitLocal: async dir => { if (!git(dir, 'status', '--porcelain')) return false; commit(dir); return true; },
    syncChangedSubmodules: async () => ({ paths: [], notes: [] }),
    withTransientRetry: fn => fn(), formatGitError: e => e.stderr || e.message,
    parseMovedRepository: () => undefined, isLfsLockVerificationError: () => false,
    assertNoImportedGitlinks, verifyProjectSync, vscode: { window },
};
vm.createContext(context);
vm.runInContext(ts.transpileModule(code, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText, context);
(async () => {
    const root = path.join(temp, 'root'), remote = path.join(temp, 'remote'), peer = path.join(temp, 'peer');
    init(remote, true); init(root);
    fs.writeFileSync(path.join(root, 'main.txt'), 'main'); commit(root);
    git(root, 'remote', 'add', 'origin', remote); git(root, 'push', '-u', 'origin', 'main');
    const mainHead = git(remote, 'rev-parse', 'main');
    // Cancellation and selecting the current branch do not mutate the checkout.
    assert.equal(await pickProjectBranch(root), false);
    choose = items => items.find(item => item.name === 'main');
    assert.equal(await pickProjectBranch(root), false);
    choose = items => items[0]; enter = () => undefined;
    assert.equal(await pickProjectBranch(root), false);
    // Creating a branch retains dirty work, starts at HEAD and never inherits main's upstream.
    git(root, 'config', 'branch.autoSetupMerge', 'inherit');
    fs.writeFileSync(path.join(root, 'new.txt'), 'local feature');
    enter = async options => {
        assert.ok(await options.validateInput('bad name'));
        assert.ok(await options.validateInput('@{-1}'));
        assert.ok(await options.validateInput('main'));
        assert.equal(await options.validateInput('feature/new'), undefined);
        return 'feature/new';
    };
    assert.equal(await pickProjectBranch(root), true);
    assert.equal(git(root, 'branch', '--show-current'), 'feature/new');
    assert.equal(git(root, 'rev-parse', 'HEAD'), mainHead);
    assert.throws(() => git(root, 'rev-parse', '@{upstream}'));
    choose = items => items.find(item => item.name === 'main');
    await assert.rejects(pickProjectBranch(root), /Commit or stash/);
    assert.equal(git(root, 'branch', '--show-current'), 'feature/new');
    // Real production Sync publishes a new branch and leaves main untouched.
    assert.match(await context.gitSyncAll(root), /verified/);
    assert.equal(git(remote, 'rev-parse', 'feature/new'), git(root, 'rev-parse', 'HEAD'));
    assert.equal(git(remote, 'rev-parse', 'main'), mainHead);
    assert.equal(git(root, 'rev-parse', '--abbrev-ref', '@{upstream}'), 'origin/feature/new');
    assert.equal(await pickProjectBranch(root), true);
    assert.equal((await context.getProjectLocalStatus(root)).branch, 'main');
    // A remote-only branch gets a local branch with the correct tracking target.
    git(temp, 'clone', remote, peer); git(peer, 'config', 'user.name', 'Test'); git(peer, 'config', 'user.email', 'test@example.invalid');
    git(peer, 'switch', '-c', 'feature/remote');
    fs.writeFileSync(path.join(peer, 'remote.txt'), 'remote feature'); commit(peer); git(peer, 'push', '-u', 'origin', 'feature/remote');
    git(root, 'fetch', 'origin');
    choose = items => {
        assert.ok(!items.some(item => item.name === 'HEAD'));
        return items.find(item => item.name === 'feature/remote' && item.remote);
    };
    assert.equal(await pickProjectBranch(root), true);
    assert.equal(git(root, 'rev-parse', '--abbrev-ref', '@{upstream}'), 'origin/feature/remote');
    fs.writeFileSync(path.join(peer, 'remote-update.txt'), 'update'); commit(peer); git(peer, 'push');
    fs.writeFileSync(path.join(root, 'local-update.txt'), 'update');
    assert.match(await context.gitSyncAll(root), /verified/);
    assert.equal(git(remote, 'rev-parse', 'feature/remote'), git(root, 'rev-parse', 'HEAD'));
    assert.ok(fs.existsSync(path.join(root, 'remote-update.txt')));
    assert.equal(git(remote, 'rev-parse', 'main'), mainHead);
    // Push and Pull also operate on the selected branch.
    fs.writeFileSync(path.join(root, 'pushed.txt'), 'push');
    await context.gitPush(root);
    git(peer, 'pull', '--ff-only');
    fs.writeFileSync(path.join(peer, 'pulled.txt'), 'pull'); commit(peer); git(peer, 'push');
    await context.gitPull(root);
    assert.ok(fs.existsSync(path.join(root, 'pulled.txt')));
    assert.equal(git(remote, 'rev-parse', 'main'), mainHead);
    // Creating from detached HEAD retains the user's chosen commit.
    git(root, 'switch', '--detach', mainHead);
    choose = items => items[0]; enter = () => 'feature/from-detached';
    assert.equal(await pickProjectBranch(root), true);
    assert.equal(git(root, 'rev-parse', 'HEAD'), mainHead);
    assert.equal(git(root, 'branch', '--show-current'), 'feature/from-detached');
    // Empty repositories can create and select a branch before the first commit.
    const empty = path.join(temp, 'empty'); init(empty);
    enter = () => 'feature/first';
    assert.equal(await pickProjectBranch(empty), true);
    assert.equal(git(empty, 'branch', '--show-current'), 'feature/first');
    console.log('Project branches passed: cancel, validation, dirty guard, create, local/remote switch, tracking, detached/unborn HEAD, Sync/Push/Pull target selected branch; main preserved.');
})().catch(e => { console.error(e); process.exitCode = 1; }).finally(() => {
    if (path.dirname(temp) === os.tmpdir() && path.basename(temp).startsWith('uv-project-branches-')) {
        fs.rmSync(temp, { recursive: true, force: true });
    }
});
