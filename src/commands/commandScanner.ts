import * as fs from 'fs';
import * as path from 'path';

export type CommandType = 'npm' | 'just' | 'task' | 'make';

const MANIFEST_FILE_NAMES = new Set([
  'package.json',
  'justfile',
  'Justfile',
  '.justfile',
  'Taskfile.yml',
  'Taskfile.yaml',
  'taskfile.yml',
  'taskfile.yaml',
  'Makefile',
]);

const IGNORED_DIRECTORIES = new Set([
  '.git',
  '.hg',
  '.next',
  '.nuxt',
  '.svelte-kit',
  '.turbo',
  '.yarn',
  'bin',
  'build',
  'coverage',
  'dist',
  'node_modules',
  'out',
  'target',
]);

export interface ProjectCommand {
  id: string;
  type: CommandType;
  name: string;
  description?: string;
  runCmd: string;
  cwd: string;
  folderLabel: string;
  workspaceLabel: string;
  displayName: string;
}

export async function scanCommands(rootPath: string): Promise<ProjectCommand[]> {
  if (!rootPath) {
    return [];
  }

  const all: ProjectCommand[] = [];
  const seenIds = new Set<string>();
  const commandRoots = collectCommandRoots(rootPath);

  for (const commandRoot of commandRoots) {
    await Promise.allSettled([
      scanNpm(rootPath, commandRoot, all, seenIds),
      scanJust(rootPath, commandRoot, all, seenIds),
      scanTask(rootPath, commandRoot, all, seenIds),
      scanMake(rootPath, commandRoot, all, seenIds),
    ]);
  }

  return all.sort((left, right) => {
    return left.folderLabel.localeCompare(right.folderLabel)
      || left.type.localeCompare(right.type)
      || left.name.localeCompare(right.name);
  });
}

export async function scanWorkspaceCommands(rootPaths: readonly string[]): Promise<ProjectCommand[]> {
  const all: ProjectCommand[] = [];
  for (const rootPath of rootPaths) {
    const commands = await scanCommands(rootPath);
    all.push(...commands);
  }

  return all;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function readFile(filePath: string): string | null {
  try { return fs.readFileSync(filePath, 'utf8'); }
  catch { return null; }
}

function collectCommandRoots(rootPath: string): string[] {
  const roots: string[] = [];
  const visited = new Set<string>();

  const visit = (dirPath: string): void => {
    const normalizedPath = path.resolve(dirPath);
    if (visited.has(normalizedPath)) {
      return;
    }
    visited.add(normalizedPath);

    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(normalizedPath, { withFileTypes: true });
    } catch {
      return;
    }

    if (entries.some(entry => entry.isFile() && MANIFEST_FILE_NAMES.has(entry.name))) {
      roots.push(normalizedPath);
    }

    for (const entry of entries) {
      if (!entry.isDirectory() || entry.isSymbolicLink()) {
        continue;
      }

      if (IGNORED_DIRECTORIES.has(entry.name)) {
        continue;
      }

      visit(path.join(normalizedPath, entry.name));
    }
  };

  visit(rootPath);
  return roots;
}

function buildCommand(
  workspaceRoot: string,
  cwd: string,
  type: CommandType,
  name: string,
  runCmd: string,
  description?: string,
): ProjectCommand {
  const relativePath = path.relative(workspaceRoot, cwd);
  const workspaceLabel = path.basename(workspaceRoot) || workspaceRoot;
  const folderLabel = relativePath ? `${workspaceLabel}/${relativePath.split(path.sep).join('/')}` : workspaceLabel;

  return {
    id: `${type}:${folderLabel}:${name}`,
    type,
    name,
    description,
    runCmd,
    cwd,
    folderLabel,
    workspaceLabel,
    displayName: `${type} ${name}`,
  };
}

function pushCommand(out: ProjectCommand[], seenIds: Set<string>, command: ProjectCommand): void {
  if (seenIds.has(command.id)) {
    return;
  }

  seenIds.add(command.id);
  out.push(command);
}

// ─── NPM ─────────────────────────────────────────────────────────────────────

async function scanNpm(workspaceRoot: string, cwd: string, out: ProjectCommand[], seenIds: Set<string>): Promise<void> {
  const content = readFile(path.join(cwd, 'package.json'));
  if (!content) return;
  let pkg: any;
  try { pkg = JSON.parse(content); } catch { return; }
  const scripts = pkg.scripts;
  if (!scripts || typeof scripts !== 'object') return;

  const runner = detectNpmRunner(cwd);
  for (const [name, cmd] of Object.entries(scripts)) {
    pushCommand(out, seenIds, buildCommand(
      workspaceRoot,
      cwd,
      'npm',
      name,
      `${runner} ${name}`,
      String(cmd),
    ));
  }
}

function detectNpmRunner(root: string): string {
  if (fs.existsSync(path.join(root, 'bun.lock')) || fs.existsSync(path.join(root, 'bun.lockb'))) {
    return 'bun run';
  }
  if (fs.existsSync(path.join(root, 'pnpm-lock.yaml'))) {
    return 'pnpm run';
  }
  if (fs.existsSync(path.join(root, 'yarn.lock'))) {
    return 'yarn';
  }
  return 'npm run';
}

// ─── Just ────────────────────────────────────────────────────────────────────

async function scanJust(workspaceRoot: string, cwd: string, out: ProjectCommand[], seenIds: Set<string>): Promise<void> {
  let content: string | null = null;
  for (const name of ['justfile', 'Justfile', '.justfile']) {
    content = readFile(path.join(cwd, name));
    if (content) break;
  }
  if (!content) return;

  const lines = content.split('\n');
  // Recipe: starts at col 0, alphanumeric/hyphen/underscore name, optional args, ends with ':'
  const recipeRe = /^([a-zA-Z_][a-zA-Z0-9_-]*)(\s[^:]*)?:/;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const match = line.match(recipeRe);
    if (!match) continue;
    const name = match[1];
    // skip private recipes
    if (name.startsWith('_')) continue;

    // look for a `# doc` comment directly above
    let desc: string | undefined;
    if (i > 0) {
      const prev = lines[i - 1].trim();
      if (prev.startsWith('#')) {
        desc = prev.replace(/^#+\s*/, '').trim() || undefined;
      }
    }

    pushCommand(out, seenIds, buildCommand(workspaceRoot, cwd, 'just', name, `just ${name}`, desc));
  }
}

// ─── Task ────────────────────────────────────────────────────────────────────

async function scanTask(workspaceRoot: string, cwd: string, out: ProjectCommand[], seenIds: Set<string>): Promise<void> {
  let content: string | null = null;
  for (const name of ['Taskfile.yml', 'Taskfile.yaml', 'taskfile.yml', 'taskfile.yaml']) {
    content = readFile(path.join(cwd, name));
    if (content) break;
  }
  if (!content) return;

  // Simple line-by-line YAML parser for the tasks section
  const lines = content.split('\n');
  let inTasks = false;
  let tasksBaseIndent = -1;
  let currentTask: string | null = null;
  let currentDesc: string | undefined;

  const flush = () => {
    if (!currentTask) return;
    pushCommand(out, seenIds, buildCommand(workspaceRoot, cwd, 'task', currentTask, `task ${currentTask}`, currentDesc));
    currentTask = null;
    currentDesc = undefined;
  };

  for (const line of lines) {
    const raw = line.trimEnd();
    if (!raw.trim() || raw.trim().startsWith('#')) continue;
    const indent = raw.length - raw.trimStart().length;
    const trimmed = raw.trim();

    if (!inTasks) {
      if (trimmed === 'tasks:') { inTasks = true; tasksBaseIndent = indent; }
      continue;
    }

    // Exiting tasks section (back to root level key)
    if (indent <= tasksBaseIndent && trimmed !== 'tasks:' && trimmed.endsWith(':')) {
      flush();
      break;
    }

    // Task name at one level deeper than 'tasks:'
    if (indent === tasksBaseIndent + 2 && trimmed.match(/^[a-zA-Z_][a-zA-Z0-9_:-]*\s*:/)) {
      flush();
      const m = trimmed.match(/^([a-zA-Z_][a-zA-Z0-9_:-]*)\s*:/);
      if (m && !m[1].startsWith('_')) {
        currentTask = m[1];
      }
      continue;
    }

    // 'desc:' field inside a task
    if (currentTask && indent > tasksBaseIndent + 2) {
      const dm = trimmed.match(/^desc:\s*["']?(.+?)["']?\s*$/);
      if (dm) currentDesc = dm[1];
    }
  }
  flush();
}

// ─── Make ────────────────────────────────────────────────────────────────────

async function scanMake(workspaceRoot: string, cwd: string, out: ProjectCommand[], seenIds: Set<string>): Promise<void> {
  const content = readFile(path.join(cwd, 'Makefile'));
  if (!content) return;

  const lines = content.split('\n');
  const targetRe = /^([a-zA-Z_][a-zA-Z0-9_./-]*)\s*:/;
  const phonyRe = /^\.PHONY\s*:(.*)/;

  const phony = new Set<string>();
  for (const line of lines) {
    const m = line.match(phonyRe);
    if (m) m[1].trim().split(/\s+/).forEach(t => phony.add(t));
  }

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.startsWith('\t') || line.startsWith(' ') || line.startsWith('#')) continue;
    const match = line.match(targetRe);
    if (!match) continue;
    const name = match[1];
    if (name.startsWith('.') || name.includes('$(') || name.includes('%')) continue;

    // inline ## description or comment line above
    let desc: string | undefined;
    const inlineComment = line.match(/##\s*(.+)$/);
    if (inlineComment) {
      desc = inlineComment[1].trim();
    } else if (i > 0) {
      const prev = lines[i - 1].trim();
      if (prev.startsWith('#')) desc = prev.replace(/^#+\s*/, '').trim() || undefined;
    }

    pushCommand(out, seenIds, buildCommand(workspaceRoot, cwd, 'make', name, `make ${name}`, desc));
  }
}
