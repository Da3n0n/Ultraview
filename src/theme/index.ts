import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import * as vscode from 'vscode';

const ENABLE_COMMAND = 'ultraview.enableTransparent';
const DISABLE_COMMAND = 'ultraview.disableTransparent';
const THEME_LABEL = 'Ultraview Transparent';
const STATE_PREVIOUS_THEME = 'ultraview.transparent.previousTheme';
const STATE_ENABLED = 'ultraview.transparent.enabled';

const PATCH_MARKER = 'ultraview-transparent-patched';
const WINDOW_BACKGROUND_MARKER = `${PATCH_MARKER}-window-bg`;
const HTML_MARKER = '<!-- ultraview-transparent-patched -->';
const HTML_MARKER_END = '<!-- /ultraview-transparent-patched -->';
const REQUIRED_LATE_WORKBENCH_PATCH = '.monaco-workbench > .monaco-grid-view';
// Windhawk owns the tint (currently 3A232323 on this machine), just as it does
// for UltraBrowse. Adding a second renderer tint would make VS Code darker.
const DEFAULT_OPACITY = 0;
const DEFAULT_FALLBACK_THEME = 'Default Dark Modern';
const BACKUP_FOLDER = 'transparent-backups';

type EffectType = 'mica' | 'acrylic' | 'tabbed' | 'auto' | 'none';

interface InstallPaths {
  mainJs: string;
  workbenchHtml: string;
  workbenchJs: string;
}

interface InstallSnapshot {
  mainJs: Buffer;
  workbenchHtml: Buffer;
  workbenchJs: Buffer;
}

interface BackupManifest {
  appRoot: string;
  paths: Record<keyof InstallSnapshot, string>;
  hashes: Record<keyof InstallSnapshot, string>;
}

interface MainPatch {
  find: RegExp[];
  replace: string;
  patched: RegExp[];
  original: string[];
  required: boolean;
}

export function registerThemeCommands(context: vscode.ExtensionContext): void {
  context.subscriptions.push(
    vscode.commands.registerCommand(ENABLE_COMMAND, async () => {
      await enableTransparent(context);
    }),
    vscode.commands.registerCommand(DISABLE_COMMAND, async () => {
      await disableTransparent(context);
    }),
  );

  void repairTransparentPatchAfterUpdate(context);
}

async function enableTransparent(context: vscode.ExtensionContext): Promise<void> {
  try {
    const paths = resolveInstallPaths(vscode.env.appRoot);
    applyTransparentPatch(context, paths, getPreferredEffect());
    await rememberCurrentTheme(context);
    await setWorkbenchTheme(THEME_LABEL);
    await context.globalState.update(STATE_ENABLED, true);

    void vscode.window.showInformationMessage(
      'Ultraview Transparent is enabled. Fully close and reopen the IDE to apply translucency.',
    );
  } catch (error) {
    handleThemeError('enable transparent mode', error);
  }
}

async function disableTransparent(context: vscode.ExtensionContext): Promise<void> {
  try {
    const paths = resolveInstallPaths(vscode.env.appRoot);
    const removed = restoreTransparentPatch(context, paths);

    await context.globalState.update(STATE_ENABLED, false);
    await restorePreviousTheme(context);

    if (!removed) {
      void vscode.window.showInformationMessage(
        'Ultraview Transparent was already disabled. Your previous theme has been restored if it was saved.',
      );
      return;
    }

    void vscode.window.showInformationMessage(
      'Ultraview Transparent is disabled. Fully close and reopen the IDE to remove translucency.',
    );
  } catch (error) {
    handleThemeError('disable transparent mode', error);
  }
}

async function repairTransparentPatchAfterUpdate(
  context: vscode.ExtensionContext,
): Promise<void> {
  const wasEnabled = context.globalState.get<boolean>(STATE_ENABLED);
  const enabled = wasEnabled === true || getCurrentTheme() === THEME_LABEL;
  if (!enabled) {
    return;
  }

  try {
    const paths = resolveInstallPaths(vscode.env.appRoot);
    const effect = getPreferredEffect();
    if (await isTransparentPatchCurrent(paths, effect)) {
      if (wasEnabled !== true) {
        await context.globalState.update(STATE_ENABLED, true);
      }
      return;
    }

    // Never rewrite IDE installation files during extension activation. If an
    // IDE update or repair replaced the patch, leave that verified clean build
    // bootable and require an explicit command before touching it again.
    await context.globalState.update(STATE_ENABLED, false);
    await restorePreviousTheme(context);

    void vscode.window.showWarningMessage(
      'VS Code was updated or repaired, so Ultraview left its installation files untouched. Run “Ultraview: Enable Transparent” explicitly if you want to enable it for this build.',
    );
  } catch (error) {
    handleThemeError('check transparent mode after the IDE update', error);
  }
}

async function isTransparentPatchCurrent(paths: InstallPaths, effect: EffectType): Promise<boolean> {
  const [mainJs, workbenchHtml, workbenchJs] = await Promise.all([
    fs.promises.readFile(paths.mainJs, 'utf8'),
    fs.promises.readFile(paths.workbenchHtml, 'utf8'),
    fs.promises.readFile(paths.workbenchJs, 'utf8'),
  ]);
  const hasTransparentWindow =
    effect === 'none'
      ? mainJs.includes(`transparent:!0/*${PATCH_MARKER}*/`)
      : mainJs.includes(`backgroundMaterial:"${effect}"/*${PATCH_MARKER}*/`);

  return (
    hasTransparentWindow &&
    workbenchHtml.includes(HTML_MARKER) &&
    workbenchHtml.includes(HTML_MARKER_END) &&
    workbenchHtml.includes(REQUIRED_LATE_WORKBENCH_PATCH) &&
    workbenchJs.includes(PATCH_MARKER)
  );
}

async function rememberCurrentTheme(context: vscode.ExtensionContext): Promise<void> {
  const currentTheme = getCurrentTheme();
  if (currentTheme && currentTheme !== THEME_LABEL) {
    await context.globalState.update(STATE_PREVIOUS_THEME, currentTheme);
  }
}

async function restorePreviousTheme(context: vscode.ExtensionContext): Promise<void> {
  const currentTheme = getCurrentTheme();
  const previousTheme = context.globalState.get<string>(STATE_PREVIOUS_THEME);
  const nextTheme =
    previousTheme && previousTheme !== THEME_LABEL
      ? previousTheme
      : currentTheme === THEME_LABEL
        ? DEFAULT_FALLBACK_THEME
        : undefined;

  if (nextTheme) {
    await setWorkbenchTheme(nextTheme);
  }

  await context.globalState.update(STATE_PREVIOUS_THEME, undefined);
}

function getCurrentTheme(): string | undefined {
  return vscode.workspace
    .getConfiguration('workbench')
    .get<string>('colorTheme');
}

async function setWorkbenchTheme(themeName: string): Promise<void> {
  await vscode.workspace
    .getConfiguration('workbench')
    .update('colorTheme', themeName, vscode.ConfigurationTarget.Global);
}

function resolveInstallPaths(appRoot: string): InstallPaths {
  return {
    mainJs: resolveFile(appRoot, [
      ['out', 'main.js'],
      ['out', 'vs', 'code', 'electron-main', 'main.js'],
      ['out', 'vs', 'code', 'electron-main', 'main.bundle.js'],
    ], ['main.js', 'main.bundle.js']),
    workbenchHtml: resolveFile(appRoot, [
      ['out', 'vs', 'code', 'electron-browser', 'workbench', 'workbench.html'],
      ['out', 'vs', 'code', 'browser', 'workbench', 'workbench.html'],
    ], ['workbench.html']),
    workbenchJs: resolveFile(appRoot, [
      ['out', 'vs', 'code', 'electron-browser', 'workbench', 'workbench.js'],
      ['out', 'vs', 'code', 'browser', 'workbench', 'workbench.js'],
    ], ['workbench.js']),
  };
}

function resolveFile(appRoot: string, candidateSegments: string[][], recursiveNames: string[]): string {
  for (const segments of candidateSegments) {
    const candidate = path.join(appRoot, ...segments);
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }

  const outDir = path.join(appRoot, 'out');
  const found = findFirstMatchingFile(outDir, recursiveNames);
  if (found) {
    return found;
  }

  throw new Error(`Could not locate ${recursiveNames.join(' or ')} under ${appRoot}`);
}

function findFirstMatchingFile(startDir: string, names: string[]): string | undefined {
  if (!fs.existsSync(startDir)) {
    return undefined;
  }

  const stack = [startDir];
  while (stack.length > 0) {
    const current = stack.pop();
    if (!current) {
      continue;
    }

    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      const fullPath = path.join(current, entry.name);
      if (entry.isFile() && names.includes(entry.name)) {
        return fullPath;
      }
      if (entry.isDirectory() && !shouldSkipDirectory(entry.name)) {
        stack.push(fullPath);
      }
    }
  }

  return undefined;
}

function shouldSkipDirectory(name: string): boolean {
  return name.startsWith('.') || name === 'node_modules';
}

function getPreferredEffect(): EffectType {
  // Match UltraBrowse's Windows composition path exactly: keep a normal,
  // non-layered Electron window and request Acrylic so DWM is initialized.
  // The Translucent Windows Windhawk mod intercepts that native request and
  // supplies AccentBlurBehind, while the renderer patches below expose it.
  // Never use Electron's `transparent: true` on Windows: it creates a layered
  // square-cornered window and has regressed across recent Electron releases.
  return process.platform === 'win32' ? 'acrylic' : 'none';
}

function applyTransparentPatch(
  context: vscode.ExtensionContext,
  paths: InstallPaths,
  effect: EffectType,
): void {
  const current = readInstallSnapshot(paths);
  const savedOriginal = loadInstallBackup(context, paths);
  const currentIsPatched = snapshotHasPatch(current);
  let original: InstallSnapshot;
  if (currentIsPatched) {
    if (!savedOriginal) {
      throw new Error(
        'This VS Code build has a legacy transparency patch without an exact backup. Repair or reinstall VS Code once before enabling; Ultraview left every file unchanged.',
      );
    }
    original = savedOriginal;
  } else {
    original = current;
  }

  validateOriginalSnapshot(original);
  if (!savedOriginal || !currentIsPatched) {
    saveInstallBackup(context, paths, original);
    // Keep a pre-enable copy of product.json in sync with the file backup
    // (same fresh-enable condition) for manual recovery. Never throws.
    backupProductJsonBestEffort(context);
  }

  const patched: InstallSnapshot = {
    mainJs: Buffer.from(
      patchMainJsContent(original.mainJs.toString('utf8'), effect),
      'utf8',
    ),
    workbenchHtml: Buffer.from(
      patchWorkbenchHtmlContent(
        original.workbenchHtml.toString('utf8'),
        DEFAULT_OPACITY,
      ),
      'utf8',
    ),
    workbenchJs: Buffer.from(
      patchWorkbenchJsContent(original.workbenchJs.toString('utf8')),
      'utf8',
    ),
  };

  validatePatchedSnapshot(patched, effect);
  writeInstallSnapshot(paths, patched, current);
  // Best-effort: update product.json checksums to the patched files so the
  // IDE integrity check passes and the "installation appears to be corrupt"
  // warning stays silent. Never throws; transparency works regardless.
  syncProductChecksumsBestEffort(paths);
}

function restoreTransparentPatch(
  context: vscode.ExtensionContext,
  paths: InstallPaths,
): boolean {
  const current = readInstallSnapshot(paths);
  if (!snapshotHasPatch(current)) {
    return false;
  }

  const original = loadInstallBackup(context, paths);
  if (!original) {
    throw new Error(
      'This legacy transparency patch has no exact backup, so Ultraview refused an unsafe guessed restore. Repair or reinstall VS Code to recover its original files.',
    );
  }
  validateOriginalSnapshot(original);
  writeInstallSnapshot(paths, original, current);
  // Best-effort: re-sync checksums to the restored originals so the
  // integrity check passes after disabling too. Never throws.
  syncProductChecksumsBestEffort(paths);
  return true;
}

function readInstallSnapshot(paths: InstallPaths): InstallSnapshot {
  return {
    mainJs: fs.readFileSync(paths.mainJs),
    workbenchHtml: fs.readFileSync(paths.workbenchHtml),
    workbenchJs: fs.readFileSync(paths.workbenchJs),
  };
}

function snapshotHasPatch(snapshot: InstallSnapshot): boolean {
  return Object.values(snapshot).some((content) =>
    content.includes(Buffer.from(PATCH_MARKER)),
  );
}

function validateOriginalSnapshot(snapshot: InstallSnapshot): void {
  if (snapshotHasPatch(snapshot)) {
    throw new Error('The saved VS Code originals still contain an Ultraview patch marker. No files were changed.');
  }

  const mainJs = snapshot.mainJs.toString('utf8');
  const workbenchHtml = snapshot.workbenchHtml.toString('utf8');
  if (!mainJs.includes('experimentalDarkMode') || !mainJs.includes('backgroundColor')) {
    throw new Error('The VS Code main process backup failed structural validation. No files were changed.');
  }
  if (!workbenchHtml.includes('</head>')) {
    throw new Error('The VS Code workbench backup failed structural validation. No files were changed.');
  }
}

function validatePatchedSnapshot(
  snapshot: InstallSnapshot,
  effect: EffectType,
): void {
  const mainJs = snapshot.mainJs.toString('utf8');
  const workbenchHtml = snapshot.workbenchHtml.toString('utf8');
  const workbenchJs = snapshot.workbenchJs.toString('utf8');
  const windowPatch =
    effect === 'none'
      ? `transparent:!0/*${PATCH_MARKER}*/`
      : `backgroundMaterial:"${effect}"/*${PATCH_MARKER}*/`;

  if (
    !mainJs.includes(windowPatch) ||
    !workbenchHtml.includes(HTML_MARKER) ||
    !workbenchHtml.includes(HTML_MARKER_END) ||
    !workbenchHtml.includes(REQUIRED_LATE_WORKBENCH_PATCH) ||
    !workbenchJs.includes(PATCH_MARKER)
  ) {
    throw new Error('The generated transparency patch failed validation. No files were changed.');
  }
}

function writeInstallSnapshot(
  paths: InstallPaths,
  next: InstallSnapshot,
  rollback: InstallSnapshot,
): void {
  const writes: Array<[keyof InstallSnapshot, string]> = [
    ['workbenchHtml', paths.workbenchHtml],
    ['workbenchJs', paths.workbenchJs],
    ['mainJs', paths.mainJs],
  ];
  const completed: Array<[keyof InstallSnapshot, string]> = [];

  try {
    for (const [key, filePath] of writes) {
      fs.writeFileSync(filePath, next[key]);
      completed.push([key, filePath]);
    }
  } catch (error) {
    for (const [key, filePath] of completed.reverse()) {
      try {
        fs.writeFileSync(filePath, rollback[key]);
      } catch {
        // Preserve the first write error; the exact backup remains on disk.
      }
    }
    throw error;
  }
}

function getBackupDirectory(context: vscode.ExtensionContext): string {
  const installId = crypto
    .createHash('sha256')
    .update(path.resolve(vscode.env.appRoot).toLowerCase())
    .digest('hex')
    .slice(0, 20);
  return path.join(context.globalStorageUri.fsPath, BACKUP_FOLDER, installId);
}

const PRODUCT_JSON_NAME = 'product.json';
const PRODUCT_BACKUP_NAME = 'product.json.original';

function getProductJsonPath(): string {
  return path.join(vscode.env.appRoot, PRODUCT_JSON_NAME);
}

function toChecksumKey(absolutePath: string): string | undefined {
  // product.json checksum keys are relative to the `out/` build directory
  // (e.g. `vs/code/electron-browser/workbench/workbench.html`), not to the
  // app root, so try `out/` first and fall back to the app root itself.
  for (const base of [path.join(vscode.env.appRoot, 'out'), vscode.env.appRoot]) {
    const relative = path.relative(base, absolutePath);
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
      continue;
    }
    return relative.split(path.sep).join('/');
  }
  return undefined;
}

function computeChecksumBase64NoPad(content: Buffer): string {
  // Same scheme as the IDE integrity check (SHA-256, base64, no padding —
  // VS Code switched from MD5 in early 2024). MD5 values can never match,
  // so writing them makes the warning permanent instead of silencing it.
  return crypto.createHash('sha256').update(content).digest('base64').replace(/=+$/, '');
}

function backupProductJsonBestEffort(context: vscode.ExtensionContext): void {
  try {
    const productPath = getProductJsonPath();
    if (!fs.existsSync(productPath)) {
      return;
    }
    const backupDir = getBackupDirectory(context);
    fs.mkdirSync(backupDir, { recursive: true });
    fs.copyFileSync(productPath, path.join(backupDir, PRODUCT_BACKUP_NAME));
  } catch {
    // Best-effort only: transparency must keep working even if the backup fails.
  }
}

function syncProductChecksumsBestEffort(paths: InstallPaths): void {
  try {
    const productPath = getProductJsonPath();
    if (!fs.existsSync(productPath)) {
      return;
    }
    const product = JSON.parse(fs.readFileSync(productPath, 'utf8')) as {
      checksums?: Record<string, string>;
    };
    if (!product || typeof product !== 'object' || !product.checksums || typeof product.checksums !== 'object') {
      return; // Forks/builds without a checksum manifest: nothing to silence.
    }
    // Only touch our own patched files; never mask corruption elsewhere.
    const files: string[] = [paths.mainJs, paths.workbenchHtml, paths.workbenchJs];
    let changed = false;
    for (const file of files) {
      const key = toChecksumKey(file);
      if (!key || !(key in product.checksums) || !fs.existsSync(file)) {
        continue;
      }
      const checksum = computeChecksumBase64NoPad(fs.readFileSync(file));
      if (product.checksums[key] !== checksum) {
        product.checksums[key] = checksum;
        changed = true;
      }
    }
    if (changed) {
      fs.writeFileSync(productPath, JSON.stringify(product, null, '\t'), 'utf8');
    }
  } catch {
    // Best-effort only: a failed checksum sync must never break transparency.
    // The IDE will simply show its standard warning until the next enable.
  }
}

function saveInstallBackup(
  context: vscode.ExtensionContext,
  paths: InstallPaths,
  snapshot: InstallSnapshot,
): void {
  const backupDir = getBackupDirectory(context);
  fs.mkdirSync(backupDir, { recursive: true });

  const backupNames: Record<keyof InstallSnapshot, string> = {
    mainJs: 'main.js.original',
    workbenchHtml: 'workbench.html.original',
    workbenchJs: 'workbench.js.original',
  };
  const installPaths: Record<keyof InstallSnapshot, string> = {
    mainJs: paths.mainJs,
    workbenchHtml: paths.workbenchHtml,
    workbenchJs: paths.workbenchJs,
  };
  const hashes = {} as Record<keyof InstallSnapshot, string>;
  const relativePaths = {} as Record<keyof InstallSnapshot, string>;

  for (const key of Object.keys(backupNames) as Array<keyof InstallSnapshot>) {
    fs.writeFileSync(path.join(backupDir, backupNames[key]), snapshot[key]);
    hashes[key] = hashBuffer(snapshot[key]);
    relativePaths[key] = path.relative(vscode.env.appRoot, installPaths[key]);
  }

  const manifest: BackupManifest = {
    appRoot: path.resolve(vscode.env.appRoot),
    paths: relativePaths,
    hashes,
  };
  fs.writeFileSync(
    path.join(backupDir, 'manifest.json'),
    JSON.stringify(manifest, null, 2),
    'utf8',
  );
}

function loadInstallBackup(
  context: vscode.ExtensionContext,
  paths: InstallPaths,
): InstallSnapshot | undefined {
  const backupDir = getBackupDirectory(context);
  const manifestPath = path.join(backupDir, 'manifest.json');
  if (!fs.existsSync(manifestPath)) {
    return undefined;
  }

  try {
    const manifest = JSON.parse(
      fs.readFileSync(manifestPath, 'utf8'),
    ) as BackupManifest;
    if (path.resolve(manifest.appRoot) !== path.resolve(vscode.env.appRoot)) {
      return undefined;
    }

    const snapshot: InstallSnapshot = {
      mainJs: fs.readFileSync(path.join(backupDir, 'main.js.original')),
      workbenchHtml: fs.readFileSync(
        path.join(backupDir, 'workbench.html.original'),
      ),
      workbenchJs: fs.readFileSync(path.join(backupDir, 'workbench.js.original')),
    };
    const currentPaths: Record<keyof InstallSnapshot, string> = {
      mainJs: paths.mainJs,
      workbenchHtml: paths.workbenchHtml,
      workbenchJs: paths.workbenchJs,
    };

    for (const key of Object.keys(snapshot) as Array<keyof InstallSnapshot>) {
      if (
        manifest.paths[key] !==
          path.relative(vscode.env.appRoot, currentPaths[key]) ||
        manifest.hashes[key] !== hashBuffer(snapshot[key])
      ) {
        return undefined;
      }
    }
    return snapshot;
  } catch {
    return undefined;
  }
}

function hashBuffer(content: Buffer): string {
  return crypto.createHash('sha256').update(content).digest('hex');
}

function buildMainPatches(effect: EffectType): MainPatch[] {
  const patches: MainPatch[] = [
    {
      find: [
        /backgroundColor\s*:\s*n\.getBackgroundColor\(\)\s*,/,
        /backgroundColor\s*:\s*[^,;{}]+?\.getBackgroundColor\(\)\s*,/,
        /backgroundColor\s*:\s*getBackgroundColor\([^)]*\)\s*,/,
      ],
      replace: `backgroundColor:"#00000000",/*${PATCH_MARKER}*/`,
      patched: [new RegExp(`backgroundColor\\s*:\\s*"#00000000"\\s*,\\s*/\\*${PATCH_MARKER}\\*/`)],
      original: [
        'backgroundColor:n.getBackgroundColor(),',
        'backgroundColor:getBackgroundColor(),',
      ],
      required: true,
    },
    {
      find: [
        /n\.setBackgroundColor\(t\.colorInfo\.background\)\s*;/,
      ],
      replace: `0/*${PATCH_MARKER}*/;`,
      patched: [
        new RegExp(`0\\s*/\\*${PATCH_MARKER}\\*/\\s*;`),
      ],
      original: [
        'n.setBackgroundColor(t.colorInfo.background);',
      ],
      required: false,
    },
    {
      find: [
        /\b([\w$]+)\.setBackgroundColor\(([\w$]+)\.colorInfo\.background\)/,
        /for\(const n of Kee\(\)\)if\(n\.id===t\)\{n\.setBackgroundColor\(r\.colorInfo\.background\);break\}/,
      ],
      replace: `0/*${WINDOW_BACKGROUND_MARKER}:$1.setBackgroundColor($2.colorInfo.background)*/`,
      patched: [
        new RegExp(`0\\s*/\\*${WINDOW_BACKGROUND_MARKER}:[^*]+\\*/`),
      ],
      original: [
        'n.setBackgroundColor(r.colorInfo.background)',
      ],
      required: false,
    },
    {
      find: [
        /this\._view\.setBackgroundColor\("#FFFFFF"\)/,
        /this\._view\.setBackgroundColor\("#FFF(?:FFF)?"\)/,
        /_view\.setBackgroundColor\("#FFF(?:FFF)?"\)/,
      ],
      replace: `this._view.setBackgroundColor("#00000000")/*${PATCH_MARKER}*/`,
      patched: [
        new RegExp(`this\\._view\\.setBackgroundColor\\("#00000000"\\)\\s*/\\*${PATCH_MARKER}\\*/`),
        new RegExp(`_view\\.setBackgroundColor\\("#00000000"\\)\\s*/\\*${PATCH_MARKER}\\*/`),
      ],
      original: [
        'this._view.setBackgroundColor("#FFFFFF")',
        'this._view.setBackgroundColor("#FFF")',
      ],
      required: false,
    },
  ];

  if (effect === 'none') {
    patches.push({
      find: [
        /experimentalDarkMode\s*:\s*!0\s*}/,
        /experimentalDarkMode\s*:\s*true\s*}/,
      ],
      replace: `experimentalDarkMode:!0,transparent:!0/*${PATCH_MARKER}*/}`,
      patched: [
        new RegExp(`experimentalDarkMode\\s*:\\s*!0\\s*,\\s*transparent\\s*:\\s*!0\\s*/\\*${PATCH_MARKER}\\*/\\s*}`),
        new RegExp(`experimentalDarkMode\\s*:\\s*true\\s*,\\s*transparent\\s*:\\s*!0\\s*/\\*${PATCH_MARKER}\\*/\\s*}`),
      ],
      original: ['experimentalDarkMode:!0}', 'experimentalDarkMode:true}'],
      required: true,
    });
  } else {
    patches.push({
      find: [
        /experimentalDarkMode\s*:\s*!0\s*}/,
        /experimentalDarkMode\s*:\s*true\s*}/,
      ],
      replace: `experimentalDarkMode:!0,backgroundMaterial:"${effect}"/*${PATCH_MARKER}*/}`,
      patched: [
        new RegExp(`experimentalDarkMode\\s*:\\s*!0\\s*,\\s*transparent\\s*:\\s*!0\\s*,\\s*backgroundMaterial\\s*:\\s*"${effect}"\\s*/\\*${PATCH_MARKER}\\*/\\s*}`),
        new RegExp(`experimentalDarkMode\\s*:\\s*true\\s*,\\s*transparent\\s*:\\s*!0\\s*,\\s*backgroundMaterial\\s*:\\s*"${effect}"\\s*/\\*${PATCH_MARKER}\\*/\\s*}`),
        new RegExp(`experimentalDarkMode\\s*:\\s*!0\\s*,\\s*backgroundMaterial\\s*:\\s*"${effect}"\\s*/\\*${PATCH_MARKER}\\*/\\s*}`),
        new RegExp(`experimentalDarkMode\\s*:\\s*true\\s*,\\s*backgroundMaterial\\s*:\\s*"${effect}"\\s*/\\*${PATCH_MARKER}\\*/\\s*}`),
      ],
      original: [
        'experimentalDarkMode:!0}',
        'experimentalDarkMode:true}',
        'experimentalDarkMode:!0}',
        'experimentalDarkMode:true}',
      ],
      required: true,
    });
  }

  return patches;
}

function patchMainJsContent(content: string, effect: EffectType): string {
  content = unpatchMainJsContent(content);

  for (const patch of buildMainPatches(effect)) {
    const pattern = patch.find.find((candidate) => candidate.test(content));
    if (!pattern) {
      if (!patch.required) {
        continue;
      }

      throw new Error(`Could not find expected VS Code main-process code for ${patch.find.map((candidate) => candidate.source).join(' OR ')}`);
    }
    content = content.replace(pattern, patch.replace);
  }

  return content;
}

function unpatchMainJsContent(content: string): string {
  content = content.replace(
    new RegExp(`0\\s*/\\*${PATCH_MARKER}-antigravity-window-bg\\*/\\s*;?`, 'g'),
    'for(const n of Kee())if(n.id===t){n.setBackgroundColor(r.colorInfo.background);break}',
  );

  content = content.replace(
    new RegExp(`0\\s*/\\*${WINDOW_BACKGROUND_MARKER}:([^*]+)\\*/`, 'g'),
    '$1',
  );

  for (const effect of ['mica', 'acrylic', 'tabbed', 'auto', 'none'] as EffectType[]) {
    for (const patch of buildMainPatches(effect)) {
      for (const [index, patchedPattern] of patch.patched.entries()) {
        if (!patchedPattern.test(content)) {
          continue;
        }

        const original = patch.original[index] ?? patch.original[0] ?? '';
        content = content.replace(patchedPattern, original);
      }
    }
  }

  return content;
}

function patchWorkbenchHtmlContent(content: string, opacity: number): string {
  content = stripWorkbenchHtmlPatch(content);

  if (!content.includes('</head>')) {
    throw new Error('Could not find </head> in the VS Code workbench');
  }

  const styleBlock = [
    '',
    `\t\t${HTML_MARKER}`,
    `\t\t<style>${buildWorkbenchCss(opacity)}</style>`,
    `\t\t${HTML_MARKER_END}`,
  ].join('\n');

  return content.replace('</head>', `${styleBlock}\n\t</head>`);
}

function stripWorkbenchHtmlPatch(content: string): string {
  const start = content.indexOf(HTML_MARKER);
  const end = content.indexOf(HTML_MARKER_END);
  if (start === -1 || end === -1) {
    return content;
  }

  const lineStart = content.lastIndexOf('\n', start);
  const removalStart = lineStart === -1 ? start : lineStart;
  const removalEnd = end + HTML_MARKER_END.length;
  return content.slice(0, removalStart) + content.slice(removalEnd);
}

function patchWorkbenchJsContent(content: string): string {
  const find =
    /background-color:\s*(\$\{[^}]+\})\s*;\s*color:\s*(\$\{[^}]+\})\s*;\s*margin:\s*0;\s*padding:\s*0;\s*}/;
  const replacement =
    `background-color:transparent;color:$2;margin:0;padding:0;}/*${PATCH_MARKER}:$1*/` +
    '#monaco-parts-splash,#monaco-parts-splash *{background-color:transparent!important}' +
    `/*${PATCH_MARKER}*/`;

  content = unpatchWorkbenchJsContent(content);

  if (!find.test(content)) {
    throw new Error('Could not find splash screen styles in the VS Code workbench');
  }

  return content.replace(find, replacement);
}

function unpatchWorkbenchJsContent(content: string): string {
  const patched =
    new RegExp(
      `background-color:\\s*transparent\\s*;\\s*color:\\s*(\\$\\{[^}]+\\})\\s*;\\s*margin:\\s*0;\\s*padding:\\s*0;\\s*}` +
        `/\\*${PATCH_MARKER}:(\\$\\{[^}]+\\})\\*/` +
        `\\s*#monaco-parts-splash\\s*,\\s*#monaco-parts-splash\\s*\\*\\s*{\\s*background-color:\\s*transparent\\s*!important\\s*}` +
        `\\s*/\\*${PATCH_MARKER}\\*/`,
    );

  return patched.test(content)
    ? content.replace(
        patched,
        'background-color: $2; color: $1; margin: 0; padding: 0; }',
      )
    : content;
}

function buildWorkbenchCss(opacity: number): string {
  const clampedOpacity = Math.max(0, Math.min(1, opacity));
  const percent = Math.round(clampedOpacity * 100);

  return `
html,
body {
  background-color: transparent !important;
}
.monaco-list-row,
.monaco-workbench .activitybar>.content :not(.monaco-menu)>.monaco-action-bar .action-item,
.monaco-workbench .part.editor>.content .editor-group-container>.title .tabs-container>.tab,
.monaco-button,
.monaco-inputbox,
.monaco-pane-view .pane>.pane-header,
.quick-input-list-entry {
  transition: background-color .24s;
}
#monaco-parts-splash,
#monaco-parts-splash > div {
  background-color: transparent !important;
}
.monaco-workbench {
  --modern-ui-shell-background: transparent !important;
  --vscode-editor-background: transparent !important;
  --vscode-editorGutter-background: transparent !important;
  --vscode-sideBar-background: transparent !important;
  --vscode-sideBarSectionHeader-background: transparent !important;
  --vscode-activityBar-background: transparent !important;
  --vscode-panel-background: transparent !important;
  --vscode-titleBar-activeBackground: transparent !important;
  --vscode-titleBar-inactiveBackground: transparent !important;
  --vscode-statusBar-background: transparent !important;
  --vscode-statusBar-noFolderBackground: transparent !important;
  --vscode-editorGroupHeader-tabsBackground: transparent !important;
  --vscode-editorGroupHeader-noTabsBackground: transparent !important;
  --vscode-tab-activeBackground: rgba(255, 255, 255, .06) !important;
  --vscode-tab-inactiveBackground: transparent !important;
  --vscode-breadcrumb-background: transparent !important;
  --vscode-notebook-editorBackground: transparent !important;
  --vscode-terminal-background: transparent !important;
  --vscode-agentsPanel-background: transparent !important;
  background-color: color-mix(in srgb, rgba(30, 30, 30, 1) ${percent}%, transparent) !important;
}
.monaco-workbench[class*="ultraview-transparent-dark"] {
  /* The dark theme uses the exact same component palette as the regular
     transparent theme, with one uniform compositor tint behind everything. */
  background-color: rgba(0, 0, 0, .28) !important;
}
.monaco-workbench > .monaco-grid-view,
.monaco-workbench .monaco-editor-background,
.monaco-workbench .lines-content {
  background-color: transparent !important;
}
.monaco-workbench.modern-ui .part,
.monaco-workbench.modern-ui .part > .content,
.monaco-workbench.modern-ui .editor-group-container,
.monaco-workbench.modern-ui .editor-group-container > .title,
.monaco-workbench.modern-ui .editor-group-container > .editor-container,
.monaco-workbench.modern-ui .monaco-editor-background,
.monaco-workbench.modern-ui .agents-panel,
.monaco-workbench.modern-ui .agent-panel {
  background-color: transparent !important;
}
.monaco-workbench .part.editor > .content,
.monaco-workbench .part.editor .editor-group-container,
.monaco-workbench .part.editor .editor-instance,
.monaco-workbench .part.editor .editor-container,
.monaco-workbench .part.editor .monaco-editor,
.monaco-workbench .part.editor .monaco-editor-background,
.monaco-workbench .part.editor .margin,
.monaco-workbench .part.editor .overflow-guard,
.monaco-workbench .part.panel > .content,
.monaco-workbench .part.sidebar > .content,
.monaco-workbench .part.auxiliarybar > .content {
  background-color: transparent !important;
}
.monaco-workbench .part.activitybar {
  --activity-bar-width: 40px !important;
  --activity-bar-action-height: 40px !important;
  --activity-bar-icon-size: 20px !important;
  width: 48px !important;
}
.monaco-editor,
.monaco-editor .margin,
.monaco-breadcrumbs,
.monaco-workbench .part.sidebar,
.monaco-workbench .part.editor,
.monaco-workbench .part.panel,
.monaco-workbench .part>.content,
.monaco-workbench .part.auxiliarybar,
.monaco-workbench .part.titlebar,
.monaco-workbench .part.statusbar,
.monaco-workbench .part.activitybar,
.monaco-workbench .part.sidebar>.title,
.monaco-list .monaco-list-rows,
.monaco-list.list_id_2 .monaco-list-rows,
.monaco-list.list_id_3 .monaco-list-rows,
.monaco-list.list_id_4 .monaco-list-rows,
.monaco-list.list_id_5 .monaco-list-rows,
.monaco-list.list_id_7 .monaco-list-rows,
.monaco-workbench .part.auxiliarybar>.title,
.monaco-workbench .part.editor>.content .editor-group-container>.title,
.monaco-workbench .part.editor>.content .editor-group-container>.editor-container,
.monaco-workbench .part.editor>.content .editor-group-container.active>.title .tabs-container>.tab,
.editor-group-container > .editor-container .overflow-guard > .monaco-scrollable-element > .monaco-editor-background,
.monaco-workbench .part.editor>.content .editor-group-container>.title>.tabs-and-actions-container.tabs-border-bottom:after,
.monaco-workbench .part.statusbar:not(:focus).status-border-top:after,
.monaco-workbench .pane-body.integrated-terminal .xterm {
  background-color: transparent !important;
}
.monaco-menu-container,
.monaco-editor .sticky-widget,
.monaco-list .monaco-scrollable-element .monaco-tree-sticky-container {
  backdrop-filter: blur(16px) !important;
}
.invisible.scrollbar.vertical:not(.fade)>.slider {
  margin-left: 4px;
}
.invisible.scrollbar.vertical>.slider {
  width: 8px !important;
}
canvas.decorationsOverviewRuler {
  width: 12px !important;
}
.monaco-list-row,
.monaco-editor .find-widget,
.monaco-editor .sticky-widget,
.monaco-editor .minimap canvas,
canvas.decorationsOverviewRuler,
.monaco-pane-view .pane>.pane-header,
.monaco-list.list_id_4 .monaco-list-row,
.monaco-list.list_id_5 .monaco-list-row,
.invisible.scrollbar.vertical.fade .slider,
.open-editors .monaco-list .monaco-list-row,
.monaco-list.mouse-support .monaco-list-row,
.monaco-list .monaco-scrollable-element .monaco-tree-sticky-container,
.monaco-workbench .part>.title>.title-actions .start-debug-action-item,
.monaco-workbench .part.editor>.content .editor-group-container>.title .tabs-container,
.monaco-workbench .part.editor>.content .editor-group-container>.title .tabs-container>.tab,
.monaco-workbench .part.panel .pane-body.integrated-terminal .terminal-outer-container {
  border-radius: 6px;
}
.monaco-editor .sticky-widget {
  background-color: var(--vscode-editorStickyScrollGutter-background);
}
.monaco-workbench .activitybar>.content :not(.monaco-menu)>.monaco-action-bar .action-item:hover a {
  background-color: var(--vscode-sideBar-background);
}
.monaco-workbench .part.sidebar>.content {
  padding-right: 4px;
  box-sizing: border-box;
}
.monaco-workbench .sidebar,
.monaco-workbench .part.titlebar,
.monaco-pane-view .pane>.pane-header,
.monaco-workbench .activitybar.bordered:before,
.monaco-workbench .part.panel.bottom .composite.title,
.monaco-workbench .part.editor>.content .editor-group-container>.title .tabs-container>.tab {
  border: none !important;
}
.monaco-workbench .part.editor>.content .editor-group-container.active>.title .tabs-container>.tab.active {
  background-color: var(--vscode-tab-activeBackground) !important;
}
.monaco-editor .scroll-decoration {
  box-shadow: none !important;
}
.monaco-workbench .activitybar>.content :not(.monaco-menu)>.monaco-action-bar {
  padding: 4px;
}
.monaco-workbench .activitybar>.content :not(.monaco-menu)>.monaco-action-bar .action-item {
  margin-bottom: 3px;
}
.monaco-workbench .activitybar>.content :not(.monaco-menu)>.monaco-action-bar .action-item a {
  border-radius: 12px;
}
.monaco-workbench .activitybar>.content :not(.monaco-menu)>.monaco-action-bar .action-item.checked a {
  background-color: var(--vscode-sideBar-background);
}
.monaco-workbench .activitybar>.content :not(.monaco-menu)>.monaco-action-bar .action-item:hover a {
  background-color: var(--vscode-list-hoverBackground);
}
.monaco-scrollable-element>.shadow.top,
.monaco-scrollable-element>.shadow.top-left-corner,
.monaco-workbench .activitybar>.content :not(.monaco-menu)>.monaco-action-bar .active-item-indicator,
.monaco-list .monaco-scrollable-element .monaco-tree-sticky-container .monaco-tree-sticky-container-shadow {
  display: none !important;
}
.minimap > canvas {
  opacity: ${clampedOpacity};
}
`.trim();
}

function handleThemeError(action: string, error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  if (message.includes('EPERM') || message.includes('EACCES')) {
    void vscode.window.showErrorMessage(
      `Ultraview could not ${action} because the IDE install is not writable. Try reopening the IDE with elevated permissions.`,
    );
    return;
  }

  void vscode.window.showErrorMessage(`Ultraview could not ${action}: ${message}`);
}
