const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const Module = require('node:module');
const cp = require('node:child_process');
const ts = require('typescript');
function load(file) {
    const filename = path.resolve(file), m = new Module(filename, module);
    m.filename = filename; m.paths = Module._nodeModulePaths(path.dirname(filename));
    m._compile(ts.transpileModule(fs.readFileSync(filename, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText, filename);
    return m.exports;
}
const { vendorRepositories } = load('src/git/vendorRepositories.ts');
const { verifyProjectSync, assertNoImportedGitlinks } = load('src/git/syncVerification.ts');
const source = fs.readFileSync('src/providers/gitProvider.ts', 'utf8');
const parsed = ts.createSourceFile('provider.ts', source, ts.ScriptTarget.Latest, true);
const names = ['parseGitArgs', 'createGitRunner', 'getProjectLocalStatus', 'gitSync', 'gitSyncAll', 'gitPush'];
const code = parsed.statements.filter(n => ts.isFunctionDeclaration(n) && names.includes(n.name?.text)).map(n => n.getText(parsed)).join('\n');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'uv-verified-sync-'));
const git = (cwd, ...args) => cp.execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
function init(dir, bare = false) {
    fs.mkdirSync(dir, { recursive: true }); git(dir, 'init', '-b', 'main', ...(bare ? ['--bare'] : []));
    if (!bare) { git(dir, 'config', 'user.name', 'Test'); git(dir, 'config', 'user.email', 'test@example.invalid'); }
}
function commit(dir) { git(dir, 'add', '-A'); git(dir, 'commit', '-qm', 'fixture'); }
const commands = [];
const context = {
    Buffer, process, console, childProcess: { execFile(command, args, options, cb) {
        commands.push({ cwd: options.cwd, args }); cp.execFile(command, args, options, cb);
    } },
    clearIndexLock() {}, isGitRepo: async () => true, removeLegacyRewriteArtifacts: async () => {},
    resolveOrAttachHead: async dir => git(dir, 'branch', '--show-current'),
    recoverInterruptedGitState: async () => {}, hasRemote: async () => true,
    gitCommitLocal: async dir => { if (!git(dir, 'status', '--porcelain')) return false; commit(dir); return true; },
    getSyncDirection: async dir => {
        git(dir, 'fetch', '--quiet', 'origin');
        const [ahead, behind] = git(dir, 'rev-list', '--left-right', '--count', 'HEAD...origin/main').split(/\s+/).map(Number);
        return { ahead, behind, diverged: ahead > 0 && behind > 0 };
    },
    mergeRemoteBranch: async dir => { git(dir, 'fetch', '--quiet', 'origin'); git(dir, 'merge', '--no-edit', 'origin/main'); },
    syncChangedSubmodules: async dir => { const paths = await vendorRepositories(dir); return { paths, notes: paths }; },
    withTransientRetry: fn => fn(), formatGitError: e => e.stderr || e.message,
    parseMovedRepository: () => undefined, isLfsLockVerificationError: () => false,
    assertNoImportedGitlinks, verifyProjectSync,
};
vm.createContext(context);
vm.runInContext(ts.transpileModule(code, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText, context);
(async () => {
    const root = path.join(temp, 'root'), remote = path.join(temp, 'remote'), vendor = path.join(temp, 'external');
    init(remote, true); init(root); init(vendor);
    fs.writeFileSync(path.join(vendor, 'source.txt'), 'upstream'); commit(vendor);
    const externalHead = git(vendor, 'rev-parse', 'HEAD');
    fs.writeFileSync(path.join(root, 'app.txt'), 'app'); commit(root);
    git(root, 'remote', 'add', 'origin', remote); git(root, 'push', '-u', 'origin', 'main');
    git(root, '-c', 'protocol.file.allow=always', 'submodule', 'add', vendor, 'vendor/editor'); commit(root);
    fs.writeFileSync(path.join(root, 'vendor/editor/source.txt'), 'customized');
    git(root, 'config', 'push.recurseSubmodules', 'on-demand');
    const run = context.createGitRunner(root);
    await assert.rejects(assertNoImportedGitlinks(run), /No vendor push/);
    assert.match(await context.gitSyncAll(root), /verified/);
    assert.equal(git(root, 'rev-parse', 'HEAD'), git(remote, 'rev-parse', 'main'));
    assert.equal(git(root, 'status', '--porcelain'), '');
    assert.equal(git(vendor, 'rev-parse', 'HEAD'), externalHead);
    assert.ok(commands.filter(c => c.args[0] === 'push').every(c => c.cwd === root && c.args.includes('--recurse-submodules=no')));
    assert.equal(git(root, 'show', 'HEAD:vendor/editor/source.txt'), 'customized');
    // Fresh verification detects a remote move even when local refs were stale.
    const peer = path.join(temp, 'peer'); git(temp, 'clone', remote, peer);
    git(peer, 'config', 'user.name', 'Test'); git(peer, 'config', 'user.email', 'test@example.invalid');
    fs.writeFileSync(path.join(peer, 'remote.txt'), 'new remote work'); commit(peer); git(peer, 'push');
    assert.equal(await verifyProjectSync(run), false);
    const badge = await context.getProjectLocalStatus(root, { ahead: 99, behind: 99 });
    assert.equal(badge.ahead, 0); assert.equal(badge.behind, 1);
    fs.writeFileSync(path.join(root, 'local.txt'), 'new local work');
    assert.match(await context.gitPush(root), /verified/);
    assert.equal(git(root, 'rev-parse', 'HEAD'), git(remote, 'rev-parse', 'main'));
    // Race after push: the outer transaction must retry before saying success.
    let checks = 0;
    context.verifyProjectSync = async runner => {
        if (++checks === 1) {
            git(peer, 'pull', '--ff-only'); fs.writeFileSync(path.join(peer, 'raced.txt'), 'race'); commit(peer); git(peer, 'push');
        }
        return verifyProjectSync(runner);
    };
    await context.gitSyncAll(root); assert.equal(checks, 2);
    assert.equal(git(root, 'rev-parse', 'HEAD'), git(remote, 'rev-parse', 'main'));
    context.verifyProjectSync = async () => false;
    await assert.rejects(context.gitSyncAll(root), /kept changing/);
    // Network failure is never translated into a successful verification.
    await assert.rejects(verifyProjectSync(async command => {
        if (command.startsWith('git branch')) return { stdout: 'main', stderr: '' };
        throw new Error('offline');
    }), /offline/);
    console.log('Verified sync passed: parent-only pushes, edited vendor, recursion disabled, divergence, truthful badges, remote race retry, failure stays failure');
})().catch(e => { console.error(e); process.exitCode = 1; }).finally(() => fs.rmSync(temp, { recursive: true, force: true }));
