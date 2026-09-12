const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');
const { execFileSync } = require('node:child_process');
const ts = require('typescript');
const filename = path.resolve('src/git/gitBlobLimits.ts');
const instance = new Module(filename, module);
instance.filename = filename;
instance.paths = Module._nodeModulePaths(path.dirname(filename));
instance._compile(ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText, filename);
const { assertGitHubBlobSizes } = instance.exports;
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'uv-blob-test-'));
const git = (...args) => execFileSync('git', args, { cwd: temp, stdio: 'pipe' });
(async () => {
    git('init');
    git('remote', 'add', 'origin', 'https://github.com/example/test.git');
    await assertGitHubBlobSizes(temp, 1024);
    const model = path.join(temp, 'model with spaces.ckpt');
    fs.writeFileSync(model, Buffer.alloc(2048));
    git('add', '--', 'model with spaces.ckpt');
    fs.writeFileSync(model, 'now small in worktree');
    await assert.rejects(assertGitHubBlobSizes(temp, 1024), /model with spaces.ckpt/);
    assert.equal(fs.readFileSync(model, 'utf8'), 'now small in worktree');
    // A staged LFS pointer is publishable even when its worktree is large.
    fs.writeFileSync(model, 'version https://git-lfs.github.com/spec/v1\noid sha256:' + 'a'.repeat(64) + '\nsize 913106900\n');
    git('add', '--', 'model with spaces.ckpt');
    fs.writeFileSync(model, Buffer.alloc(2048));
    await assertGitHubBlobSizes(temp, 1024);
    git('add', '--', 'model with spaces.ckpt');
    git('remote', 'set-url', 'origin', 'https://example.invalid/repo.git');
    await assertGitHubBlobSizes(temp, 1024);
    console.log('Blob limit tests passed: staged size, spaces, preserved files, LFS pointers, other hosts');
})().catch(error => { console.error(error); process.exitCode = 1; }).finally(() => {
    fs.rmSync(temp, { recursive: true, force: true });
});
