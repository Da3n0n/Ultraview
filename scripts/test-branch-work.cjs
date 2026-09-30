const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const cp = require('node:child_process');
const Module = require('node:module');
const ts = require('typescript');
let choose = () => undefined, contents;
const vscode = {
    window: { showQuickPick: async items => choose(items), showInformationMessage: async () => undefined, showTextDocument: async () => {} },
    workspace: { openTextDocument: async options => { contents = options.content; return options; } },
};
const filename = path.resolve('src/git/branchWork.ts'), m = new Module(filename, module);
m.filename = filename; m.paths = Module._nodeModulePaths(path.dirname(filename));
const originalRequire = m.require.bind(m);
m.require = name => name === 'vscode' ? vscode : originalRequire(name);
m._compile(ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText, filename);
const { showBranchWork } = m.exports;
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'uv-branch-work-'));
const git = (...args) => cp.execFileSync('git', args, { cwd: temp, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
function commit(file, value) { fs.writeFileSync(path.join(temp, file), value); git('add', '-A'); git('commit', '-qm', 'fixture'); }
(async () => {
    git('init', '-b', 'main'); git('config', 'user.name', 'Test'); git('config', 'user.email', 'test@example.invalid');
    commit('shared.txt', 'base');
    git('switch', '-c', 'feature'); commit('feature.txt', 'feature-only');
    const featureHead = git('rev-parse', 'HEAD');
    git('switch', 'main'); commit('main.txt', 'main-only');
    const mainHead = git('rev-parse', 'HEAD');
    fs.writeFileSync(path.join(temp, 'shared.txt'), 'dirty main');
    fs.writeFileSync(path.join(temp, 'untracked.txt'), 'new');
    const statusBefore = git('status', '--porcelain');
    choose = items => {
        const feature = items.find(item => item.label === 'feature');
        assert.match(feature.description, /1 commits not in main · 1 main commits missing/);
        return feature;
    };
    await showBranchWork(temp);
    assert.match(contents, /Committed work on feature/);
    assert.match(contents, /\+feature-only/);
    assert.doesNotMatch(contents, /-main-only|dirty main/);
    assert.equal(git('branch', '--show-current'), 'main');
    assert.equal(git('rev-parse', 'main'), mainHead);
    assert.equal(git('rev-parse', 'feature'), featureHead);
    assert.equal(git('status', '--porcelain'), statusBefore);
    choose = items => items.find(item => item.label === 'Current files on disk');
    await showBranchWork(temp);
    assert.match(contents, /\+dirty main/);
    assert.match(contents, /untracked\.txt/);
    assert.doesNotMatch(contents, /feature-only/);
    // Squashed/cherry-picked history can differ even when the files are identical; show both concepts clearly.
    git('update-ref', 'refs/remotes/origin/feature', featureHead);
    choose = items => { assert.equal(items.filter(item => item.label.includes('feature')).length, 1); return undefined; };
    await showBranchWork(temp);
    assert.equal(git('status', '--porcelain'), statusBefore);
    console.log('Branch work passed: main/feature divergence counts, contribution diff, current-files diff, untracked files listed, cancellation, duplicate remote omitted; refs and checkout unchanged.');
})().catch(e => { console.error(e); process.exitCode = 1; }).finally(() => {
    if (path.dirname(temp) === os.tmpdir() && path.basename(temp).startsWith('uv-branch-work-')) fs.rmSync(temp, { recursive: true, force: true });
});
