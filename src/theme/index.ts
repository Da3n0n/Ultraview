import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';

const ENABLE_COMMAND = 'ultraview.enableTransparent';
const DISABLE_COMMAND = 'ultraview.disableTransparent';
const THEME_LABEL = 'Ultraview Transparent';
const THEME_LABEL_DARK = 'Ultraview Transparent Dark';
const STATE_PREVIOUS_THEME = 'ultraview.transparent.previousTheme';

const PATCH_MARKER = 'ultraview-transparent-patched';
const HTML_MARKER = '<!-- ultraview-transparent-patched -->';
const HTML_MARKER_END = '<!-- /ultraview-transparent-patched -->';
const DEFAULT_OPACITY = 0.82;
const DEFAULT_FALLBACK_THEME = 'Default Dark Modern';

type EffectType = 'mica' | 'acrylic' | 'tabbed' | 'auto' | 'none';

interface InstallPaths {
  mainJs: string;
  workbenchHtml: string;
  workbenchJs: string;
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
    vscode.commands.registerCommand(ENABLE_DARK_COMMAND, async () => {
      await enableTransparentDark(context);
    }),
    vscode.commands.registerCommand(DISABLE_DARK_COMMAND, async () => {
      await disableTransparentDark(context);
    }),
  );
}

async function enableTransparent(context: vscode.ExtensionContext): Promise<void> {
  try {
    const paths = resolveInstallPaths(vscode.env.appRoot);
    patchMainJs(paths.mainJs, getPreferredEffect());
    patchWorkbenchHtml(paths.workbenchHtml, DEFAULT_OPACITY);
    patchWorkbenchJs(paths.workbenchJs);
    await rememberCurrentTheme(context);
    await setWorkbenchTheme(THEME_LABEL);

    void vscode.window.showInformationMessage(
      'Ultraview Transparent is enabled. Fully close and reopen the IDE to apply translucency.',
    );
  } catch (error) {
    handleThemeError('enable transparent mode', error);
  }
}

async function enableTransparentDark(context: vscode.ExtensionContext): Promise<void> {
  try {
    const paths = resolveInstallPaths(vscode.env.appRoot);
    patchMainJs(paths.mainJs, getPreferredEffect());
    patchWorkbenchHtml(paths.workbenchHtml, DEFAULT_OPACITY);
    patchWorkbenchJs(paths.workbenchJs);
    await rememberCurrentThemeDark(context);
    await setWorkbenchTheme(THEME_LABEL_DARK);

    void vscode.window.showInformationMessage(
      'Ultraview Transparent Dark is enabled. Fully close and reopen the IDE to apply translucency.',
    );
  } catch (error) {
    handleThemeError('enable transparent dark mode', error);
  }
}

async function disableTransparentDark(context: vscode.ExtensionContext): Promise<void> {
  try {
    const paths = resolveInstallPaths(vscode.env.appRoot);
    const removedResults = [
      unpatchMainJs(paths.mainJs),
      unpatchWorkbenchHtml(paths.workbenchHtml),
      unpatchWorkbenchJs(paths.workbenchJs),
    ];
    const removed = removedResults.some(Boolean);

    await restorePreviousThemeDark(context);

    if (!removed) {
      void vscode.window.showInformationMessage(
        'Ultraview Transparent Dark was already disabled. Your previous theme has been restored if it was saved.',
      );
      return;
    }

    void vscode.window.showInformationMessage(
      'Ultraview Transparent Dark is disabled. Fully close and reopen the IDE to remove translucency.',
    );
  } catch (error) {
    handleThemeError('disable transparent dark mode', error);
  }
}

async function rememberCurrentThemeDark(context: vscode.ExtensionContext): Promise<void> {
  const currentTheme = getCurrentTheme();
  if (currentTheme && currentTheme !== THEME_LABEL_DARK) {
    await context.globalState.update(STATE_PREVIOUS_THEME_DARK, currentTheme);
  }
}

async function restorePreviousThemeDark(context: vscode.ExtensionContext): Promise<void> {
  const currentTheme = getCurrentTheme();
  const previousTheme = context.globalState.get<string>(STATE_PREVIOUS_THEME_DARK);
  const nextTheme =
    previousTheme && previousTheme !== THEME_LABEL_DARK
      ? previousTheme
      : currentTheme === THEME_LABEL_DARK
        ? DEFAULT_FALLBACK_THEME
        : undefined;

  if (nextTheme) {
    await setWorkbenchTheme(nextTheme);
  }

  await context.globalState.update(STATE_PREVIOUS_THEME_DARK, undefined);
}

async function disableTransparent(context: vscode.ExtensionContext): Promise<void> {
  try {
    const paths = resolveInstallPaths(vscode.env.appRoot);
    const removedResults = [
      unpatchMainJs(paths.mainJs),
      unpatchWorkbenchHtml(paths.workbenchHtml),
      unpatchWorkbenchJs(paths.workbenchJs),
    ];
    const removed = removedResults.some(Boolean);

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
  return process.platform === 'win32' ? 'mica' : 'none';
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
        /for\(const n of Kee\(\)\)if\(n\.id===t\)\{n\.setBackgroundColor\(r\.colorInfo\.background\);break\}/,
      ],
      replace: `0/*${PATCH_MARKER}-antigravity-window-bg*/;`,
      patched: [
        new RegExp(`0\\s*/\\*${PATCH_MARKER}-antigravity-window-bg\\*/\\s*;`),
      ],
      original: [
        'for(const n of Kee())if(n.id===t){n.setBackgroundColor(r.colorInfo.background);break}',
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
        new RegExp(`experimentalDarkMode\\s*:\\s*!0\\s*,\\s*backgroundMaterial\\s*:\\s*"${effect}"\\s*/\\*${PATCH_MARKER}\\*/\\s*}`),
        new RegExp(`experimentalDarkMode\\s*:\\s*true\\s*,\\s*backgroundMaterial\\s*:\\s*"${effect}"\\s*/\\*${PATCH_MARKER}\\*/\\s*}`),
      ],
      original: ['experimentalDarkMode:!0}', 'experimentalDarkMode:true}'],
      required: true,
    });
  }

  return patches;
}

function patchMainJs(filePath: string, effect: EffectType): void {
  let content = fs.readFileSync(filePath, 'utf8');
  content = unpatchMainJsContent(content);

  for (const patch of buildMainPatches(effect)) {
    const pattern = patch.find.find((candidate) => candidate.test(content));
    if (!pattern) {
      if (!patch.required) {
        continue;
      }

      throw new Error(`Could not find expected code in ${path.basename(filePath)} for ${patch.find.map((candidate) => candidate.source).join(' OR ')}`);
    }
    content = content.replace(pattern, patch.replace);
  }

  fs.writeFileSync(filePath, content, 'utf8');
}

function unpatchMainJs(filePath: string): boolean {
  const content = fs.readFileSync(filePath, 'utf8');
  const next = unpatchMainJsContent(content);
  if (next === content) {
    return false;
  }

  fs.writeFileSync(filePath, next, 'utf8');
  return true;
}

function unpatchMainJsContent(content: string): string {
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

function patchWorkbenchHtml(filePath: string, opacity: number): void {
  let content = fs.readFileSync(filePath, 'utf8');
  content = stripWorkbenchHtmlPatch(content);

  if (!content.includes('</head>')) {
    throw new Error(`Could not find </head> in ${path.basename(filePath)}`);
  }

  const styleBlock = [
    '',
    `\t\t${HTML_MARKER}`,
    `\t\t<style>${buildWorkbenchCss(opacity)}</style>`,
    `\t\t${HTML_MARKER_END}`,
  ].join('\n');

  content = content.replace('</head>', `${styleBlock}\n\t</head>`);
  fs.writeFileSync(filePath, content, 'utf8');
}

function unpatchWorkbenchHtml(filePath: string): boolean {
  const content = fs.readFileSync(filePath, 'utf8');
  const next = stripWorkbenchHtmlPatch(content);
  if (next === content) {
    return false;
  }

  fs.writeFileSync(filePath, next, 'utf8');
  return true;
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

function patchWorkbenchJs(filePath: string): void {
  const find =
    /background-color:\s*(\$\{[^}]+\})\s*;\s*color:\s*(\$\{[^}]+\})\s*;\s*margin:\s*0;\s*padding:\s*0;\s*}/;
  const replacement =
    `background-color:transparent;color:$2;margin:0;padding:0;}/*${PATCH_MARKER}:$1*/` +
    '#monaco-parts-splash,#monaco-parts-splash *{background-color:transparent!important}' +
    `/*${PATCH_MARKER}*/`;

  let content = fs.readFileSync(filePath, 'utf8');
  content = unpatchWorkbenchJsContent(content);

  if (!find.test(content)) {
    throw new Error(`Could not find splash screen styles in ${path.basename(filePath)}`);
  }

  content = content.replace(find, replacement);
  fs.writeFileSync(filePath, content, 'utf8');
}

function unpatchWorkbenchJs(filePath: string): boolean {
  const content = fs.readFileSync(filePath, 'utf8');
  const next = unpatchWorkbenchJsContent(content);
  if (next === content) {
    return false;
  }

  fs.writeFileSync(filePath, next, 'utf8');
  return true;
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
  background-color: color-mix(in srgb, var(--vscode-editor-background, #1e1e1e) ${percent}%, transparent) !important;
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
