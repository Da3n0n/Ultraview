const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { execFileSync } = require('node:child_process');
const Module = require('node:module');
const ts = require('typescript');
const filename = path.resolve('src/git/vendorRepositories.ts');
const instance = new Module(filename, module);
instance.filename = filename;
instance.paths = Module._nodeModulePaths(path.dirname(filename));
instance._compile(ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText, filename);
const { vendorRepositories } = instance.exports;
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'ultraview-vendor-test-'));
const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
function init(directory) {
    fs.mkdirSync(directory, { recursive: true });
    git(directory, 'init');
    git(directory, 'config', 'user.email', 'test@example.invalid');
    git(directory, 'config', 'user.name', 'Test');
}
function commit(directory) { git(directory, 'add', '-A'); git(directory, 'commit', '-m', 'fixture'); }
(async () => {
    const source = path.join(temp, 'source');
    const root = path.join(temp, 'project');
    init(source);
    fs.writeFileSync(path.join(source, 'LICENSE'), 'license retained');
    fs.writeFileSync(path.join(source, 'code.txt'), 'original');
    fs.writeFileSync(path.join(source, 'deleted.txt'), 'delete me');
    fs.writeFileSync(path.join(source, '.gitignore'), 'node_modules/\n');
    commit(source);
    init(root);
    fs.writeFileSync(path.join(root, 'README.md'), 'root');
    commit(root);
    git(root, '-c', 'protocol.file.allow=always', 'submodule', 'add', '--name', 'custom-name', source, 'vendor/video space');
    commit(root);
    const child = path.join(root, 'vendor/video space');
    fs.writeFileSync(path.join(child, 'code.txt'), 'local edits');
    fs.unlinkSync(path.join(child, 'deleted.txt'));
    fs.writeFileSync(path.join(child, 'new.txt'), 'untracked work');
    fs.mkdirSync(path.join(child, 'node_modules'));
    fs.writeFileSync(path.join(child, 'node_modules/generated'), 'ignored');
    // A standalone nested checkout must also become owned project files.
    const nested = path.join(child, 'nested');
    init(nested);
    fs.writeFileSync(path.join(nested, 'nested.txt'), 'nested content');
    commit(nested);
    fs.writeFileSync(path.join(root, '.gitignore'), 'vendor/\n');
    const imported = await vendorRepositories(root);
    assert.equal(imported.length, 2);
    assert.equal(fs.existsSync(path.join(child, '.git')), false);
    assert.equal(fs.existsSync(path.join(nested, '.git')), false);
    assert.equal(fs.readFileSync(path.join(child, 'code.txt'), 'utf8'), 'local edits');
    const staged = git(root, 'ls-files', '--stage');
    assert.ok(!staged.includes('160000 '));
    for (const file of ['LICENSE', 'code.txt', 'new.txt', 'nested/nested.txt']) assert.ok(staged.includes('vendor/video space/' + file));
    assert.ok(!staged.includes('deleted.txt'));
    assert.ok(!staged.includes('node_modules/generated'));
    assert.ok(!fs.readFileSync(path.join(root, '.gitmodules'), 'utf8').includes('custom-name'));
    assert.ok(fs.readdirSync(path.join(root, '.git')).some(name => name.startsWith('ultraview-import-')));
    assert.deepEqual(await vendorRepositories(root), []);
    commit(root);
    const clone = path.join(temp, 'clone');
    git(temp, 'clone', root, clone);
    assert.equal(fs.readFileSync(path.join(clone, 'vendor/video space/code.txt'), 'utf8'), 'local edits');
    assert.equal(fs.readFileSync(path.join(clone, 'vendor/video space/nested/nested.txt'), 'utf8'), 'nested content');
    console.log('Vendor import integration passed: edits, nested repositories, ignored files, metadata backup, repeat sync, clean clone');
})().catch(error => { console.error(error); process.exitCode = 1; }).finally(() => {
    // This exact temporary directory was created above, outside user projects.
    fs.rmSync(temp, { recursive: true, force: true });
});
