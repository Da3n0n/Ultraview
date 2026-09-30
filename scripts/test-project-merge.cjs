const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const cp = require('node:child_process');
const Module = require('node:module');
const vm = require('node:vm');
const ts = require('typescript');
let picks = [], confirm = 'Merge', confirmations = [];
const window = {
    showQuickPick: async items => { const label = picks.shift(); return items.find(item => item.label === label); },
    showWarningMessage: async (message, options) => { confirmations.push({ message, options }); return confirm; },
};
const filename = path.resolve('src/git/projectMerge.ts'), m = new Module(filename, module);
m.filename = filename; m.paths = Module._nodeModulePaths(path.dirname(filename));
const originalRequire = m.require.bind(m);
m.require = name => name === 'vscode' ? { window } : originalRequire(name);
m._compile(ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText, filename);
const { mergeProjectBranches } = m.exports;
function load(file) {
    const filename = path.resolve(file), loaded = new Module(filename, module);
    loaded.filename = filename; loaded.paths = Module._nodeModulePaths(path.dirname(filename));
    loaded._compile(ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
        compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
    }).outputText, filename);
    return loaded.exports;
}
const { verifyProjectSync, assertNoImportedGitlinks } = load('src/git/syncVerification.ts');
const provider = ts.createSourceFile('provider.ts', fs.readFileSync('src/providers/gitProvider.ts', 'utf8'), ts.ScriptTarget.Latest, true);
const names = ['parseGitArgs', 'createGitRunner', 'trimGitOutput', 'getCurrentBranch', 'getSyncDirection', 'mergeRemoteBranch', 'gitSync', 'gitSyncAll'];
const syncCode = provider.statements.filter(n => ts.isFunctionDeclaration(n) && names.includes(n.name?.text))
    .map(n => n.getText(provider)).join('\n');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'uv-project-merge-'));
const git = (cwd, ...args) => cp.execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
function init(dir, bare = false) {
    fs.mkdirSync(dir, { recursive: true }); git(dir, 'init', '-b', 'main', ...(bare ? ['--bare'] : []));
    if (!bare) { git(dir, 'config', 'user.name', 'Test'); git(dir, 'config', 'user.email', 'test@example.invalid'); }
}
function commit(dir, name, value) { fs.writeFileSync(path.join(dir, name), value); git(dir, 'add', '-A'); git(dir, 'commit', '-qm', 'fixture'); }
const context = {
    Buffer, process, console, path, childProcess: cp, clearIndexLock() {},
    isGitRepo: async () => true, removeLegacyRewriteArtifacts: async () => {},
    resolveOrAttachHead: async dir => git(dir, 'branch', '--show-current'),
    recoverInterruptedGitState: async () => [], hasRemote: async () => true,
    gitCommitLocal: async dir => {
        if (!git(dir, 'status', '--porcelain')) return false;
        git(dir, 'add', '-A'); git(dir, 'commit', '-qm', 'sync fixture'); return true;
    },
    syncChangedSubmodules: async () => ({ paths: [], notes: [] }),
    withTransientRetry: fn => fn(), formatGitError: e => e.stderr || e.message,
    parseMovedRepository: () => undefined, isLfsLockVerificationError: () => false,
    assertNoImportedGitlinks, verifyProjectSync, vscode: { window },
};
vm.createContext(context);
vm.runInContext(ts.transpileModule(syncCode, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText, context);
(async () => {
    const root = path.join(temp, 'root'), remote = path.join(temp, 'remote');
    init(root); init(remote, true);
    commit(root, 'common.txt', 'base\n');
    git(root, 'remote', 'add', 'origin', remote); git(root, 'push', '-u', 'origin', 'main');
    const base = git(root, 'rev-parse', 'main');
    git(root, 'switch', '-c', 'feature/one'); commit(root, 'feature.txt', 'feature');
    const featureHead = git(root, 'rev-parse', 'HEAD');
    // Cancelling any picker/confirmation never checks out or changes a branch.
    for (const selection of [[], ['main'], ['main', 'feature/one']]) {
        picks = [...selection]; confirm = undefined;
        assert.equal(await mergeProjectBranches(root), undefined);
        assert.equal(git(root, 'branch', '--show-current'), 'feature/one');
        assert.equal(git(root, 'rev-parse', 'main'), base);
    }
    // Fast-forward feature into main; source kept and remote remains unchanged until Sync.
    confirm = 'Merge'; picks = ['main', 'feature/one'];
    assert.match(await mergeProjectBranches(root), /Merged feature\/one into main/);
    assert.match(confirmations.at(-1).message, /Merge feature\/one into main\?/);
    assert.match(confirmations.at(-1).options.detail, /Click Sync/);
    assert.equal(git(root, 'branch', '--show-current'), 'main');
    assert.equal(git(root, 'rev-parse', 'main'), featureHead);
    assert.equal(git(root, 'rev-parse', 'feature/one'), featureHead);
    assert.equal(git(remote, 'rev-parse', 'main'), base);
    // A real two-parent merge retains commits unique to both branches.
    git(root, 'switch', '-c', 'feature/two'); commit(root, 'two.txt', 'two');
    const twoHead = git(root, 'rev-parse', 'HEAD');
    git(root, 'switch', 'main'); commit(root, 'main-only.txt', 'main');
    git(root, 'config', 'branch.main.mergeOptions', '--no-commit');
    const mainBefore = git(root, 'rev-parse', 'HEAD');
    picks = ['main', 'feature/two'];
    await mergeProjectBranches(root);
    assert.equal(git(root, 'rev-parse', 'HEAD^1'), mainBefore);
    assert.equal(git(root, 'rev-parse', 'HEAD^2'), twoHead);
    assert.ok(fs.existsSync(path.join(root, 'two.txt')));
    assert.ok(fs.existsSync(path.join(root, 'main-only.txt')));
    // Already-merged source is harmless.
    const mergedHead = git(root, 'rev-parse', 'HEAD'); picks = ['main', 'feature/two'];
    await mergeProjectBranches(root); assert.equal(git(root, 'rev-parse', 'HEAD'), mergedHead);
    // Dirty files and an existing Git operation are rejected before showing pickers.
    fs.writeFileSync(path.join(root, 'dirty.txt'), 'keep');
    await assert.rejects(mergeProjectBranches(root), /Commit or stash/);
    assert.equal(fs.readFileSync(path.join(root, 'dirty.txt'), 'utf8'), 'keep');
    fs.unlinkSync(path.join(root, 'dirty.txt'));
    const marker = git(root, 'rev-parse', '--path-format=absolute', '--git-path', 'CHERRY_PICK_HEAD');
    fs.writeFileSync(marker, base);
    await assert.rejects(mergeProjectBranches(root), /already in progress/); fs.unlinkSync(marker);
    // Conflicts abort the attempted merge and restore a clean destination.
    git(root, 'switch', '-c', 'feature/conflict'); commit(root, 'common.txt', 'feature version\n');
    const conflictHead = git(root, 'rev-parse', 'HEAD');
    git(root, 'switch', 'main'); commit(root, 'common.txt', 'main version\n');
    const beforeConflict = git(root, 'rev-parse', 'HEAD');
    picks = ['main', 'feature/conflict'];
    await assert.rejects(mergeProjectBranches(root), /was aborted.*common\.txt/);
    assert.equal(git(root, 'rev-parse', 'HEAD'), beforeConflict);
    assert.equal(git(root, 'rev-parse', 'feature/conflict'), conflictHead);
    assert.equal(git(root, 'status', '--porcelain'), '');
    assert.ok(!fs.existsSync(git(root, 'rev-parse', '--path-format=absolute', '--git-path', 'MERGE_HEAD')));
    assert.equal(fs.readFileSync(path.join(root, 'common.txt'), 'utf8').replace(/\r/g, ''), 'main version\n');
    // Explicit refs merge the branch, even if a tag has the same name.
    git(root, 'tag', 'feature/tagged', base);
    git(root, 'switch', '-c', 'feature/tagged'); commit(root, 'tagged.txt', 'branch');
    picks = ['main', 'feature/tagged']; await mergeProjectBranches(root);
    assert.ok(fs.existsSync(path.join(root, 'tagged.txt')));
    // Remote-only source is available without creating another local branch.
    git(root, 'update-ref', 'refs/remotes/origin/feature/remote', conflictHead);
    git(root, 'switch', '-c', 'destination/remote', base);
    picks = ['destination/remote', 'origin/feature/remote']; await mergeProjectBranches(root);
    assert.equal(git(root, 'rev-parse', 'HEAD'), conflictHead);
    assert.equal(git(root, 'branch', '--show-current'), 'destination/remote');
    assert.equal(git(remote, 'rev-parse', 'main'), base);
    // Real production Sync publishes to the selected destination after a merge.
    const sourceBeforeSync = git(root, 'rev-parse', 'feature/tagged');
    git(root, 'switch', 'main');
    assert.match(await context.gitSyncAll(root), /verified/);
    assert.equal(git(remote, 'rev-parse', 'main'), git(root, 'rev-parse', 'main'));
    assert.equal(git(root, 'rev-parse', 'feature/tagged'), sourceBeforeSync);
    assert.equal(git(root, 'branch', '--show-current'), 'main');
    const empty = path.join(temp, 'empty'); init(empty);
    await assert.rejects(mergeProjectBranches(empty), /first commit/);
    console.log('Project merge passed: direction, cancellation, fast-forward, two-parent merge, dirty/in-progress guards, conflict rollback, tag ambiguity, remote source, source preservation and Sync publishes destination.');
})().catch(e => { console.error(e); process.exitCode = 1; }).finally(() => {
    if (path.dirname(temp) === os.tmpdir() && path.basename(temp).startsWith('uv-project-merge-')) {
        fs.rmSync(temp, { recursive: true, force: true });
    }
});
