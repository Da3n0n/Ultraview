const assert = require('assert');
const fs = require('fs');
const Module = require('module');
const os = require('os');
const path = require('path');
const ts = require('typescript');

const [mainJsPath, workbenchHtmlPath, workbenchJsPath, launcherJsPath] = process.argv.slice(2);
if (!mainJsPath || !workbenchHtmlPath || !workbenchJsPath) {
  throw new Error('Pass the VS Code main.js, workbench.html, and workbench.js paths.');
}

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ultraview-theme-test-'));
const backupRoot = path.join(tempRoot, 'global-storage');
const paths = {
  mainJs: path.join(tempRoot, 'out', 'main.js'),
  workbenchHtml: path.join(tempRoot, 'out', 'workbench.html'),
  workbenchJs: path.join(tempRoot, 'out', 'workbench.js'),
};
fs.mkdirSync(path.dirname(paths.mainJs), { recursive: true });

const originals = {
  mainJs: fs.readFileSync(mainJsPath),
  workbenchHtml: fs.readFileSync(workbenchHtmlPath),
  workbenchJs: fs.readFileSync(workbenchJsPath),
};
for (const key of Object.keys(paths)) {
  fs.writeFileSync(paths[key], originals[key]);
}

const vscodeMock = { env: { appRoot: tempRoot } };
let source = fs.readFileSync(path.join(__dirname, '..', 'src', 'theme', 'index.ts'), 'utf8');
source += `\nexport const __themeHarness = { applyTransparentPatch, restoreTransparentPatch, resolveInstallPaths };`;
const compiled = ts.transpileModule(source, {
  compilerOptions: {
    esModuleInterop: true,
    module: ts.ModuleKind.CommonJS,
    target: ts.ScriptTarget.ES2020,
  },
}).outputText;

const testModule = new Module(path.join(__dirname, 'theme-roundtrip.generated.js'), module);
testModule.filename = path.join(__dirname, 'theme-roundtrip.generated.js');
testModule.paths = Module._nodeModulePaths(__dirname);
const normalRequire = testModule.require.bind(testModule);
testModule.require = (id) => (id === 'vscode' ? vscodeMock : normalRequire(id));
testModule._compile(compiled, testModule.filename);

const harness = testModule.exports.__themeHarness;
const context = { globalStorageUri: { fsPath: backupRoot } };
const darkTheme = JSON.parse(
  fs.readFileSync(
    path.join(__dirname, '..', 'themes', 'ultraview-transparent-dark-color-theme.json'),
    'utf8',
  ),
);

assert.strictEqual(darkTheme.include, './ultraview-transparent-color-theme.json');
assert.strictEqual(darkTheme.type, 'dark');

try {
  // Exercise both the legacy bundle and the 1.140 compile-cache launcher.
  assert.strictEqual(harness.resolveInstallPaths(tempRoot).mainJs, paths.mainJs);
  harness.applyTransparentPatch(context, paths, 'acrylic');
  assert.strictEqual(harness.restoreTransparentPatch(context, paths), true);
  for (const key of Object.keys(paths)) {
    assert.deepStrictEqual(fs.readFileSync(paths[key]), originals[key]);
  }
  const launcherPath = paths.mainJs;
  const launcher = launcherJsPath ? fs.readFileSync(launcherJsPath, 'utf8') : 'await import("./mainImpl.js");';
  const implementationPath = path.join(path.dirname(launcherPath), 'mainImpl.js');
  fs.writeFileSync(launcherPath, launcher);
  assert.throws(() => harness.resolveInstallPaths(tempRoot), /Could not locate.*mainImpl/);
  fs.writeFileSync(implementationPath, originals.mainJs);
  assert.strictEqual(harness.resolveInstallPaths(tempRoot).mainJs, implementationPath);
  paths.mainJs = implementationPath;

  harness.applyTransparentPatch(context, paths, 'acrylic');
  const patchedMain = fs.readFileSync(paths.mainJs, 'utf8');
  assert.match(patchedMain, /backgroundMaterial:"acrylic"\/\*ultraview-transparent-patched\*\//);
  assert.doesNotMatch(patchedMain, /transparent:!0,backgroundMaterial:"acrylic"/);
  assert.match(patchedMain, /backgroundColor:"#00000000"/);
  assert.match(patchedMain, /ultraview-transparent-patched-window-bg/);
  const patchedHtml = fs.readFileSync(paths.workbenchHtml, 'utf8');
  assert.match(patchedHtml, /ultraview-transparent-patched/);
  assert.match(patchedHtml, /--vscode-editor-background: transparent !important/);
  assert.match(patchedHtml, /--vscode-agentsPanel-background: transparent !important/);
  assert.match(patchedHtml, /--modern-ui-shell-background: transparent !important/);
  assert.match(patchedHtml, /\.monaco-workbench > \.monaco-grid-view/);
  assert.match(patchedHtml, /\.monaco-workbench \.monaco-editor-background/);
  assert.match(patchedHtml, /\[class\*="ultraview-transparent-dark"\]/);
  assert.match(patchedHtml, /background-color: rgba\(0, 0, 0, \.28\) !important/);
  assert.match(patchedHtml, /rgba\(30, 30, 30, 1\) 0%/);
  assert.doesNotMatch(patchedHtml, /backdrop-filter: blur\(18px\)/);
  assert.match(fs.readFileSync(paths.workbenchJs, 'utf8'), /ultraview-transparent-patched/);

  // Re-enabling must be idempotent and disabling must restore exact bytes.
  harness.applyTransparentPatch(context, paths, 'acrylic');
  assert.strictEqual(harness.restoreTransparentPatch(context, paths), true);
  for (const key of Object.keys(paths)) {
    assert.deepStrictEqual(fs.readFileSync(paths[key]), originals[key]);
  }
  assert.strictEqual(harness.restoreTransparentPatch(context, paths), false);
  assert.strictEqual(fs.readFileSync(launcherPath, 'utf8'), launcher);
  console.log('Ultraview transparency enable/disable round trip passed.');
} finally {
  fs.rmSync(tempRoot, { recursive: true, force: true });
}
