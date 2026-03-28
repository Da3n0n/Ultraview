import * as fs from 'fs';
import * as path from 'path';

export type CommandType = 'npm' | 'just' | 'task' | 'make' | 'python' | 'go' | 'powershell' | 'shell' | 'bun' | 'deno' | 'npx' | 'pnpm';

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
  'setup.py',
  'pyproject.toml',
  'go.mod',
  'requirements.txt',
  'Pipfile',
  'poetry.lock',
  'go.sum',
  'pytest.ini',
  'setup.cfg',
  'tox.ini',
  '.flake8',
  '.pylintrc',
  'pylintrc',
  'poetry.lock',
  '.black',
  'Pipfile.lock',
  'Makefile',
  'bun.lock',
  'bun.lockb',
  'bunfig.toml',
  'deno.json',
  'deno.jsonc',
  'deno.lock',
  'pnpm-lock.yaml',
]);

const COMMAND_ROOT_DIRECTORIES = ['scripts', 'tools', 'bin', 'ps', 'powershell', 'sh', 'shell'];
const COMMAND_ROOT_FILE_EXTENSIONS = ['.ps1', '.sh'];

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
  priority: number;
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
      scanVsCodeTasks(rootPath, commandRoot, all, seenIds),
      scanTask(rootPath, commandRoot, all, seenIds),
      scanMake(rootPath, commandRoot, all, seenIds),
      scanPython(rootPath, commandRoot, all, seenIds),
      scanGo(rootPath, commandRoot, all, seenIds),
      scanPowerShell(rootPath, commandRoot, all, seenIds),
      scanShell(rootPath, commandRoot, all, seenIds),
      scanBun(rootPath, commandRoot, all, seenIds),
      scanDeno(rootPath, commandRoot, all, seenIds),
      scanNpx(rootPath, commandRoot, all, seenIds),
      scanPnpm(rootPath, commandRoot, all, seenIds),
    ]);
  }

  return all.sort((left, right) => {
    return (left.priority - right.priority)
      || left.folderLabel.localeCompare(right.folderLabel)
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
  const workspaceRoot = path.resolve(rootPath);
  const roots: string[] = [workspaceRoot];
  const visited = new Set<string>();
  const registeredRoots = new Set<string>(roots);

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

    if (shouldScanDirectory(normalizedPath, entries, workspaceRoot) && !registeredRoots.has(normalizedPath)) {
      roots.push(normalizedPath);
      registeredRoots.add(normalizedPath);
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

function shouldScanDirectory(dirPath: string, entries: fs.Dirent[], workspaceRoot: string): boolean {
  if (dirPath === workspaceRoot) {
    return true;
  }

  if (entries.some(entry => entry.isFile() && MANIFEST_FILE_NAMES.has(entry.name))) {
    return true;
  }

  if (entries.some(entry => entry.isFile() && COMMAND_ROOT_FILE_EXTENSIONS.some(ext => entry.name.endsWith(ext)))) {
    return true;
  }

  if (entries.some(entry => entry.isDirectory() && COMMAND_ROOT_DIRECTORIES.includes(entry.name))) {
    return true;
  }

  return fs.existsSync(path.join(dirPath, '.vscode', 'tasks.json'));
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
    priority: computeCommandPriority(name, runCmd),
  };
}

function computeCommandPriority(name: string, runCmd: string): number {
  const n = name.toLowerCase();
  const r = runCmd.toLowerCase();
  // Dev commands - highest priority
  if (n === 'dev' || n === 'develop' || n.startsWith('dev:') || n.startsWith('develop:')) { return 0; }
  // Build commands
  if (n === 'build' || n.startsWith('build:')) { return 1; }
  // Start/serve/preview
  if (n === 'start' || n === 'serve' || n === 'preview' || n.startsWith('start:') || n.startsWith('serve:')) { return 2; }
  // Test
  if (n === 'test' || n.startsWith('test:') || n === 'e2e' || n.startsWith('e2e:')) { return 3; }
  // Lint/format/check
  if (n === 'lint' || n.startsWith('lint:') || n === 'format' || n.startsWith('format:') ||
      n === 'check' || n === 'typecheck' || n === 'type-check') { return 4; }
  // Check runCmd for framework commands not caught by name
  if (/\bdev(elop)?\b/.test(r)) { return 0; }
  if (/\bbuild\b/.test(r)) { return 1; }
  if (/\b(start|serve|preview)\b/.test(r)) { return 2; }
  // Generate/migrate/deploy/watch
  if (n.includes('generate') || n.includes('migrate') || n.includes('seed') ||
      n.includes('deploy') || n.includes('watch') || n === 'clean') { return 5; }
  return 6;
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
  const resolvedType: CommandType = runner.startsWith('bun') ? 'bun'
    : runner.startsWith('pnpm') ? 'pnpm'
    : 'npm';
  for (const [name, cmd] of Object.entries(scripts)) {
    pushCommand(out, seenIds, buildCommand(
      workspaceRoot,
      cwd,
      resolvedType,
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

async function scanVsCodeTasks(workspaceRoot: string, cwd: string, out: ProjectCommand[], seenIds: Set<string>): Promise<void> {
  const tasksPath = path.join(cwd, '.vscode', 'tasks.json');
  const content = readFile(tasksPath);
  if (!content) return;

  let config: any;
  try {
    config = JSON.parse(content);
  } catch {
    return;
  }

  const tasks = Array.isArray(config?.tasks) ? config.tasks : [];
  for (const task of tasks) {
    if (!task || typeof task !== 'object') {
      continue;
    }

    const label = typeof task.label === 'string' && task.label.trim()
      ? task.label.trim()
      : typeof task.task === 'string' && task.task.trim()
        ? task.task.trim()
        : undefined;
    if (!label) {
      continue;
    }

    const runCmd = buildVsCodeTaskCommand(task);
    if (!runCmd) {
      continue;
    }

    const taskCwd = resolveVsCodeTaskCwd(task, workspaceRoot, cwd);
    const detail = typeof task.detail === 'string' && task.detail.trim()
      ? task.detail.trim()
      : typeof task.type === 'string' && task.type.trim()
        ? `${task.type} task`
        : 'VS Code task';

    pushCommand(out, seenIds, buildCommand(
      workspaceRoot,
      taskCwd,
      'task',
      `vscode:${label}`,
      runCmd,
      detail,
    ));
  }
}

function buildVsCodeTaskCommand(task: any): string | undefined {
  if (typeof task.command !== 'string' || !task.command.trim()) {
    return undefined;
  }

  const command = task.command.trim();
  const args = Array.isArray(task.args)
    ? task.args
        .map((arg: unknown) => stringifyTaskArg(arg))
        .filter((arg: string | undefined): arg is string => Boolean(arg))
    : [];

  return [command, ...args].join(' ').trim() || undefined;
}

function stringifyTaskArg(arg: unknown): string | undefined {
  if (typeof arg === 'string') {
    return arg;
  }

  if (typeof arg === 'number' || typeof arg === 'boolean') {
    return String(arg);
  }

  return undefined;
}

function resolveVsCodeTaskCwd(task: any, workspaceRoot: string, fallbackCwd: string): string {
  const cwdValue = task?.options?.cwd;
  if (typeof cwdValue !== 'string' || !cwdValue.trim()) {
    return fallbackCwd;
  }

  const resolved = cwdValue
    .replace(/\$\{workspaceFolder(?::[^}]+)?\}/g, workspaceRoot)
    .replace(/\$\{workspaceFolderBasename\}/g, path.basename(workspaceRoot));

  return path.isAbsolute(resolved) ? resolved : path.resolve(workspaceRoot, resolved);
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

// ─── Python ───────────────────────────────────────────────────────────────────

async function scanPython(workspaceRoot: string, cwd: string, out: ProjectCommand[], seenIds: Set<string>): Promise<void> {
  // Check for Python project indicators
  const hasSetup = fs.existsSync(path.join(cwd, 'setup.py'));
  const hasPyProject = fs.existsSync(path.join(cwd, 'pyproject.toml'));
  const hasRequirements = fs.existsSync(path.join(cwd, 'requirements.txt'));
  const hasPipfile = fs.existsSync(path.join(cwd, 'Pipfile'));
  const hasPoetryLock = fs.existsSync(path.join(cwd, 'poetry.lock'));

  if (!hasSetup && !hasPyProject && !hasRequirements && !hasPipfile && !hasPoetryLock) {
    return;
  }

  // Check for main.py, app.py, or script directories
  const possibleScripts = [
    'main.py',
    'app.py',
    'run.py',
    'server.py',
    'cli.py',
    'manage.py',  // Django
    'wsgi.py',     // Django/FastAPI
    'asgi.py',     // Django/FastAPI
  ];

  for (const script of possibleScripts) {
    const scriptPath = path.join(cwd, script);
    if (fs.existsSync(scriptPath)) {
      pushCommand(out, seenIds, buildCommand(
        workspaceRoot,
        cwd,
        'python',
        script.replace('.py', ''),
        `python ${script}`,
        `Run ${script}`
      ));
    }
  }

  // Add common Python commands
  if (hasPyProject) {
    const content = readFile(path.join(cwd, 'pyproject.toml'));
    if (content) {
      // Check for poetry project
      if (content.includes('[tool.poetry]')) {
        pushCommand(out, seenIds, buildCommand(
          workspaceRoot,
          cwd,
          'python',
          'install',
          'poetry install',
          'Install dependencies with Poetry'
        ));
        pushCommand(out, seenIds, buildCommand(
          workspaceRoot,
          cwd,
          'python',
          'update',
          'poetry update',
          'Update dependencies with Poetry'
        ));
        pushCommand(out, seenIds, buildCommand(
          workspaceRoot,
          cwd,
          'python',
          'add',
          'poetry add',
          'Add a dependency with Poetry'
        ));
      }
    }
  }

  if (hasRequirements) {
    pushCommand(out, seenIds, buildCommand(
      workspaceRoot,
      cwd,
      'python',
      'install',
      'pip install -r requirements.txt',
      'Install dependencies from requirements.txt'
    ));
  }

  if (hasPipfile) {
    pushCommand(out, seenIds, buildCommand(
      workspaceRoot,
      cwd,
      'python',
      'install',
      'pipenv install',
      'Install dependencies with Pipenv'
    ));
    pushCommand(out, seenIds, buildCommand(
      workspaceRoot,
      cwd,
      'python',
      'shell',
      'pipenv shell',
      'Activate virtual environment (Pipenv)'
    ));
  }

  // Detect pytest configuration
  const hasPytest = fs.existsSync(path.join(cwd, 'pytest.ini')) ||
                    fs.existsSync(path.join(cwd, 'pyproject.toml')) ||
                    fs.existsSync(path.join(cwd, 'setup.cfg'));

  if (hasPytest || hasPyProject || hasSetup) {
    pushCommand(out, seenIds, buildCommand(
      workspaceRoot,
      cwd,
      'python',
      'test',
      'pytest',
      'Run tests with pytest'
    ));
  }

  // Add linting commands if common linters are detected
  const hasPylintrc = fs.existsSync(path.join(cwd, '.pylintrc')) ||
                      fs.existsSync(path.join(cwd, 'pylintrc'));
  const hasFlake8 = fs.existsSync(path.join(cwd, '.flake8')) ||
                    fs.existsSync(path.join(cwd, 'setup.cfg'));
  const hasBlack = fs.existsSync(path.join(cwd, 'pyproject.toml')) ||
                   fs.existsSync(path.join(cwd, '.black'));

  if (hasPylintrc) {
    pushCommand(out, seenIds, buildCommand(
      workspaceRoot,
      cwd,
      'python',
      'lint',
      'pylint **/*.py',
      'Run pylint'
    ));
  }

  if (hasFlake8) {
    pushCommand(out, seenIds, buildCommand(
      workspaceRoot,
      cwd,
      'python',
      'flake8',
      'flake8 **/*.py',
      'Run flake8'
    ));
  }

  if (hasBlack) {
    pushCommand(out, seenIds, buildCommand(
      workspaceRoot,
      cwd,
      'python',
      'format',
      'black .',
      'Format code with black'
    ));
  }

  // Scan for scripts directory or bin directory
  for (const dir of ['scripts', 'bin', 'tools']) {
    const dirPath = path.join(cwd, dir);
    if (fs.existsSync(dirPath)) {
      try {
        const entries = fs.readdirSync(dirPath, { withFileTypes: true });
        for (const entry of entries) {
          if (entry.isFile() && entry.name.endsWith('.py')) {
            const scriptName = entry.name.replace('.py', '');
            pushCommand(out, seenIds, buildCommand(
              workspaceRoot,
              cwd,
              'python',
              `${dir}/${scriptName}`,
              `python ${path.join(dir, entry.name)}`,
              `Run ${entry.name}`
            ));
          }
        }
      } catch {
        // Ignore permission errors
      }
    }
  }
}

// ─── Go ─────────────────────────────────────────────────────────────────────

async function scanGo(workspaceRoot: string, cwd: string, out: ProjectCommand[], seenIds: Set<string>): Promise<void> {
  // Check for Go project
  const hasGoMod = fs.existsSync(path.join(cwd, 'go.mod'));
  const hasGoSum = fs.existsSync(path.join(cwd, 'go.sum'));

  if (!hasGoMod && !hasGoSum) {
    return;
  }

  // Get module name from go.mod
  let moduleName = '';
  if (hasGoMod) {
    const content = readFile(path.join(cwd, 'go.mod'));
    if (content) {
      const match = content.match(/^module\s+(.+)$/m);
      if (match) {
        moduleName = match[1].trim();
      }
    }
  }

  // Check for main package
  const hasMainPackage = fs.existsSync(path.join(cwd, 'main.go')) ||
                         fs.existsSync(path.join(cwd, 'cmd', 'main.go'));

  // Add common Go commands
  pushCommand(out, seenIds, buildCommand(
    workspaceRoot,
    cwd,
    'go',
    'run',
    'go run .',
    hasMainPackage ? 'Run the application' : 'Run Go files'
  ));

  pushCommand(out, seenIds, buildCommand(
    workspaceRoot,
    cwd,
    'go',
    'build',
    'go build .',
    'Build the application'
  ));

  pushCommand(out, seenIds, buildCommand(
    workspaceRoot,
    cwd,
    'go',
    'test',
    'go test ./...',
    'Run all tests'
  ));

  pushCommand(out, seenIds, buildCommand(
    workspaceRoot,
    cwd,
    'go',
    'test verbose',
    'go test -v ./...',
    'Run tests with verbose output'
  ));

  pushCommand(out, seenIds, buildCommand(
    workspaceRoot,
    cwd,
    'go',
    'test coverage',
    'go test -cover ./...',
    'Run tests with coverage'
  ));

  pushCommand(out, seenIds, buildCommand(
    workspaceRoot,
    cwd,
    'go',
    'mod tidy',
    'go mod tidy',
    'Clean up dependencies'
  ));

  pushCommand(out, seenIds, buildCommand(
    workspaceRoot,
    cwd,
    'go',
    'mod download',
    'go mod download',
    'Download dependencies'
  ));

  // Check for go.sum and provide vendor command
  if (hasGoSum) {
    pushCommand(out, seenIds, buildCommand(
      workspaceRoot,
      cwd,
      'go',
      'mod vendor',
      'go mod vendor',
      'Vendor dependencies'
    ));
  }

  // Check for cmd directory (common Go project structure)
  const cmdPath = path.join(cwd, 'cmd');
  if (fs.existsSync(cmdPath)) {
    try {
      const entries = fs.readdirSync(cmdPath, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.isDirectory()) {
          const mainGoPath = path.join(cmdPath, entry.name, 'main.go');
          if (fs.existsSync(mainGoPath)) {
            pushCommand(out, seenIds, buildCommand(
              workspaceRoot,
              cwd,
              'go',
              `run cmd/${entry.name}`,
              `go run ./cmd/${entry.name}`,
              `Run ${entry.name} command`
            ));
          }
        }
      }
    } catch {
      // Ignore permission errors
    }
  }

  // Check for Makefile in Go project
  const hasMakefile = fs.existsSync(path.join(cwd, 'Makefile'));
  if (hasMakefile) {
    const content = readFile(path.join(cwd, 'Makefile'));
    if (content) {
      const lines = content.split('\n');
      const targetRe = /^([a-zA-Z_][a-zA-Z0-9_-]*)\s*:/;
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

        // Only add common Go make targets
        const goTargets = ['build', 'test', 'run', 'clean', 'install', 'lint', 'fmt', 'deps', 'vendor'];
        if (goTargets.includes(name) || phony.has(name)) {
          let desc: string | undefined;
          const inlineComment = line.match(/##\s*(.+)$/);
          if (inlineComment) {
            desc = inlineComment[1].trim();
          } else if (i > 0) {
            const prev = lines[i - 1].trim();
            if (prev.startsWith('#')) desc = prev.replace(/^#+\s*/, '').trim() || undefined;
          }

          pushCommand(out, seenIds, buildCommand(
            workspaceRoot,
            cwd,
            'go',
            `make:${name}`,
            `make ${name}`,
            desc || `Run make ${name}`
          ));
        }
      }
    }
  }
}

// ─── PowerShell ───────────────────────────────────────────────────────────────

async function scanPowerShell(workspaceRoot: string, cwd: string, out: ProjectCommand[], seenIds: Set<string>): Promise<void> {
  // Scan for .ps1 files in the root and common directories
  const commonDirs = ['scripts', 'tools', 'bin', 'ps', 'powershell'];

  // Check root directory
  const rootEntries = fs.readdirSync(cwd, { withFileTypes: true });
  for (const entry of rootEntries) {
    if (entry.isFile() && entry.name.endsWith('.ps1') && !entry.name.startsWith('_')) {
      const scriptName = entry.name.replace('.ps1', '');
      pushCommand(out, seenIds, buildCommand(
        workspaceRoot,
        cwd,
        'powershell',
        scriptName,
        `pwsh ${entry.name}`,
        `Run ${entry.name}`
      ));
    }
  }

  // Check common directories
  for (const dir of commonDirs) {
    const dirPath = path.join(cwd, dir);
    if (fs.existsSync(dirPath)) {
      try {
        const entries = fs.readdirSync(dirPath, { withFileTypes: true });
        for (const entry of entries) {
          if (entry.isFile() && entry.name.endsWith('.ps1') && !entry.name.startsWith('_')) {
            const scriptName = entry.name.replace('.ps1', '');
            pushCommand(out, seenIds, buildCommand(
              workspaceRoot,
              cwd,
              'powershell',
              `${dir}/${scriptName}`,
              `pwsh ${path.join(dir, entry.name)}`,
              `Run ${entry.name}`
            ));
          }
        }
      } catch {
        // Ignore permission errors
      }
    }
  }

  // Check for PowerShell manifest files
  const hasPsd1 = rootEntries.some(entry => entry.isFile() && entry.name.endsWith('.psd1'));
  const hasPs1Xml = rootEntries.some(entry => entry.isFile() && entry.name.endsWith('.ps1xml'));

  if (hasPsd1 || hasPs1Xml) {
    pushCommand(out, seenIds, buildCommand(
      workspaceRoot,
      cwd,
      'powershell',
      'import module',
      'Import-Module .',
      'Import PowerShell module from current directory'
    ));
  }

  // Add common PowerShell commands for Windows
  if (process.platform === 'win32') {
    pushCommand(out, seenIds, buildCommand(
      workspaceRoot,
      cwd,
      'powershell',
      'test',
      'Invoke-Pester',
      'Run Pester tests'
    ));

    pushCommand(out, seenIds, buildCommand(
      workspaceRoot,
      cwd,
      'powershell',
      'analyze',
      'Invoke-ScriptAnalyzer .',
      'Run PSScriptAnalyzer'
    ));
  }
}

// ─── Shell Scripts ───────────────────────────────────────────────────────────

async function scanShell(workspaceRoot: string, cwd: string, out: ProjectCommand[], seenIds: Set<string>): Promise<void> {
  // Scan for .sh files in the root and common directories
  const commonDirs = ['scripts', 'tools', 'bin', 'sh', 'shell'];

  // Check root directory
  const rootEntries = fs.readdirSync(cwd, { withFileTypes: true });
  for (const entry of rootEntries) {
    if (entry.isFile() && entry.name.endsWith('.sh') && !entry.name.startsWith('_')) {
      const scriptName = entry.name.replace('.sh', '');
      pushCommand(out, seenIds, buildCommand(
        workspaceRoot,
        cwd,
        'shell',
        scriptName,
        `./${entry.name}`,
        `Run ${entry.name}`
      ));
    }
  }

  // Check common directories
  for (const dir of commonDirs) {
    const dirPath = path.join(cwd, dir);
    if (fs.existsSync(dirPath)) {
      try {
        const entries = fs.readdirSync(dirPath, { withFileTypes: true });
        for (const entry of entries) {
          if (entry.isFile() && entry.name.endsWith('.sh') && !entry.name.startsWith('_')) {
            const scriptName = entry.name.replace('.sh', '');
            pushCommand(out, seenIds, buildCommand(
              workspaceRoot,
              cwd,
              'shell',
              `${dir}/${scriptName}`,
              `./${path.join(dir, entry.name)}`,
              `Run ${entry.name}`
            ));
          }
        }
      } catch {
        // Ignore permission errors
      }
    }
  }

  // Check for common build scripts
  const commonScripts = [
    'build.sh',
    'install.sh',
    'setup.sh',
    'deploy.sh',
    'test.sh',
    'run.sh',
    'start.sh',
    'stop.sh',
  ];

  for (const script of commonScripts) {
    const scriptPath = path.join(cwd, script);
    if (fs.existsSync(scriptPath)) {
      pushCommand(out, seenIds, buildCommand(
        workspaceRoot,
        cwd,
        'shell',
        script.replace('.sh', ''),
        `./${script}`,
        `Run ${script}`
      ));
    }
  }

  // Add common shell commands for Unix-like systems
  if (process.platform !== 'win32') {
    pushCommand(out, seenIds, buildCommand(
      workspaceRoot,
      cwd,
      'shell',
      'make executable',
      'chmod +x *.sh',
      'Make shell scripts executable'
    ));
  }
}

// ─── Bun ─────────────────────────────────────────────────────────────────────

async function scanBun(workspaceRoot: string, cwd: string, out: ProjectCommand[], seenIds: Set<string>): Promise<void> {
  // Check for Bun project (only when bun lockfile or config exists)
  const hasBunLock = fs.existsSync(path.join(cwd, 'bun.lock')) || fs.existsSync(path.join(cwd, 'bun.lockb'));
  const hasBunConfig = fs.existsSync(path.join(cwd, 'bunfig.toml'));

  if (!hasBunLock && !hasBunConfig) {
    return;
  }

  // Package.json scripts are already handled by scanNpm with the correct runner.
  // Only add bun-specific utility commands here.
  pushCommand(out, seenIds, buildCommand(
    workspaceRoot,
    cwd,
    'bun',
    'install',
    'bun install',
    'Install dependencies with Bun'
  ));

  pushCommand(out, seenIds, buildCommand(
    workspaceRoot,
    cwd,
    'bun',
    'update',
    'bun update',
    'Update dependencies with Bun'
  ));

  pushCommand(out, seenIds, buildCommand(
    workspaceRoot,
    cwd,
    'bun',
    'add',
    'bun add',
    'Add a dependency with Bun'
  ));

  pushCommand(out, seenIds, buildCommand(
    workspaceRoot,
    cwd,
    'bun',
    'add dev',
    'bun add -d',
    'Add a dev dependency with Bun'
  ));

  pushCommand(out, seenIds, buildCommand(
    workspaceRoot,
    cwd,
    'bun',
    'remove',
    'bun remove',
    'Remove a dependency with Bun'
  ));

  pushCommand(out, seenIds, buildCommand(
    workspaceRoot,
    cwd,
    'bun',
    'dev',
    'bun run dev',
    'Run dev script with Bun'
  ));

  pushCommand(out, seenIds, buildCommand(
    workspaceRoot,
    cwd,
    'bun',
    'build',
    'bun run build',
    'Run build script with Bun'
  ));

  pushCommand(out, seenIds, buildCommand(
    workspaceRoot,
    cwd,
    'bun',
    'test',
    'bun test',
    'Run tests with Bun'
  ));

  pushCommand(out, seenIds, buildCommand(
    workspaceRoot,
    cwd,
    'bun',
    'run',
    'bun run',
    'Run a script with Bun'
  ));

  // Check for TypeScript files to add bun run commands
  const hasTsConfig = fs.existsSync(path.join(cwd, 'tsconfig.json'));
  const hasMain = fs.existsSync(path.join(cwd, 'index.ts')) ||
                  fs.existsSync(path.join(cwd, 'main.ts')) ||
                  fs.existsSync(path.join(cwd, 'src/index.ts'));

  if (hasTsConfig && hasMain) {
    pushCommand(out, seenIds, buildCommand(
      workspaceRoot,
      cwd,
      'bun',
      'run ts',
      'bun run',
      'Run TypeScript with Bun'
    ));
  }

  // Check for test files
  const hasTestFiles = fs.existsSync(path.join(cwd, 'test')) ||
                      fs.existsSync(path.join(cwd, '__tests__')) ||
                      fs.existsSync(path.join(cwd, 'tests'));

  if (hasTestFiles) {
    pushCommand(out, seenIds, buildCommand(
      workspaceRoot,
      cwd,
      'bun',
      'test watch',
      'bun test --watch',
      'Run tests in watch mode with Bun'
    ));
  }
}

// ─── Deno ────────────────────────────────────────────────────────────────────

async function scanDeno(workspaceRoot: string, cwd: string, out: ProjectCommand[], seenIds: Set<string>): Promise<void> {
  // Check for Deno project
  const hasDenoJson = fs.existsSync(path.join(cwd, 'deno.json')) || fs.existsSync(path.join(cwd, 'deno.jsonc'));
  const hasDenoLock = fs.existsSync(path.join(cwd, 'deno.lock'));
  const hasImportMap = fs.existsSync(path.join(cwd, 'import_map.json'));

  if (!hasDenoJson && !hasDenoLock && !hasImportMap) {
    return;
  }

  // Add common Deno commands
  pushCommand(out, seenIds, buildCommand(
    workspaceRoot,
    cwd,
    'deno',
    'run',
    'deno run',
    'Run a Deno script'
  ));

  pushCommand(out, seenIds, buildCommand(
    workspaceRoot,
    cwd,
    'deno',
    'run with permissions',
    'deno run --allow-all',
    'Run Deno with all permissions'
  ));

  pushCommand(out, seenIds, buildCommand(
    workspaceRoot,
    cwd,
    'deno',
    'test',
    'deno test',
    'Run tests with Deno'
  ));

  pushCommand(out, seenIds, buildCommand(
    workspaceRoot,
    cwd,
    'deno',
    'test watch',
    'deno test --watch',
    'Run tests in watch mode'
  ));

  pushCommand(out, seenIds, buildCommand(
    workspaceRoot,
    cwd,
    'deno',
    'bench',
    'deno bench',
    'Run benchmarks with Deno'
  ));

  pushCommand(out, seenIds, buildCommand(
    workspaceRoot,
    cwd,
    'deno',
    'lint',
    'deno lint',
    'Lint code with Deno'
  ));

  pushCommand(out, seenIds, buildCommand(
    workspaceRoot,
    cwd,
    'deno',
    'fmt',
    'deno fmt',
    'Format code with Deno'
  ));

  pushCommand(out, seenIds, buildCommand(
    workspaceRoot,
    cwd,
    'deno',
    'fmt check',
    'deno fmt --check',
    'Check code formatting with Deno'
  ));

  pushCommand(out, seenIds, buildCommand(
    workspaceRoot,
    cwd,
    'deno',
    'check',
    'deno check',
    'Type-check code with Deno'
  ));

  pushCommand(out, seenIds, buildCommand(
    workspaceRoot,
    cwd,
    'deno',
    'cache',
    'deno cache',
    'Cache dependencies with Deno'
  ));

  pushCommand(out, seenIds, buildCommand(
    workspaceRoot,
    cwd,
    'deno',
    'info',
    'deno info',
    'Show Deno information'
  ));

  pushCommand(out, seenIds, buildCommand(
    workspaceRoot,
    cwd,
    'deno',
    'upgrade',
    'deno upgrade',
    'Upgrade Deno to latest version'
  ));

  // Scan for main entry points
  const entryPoints = [
    'main.ts',
    'index.ts',
    'mod.ts',
    'server.ts',
    'app.ts',
    'cli.ts',
    'main.js',
    'index.js',
    'server.js',
  ];

  for (const entry of entryPoints) {
    const entryPath = path.join(cwd, entry);
    if (fs.existsSync(entryPath)) {
      pushCommand(out, seenIds, buildCommand(
        workspaceRoot,
        cwd,
        'deno',
        `run ${entry}`,
        `deno run ${entry}`,
        `Run ${entry}`
      ));
    }
  }

  // Scan for test files
  const testDirs = ['test', 'tests', '__tests__'];
  for (const testDir of testDirs) {
    const testDirPath = path.join(cwd, testDir);
    if (fs.existsSync(testDirPath)) {
      try {
        const entries = fs.readdirSync(testDirPath, { withFileTypes: true });
        for (const entry of entries) {
          if (entry.isFile() && (entry.name.endsWith('.ts') || entry.name.endsWith('.js'))) {
            const testName = entry.name.replace(/\.(ts|js)$/, '');
            pushCommand(out, seenIds, buildCommand(
              workspaceRoot,
              cwd,
              'deno',
              `test ${testName}`,
              `deno test ${path.join(testDir, entry.name)}`,
              `Run ${entry.name}`
            ));
          }
        }
      } catch {
        // Ignore permission errors
      }
    }
  }

  // Check for Deno JSON config
  if (hasDenoJson) {
    const denoJsonPath = fs.existsSync(path.join(cwd, 'deno.json')) ? 'deno.json' : 'deno.jsonc';
    const content = readFile(path.join(cwd, denoJsonPath));
    if (content) {
      try {
        const config = JSON.parse(content);
        // Check for scripts/tasks in deno.json
        const tasks = config.tasks || config.scripts;
        if (tasks && typeof tasks === 'object') {
          for (const [name, cmd] of Object.entries(tasks)) {
            pushCommand(out, seenIds, buildCommand(
              workspaceRoot,
              cwd,
              'deno',
              `task ${name}`,
              `deno task ${name}`,
              String(cmd)
            ));
          }
        }
      } catch {
        // Invalid JSON, skip
      }
    }
  }
}

// ─── npx ──────────────────────────────────────────────────────────────────────

async function scanNpx(workspaceRoot: string, cwd: string, out: ProjectCommand[], seenIds: Set<string>): Promise<void> {
  // Check for package.json (required for npx)
  const hasPackageJson = fs.existsSync(path.join(cwd, 'package.json'));
  if (!hasPackageJson) {
    return;
  }

  const content = readFile(path.join(cwd, 'package.json'));
  if (!content) return;

  let pkg: any;
  try { pkg = JSON.parse(content); } catch { return; }

  // Add npx commands only for tools actually in this project's dependencies
  const deps = {
    ...pkg.dependencies,
    ...pkg.devDependencies,
    ...pkg.peerDependencies,
  };

  if (deps) {
    // TypeScript-related commands
    if (deps.typescript) {
      pushCommand(out, seenIds, buildCommand(
        workspaceRoot,
        cwd,
        'npx',
        'tsc',
        'npx tsc',
        'Run TypeScript compiler'
      ));

      pushCommand(out, seenIds, buildCommand(
        workspaceRoot,
        cwd,
        'npx',
        'tsc watch',
        'npx tsc --watch',
        'Run TypeScript compiler in watch mode'
      ));
    }

    // ESLint
    if (deps.eslint) {
      pushCommand(out, seenIds, buildCommand(
        workspaceRoot,
        cwd,
        'npx',
        'eslint',
        'npx eslint',
        'Run ESLint'
      ));

      pushCommand(out, seenIds, buildCommand(
        workspaceRoot,
        cwd,
        'npx',
        'eslint fix',
        'npx eslint --fix',
        'Run ESLint with auto-fix'
      ));
    }

    // Prettier
    if (deps.prettier) {
      pushCommand(out, seenIds, buildCommand(
        workspaceRoot,
        cwd,
        'npx',
        'prettier check',
        'npx prettier --check .',
        'Check code formatting with Prettier'
      ));

      pushCommand(out, seenIds, buildCommand(
        workspaceRoot,
        cwd,
        'npx',
        'prettier write',
        'npx prettier --write .',
        'Format code with Prettier'
      ));
    }

    // Vitest
    if (deps.vitest) {
      pushCommand(out, seenIds, buildCommand(
        workspaceRoot,
        cwd,
        'npx',
        'vitest',
        'npx vitest',
        'Run Vitest'
      ));

      pushCommand(out, seenIds, buildCommand(
        workspaceRoot,
        cwd,
        'npx',
        'vitest ui',
        'npx vitest --ui',
        'Run Vitest with UI'
      ));
    }

    // Jest
    if (deps.jest) {
      pushCommand(out, seenIds, buildCommand(
        workspaceRoot,
        cwd,
        'npx',
        'jest',
        'npx jest',
        'Run Jest'
      ));

      pushCommand(out, seenIds, buildCommand(
        workspaceRoot,
        cwd,
        'npx',
        'jest watch',
        'npx jest --watch',
        'Run Jest in watch mode'
      ));
    }

    // Cypress
    if (deps.cypress) {
      pushCommand(out, seenIds, buildCommand(
        workspaceRoot,
        cwd,
        'npx',
        'cypress open',
        'npx cypress open',
        'Open Cypress'
      ));

      pushCommand(out, seenIds, buildCommand(
        workspaceRoot,
        cwd,
        'npx',
        'cypress run',
        'npx cypress run',
        'Run Cypress tests'
      ));
    }

    // Playwright
    if (deps.playwright || deps['@playwright/test']) {
      pushCommand(out, seenIds, buildCommand(
        workspaceRoot,
        cwd,
        'npx',
        'playwright test',
        'npx playwright test',
        'Run Playwright tests'
      ));

      pushCommand(out, seenIds, buildCommand(
        workspaceRoot,
        cwd,
        'npx',
        'playwright show-report',
        'npx playwright show-report',
        'Show Playwright report'
      ));
    }

    // Next.js
    if (deps.next) {
      pushCommand(out, seenIds, buildCommand(
        workspaceRoot,
        cwd,
        'npx',
        'next dev',
        'npx next dev',
        'Run Next.js in development'
      ));

      pushCommand(out, seenIds, buildCommand(
        workspaceRoot,
        cwd,
        'npx',
        'next build',
        'npx next build',
        'Build Next.js application'
      ));

      pushCommand(out, seenIds, buildCommand(
        workspaceRoot,
        cwd,
        'npx',
        'next start',
        'npx next start',
        'Start Next.js production server'
      ));
    }

    // Vite
    if (deps.vite) {
      pushCommand(out, seenIds, buildCommand(
        workspaceRoot,
        cwd,
        'npx',
        'vite dev',
        'npx vite',
        'Run Vite dev server'
      ));

      pushCommand(out, seenIds, buildCommand(
        workspaceRoot,
        cwd,
        'npx',
        'vite build',
        'npx vite build',
        'Build with Vite'
      ));

      pushCommand(out, seenIds, buildCommand(
        workspaceRoot,
        cwd,
        'npx',
        'vite preview',
        'npx vite preview',
        'Preview Vite build'
      ));
    }

    // Tailwind CSS
    if (deps.tailwindcss) {
      pushCommand(out, seenIds, buildCommand(
        workspaceRoot,
        cwd,
        'npx',
        'tailwind init',
        'npx tailwindcss init',
        'Initialize Tailwind CSS'
      ));
    }

    // Prisma
    if (deps.prisma) {
      pushCommand(out, seenIds, buildCommand(
        workspaceRoot,
        cwd,
        'npx',
        'prisma generate',
        'npx prisma generate',
        'Generate Prisma client'
      ));

      pushCommand(out, seenIds, buildCommand(
        workspaceRoot,
        cwd,
        'npx',
        'prisma migrate',
        'npx prisma migrate dev',
        'Run Prisma migrations'
      ));

      pushCommand(out, seenIds, buildCommand(
        workspaceRoot,
        cwd,
        'npx',
        'prisma studio',
        'npx prisma studio',
        'Open Prisma Studio'
      ));

      pushCommand(out, seenIds, buildCommand(
        workspaceRoot,
        cwd,
        'npx',
        'prisma db seed',
        'npx prisma db seed',
        'Seed Prisma database'
      ));
    }
  }
}

// ─── pnpm ─────────────────────────────────────────────────────────────────────

async function scanPnpm(workspaceRoot: string, cwd: string, out: ProjectCommand[], seenIds: Set<string>): Promise<void> {
  // Check for pnpm project (only when pnpm lockfile exists)
  const hasPnpmLock = fs.existsSync(path.join(cwd, 'pnpm-lock.yaml'));

  if (!hasPnpmLock) {
    return;
  }

  // Package.json scripts are already handled by scanNpm with the correct runner.
  // Only add pnpm-specific utility commands here.
  pushCommand(out, seenIds, buildCommand(
    workspaceRoot,
    cwd,
    'pnpm',
    'install',
    'pnpm install',
    'Install dependencies with pnpm'
  ));

  pushCommand(out, seenIds, buildCommand(
    workspaceRoot,
    cwd,
    'pnpm',
    'update',
    'pnpm update',
    'Update dependencies with pnpm'
  ));

  pushCommand(out, seenIds, buildCommand(
    workspaceRoot,
    cwd,
    'pnpm',
    'add',
    'pnpm add',
    'Add a dependency with pnpm'
  ));

  pushCommand(out, seenIds, buildCommand(
    workspaceRoot,
    cwd,
    'pnpm',
    'add dev',
    'pnpm add -D',
    'Add a dev dependency with pnpm'
  ));

  pushCommand(out, seenIds, buildCommand(
    workspaceRoot,
    cwd,
    'pnpm',
    'remove',
    'pnpm remove',
    'Remove a dependency with pnpm'
  ));

  pushCommand(out, seenIds, buildCommand(
    workspaceRoot,
    cwd,
    'pnpm',
    'dev',
    'pnpm run dev',
    'Run dev script with pnpm'
  ));

  pushCommand(out, seenIds, buildCommand(
    workspaceRoot,
    cwd,
    'pnpm',
    'build',
    'pnpm run build',
    'Run build script with pnpm'
  ));

  pushCommand(out, seenIds, buildCommand(
    workspaceRoot,
    cwd,
    'pnpm',
    'test',
    'pnpm test',
    'Run tests with pnpm'
  ));

  pushCommand(out, seenIds, buildCommand(
    workspaceRoot,
    cwd,
    'pnpm',
    'lint',
    'pnpm run lint',
    'Run lint script with pnpm'
  ));

  pushCommand(out, seenIds, buildCommand(
    workspaceRoot,
    cwd,
    'pnpm',
    'run',
    'pnpm run',
    'Run a script with pnpm'
  ));

  pushCommand(out, seenIds, buildCommand(
    workspaceRoot,
    cwd,
    'pnpm',
    'store',
    'pnpm store',
    'Manage pnpm store'
  ));

  pushCommand(out, seenIds, buildCommand(
    workspaceRoot,
    cwd,
    'pnpm',
    'import',
    'pnpm import',
    'Import dependencies to pnpm store'
  ));

  pushCommand(out, seenIds, buildCommand(
    workspaceRoot,
    cwd,
    'pnpm',
    'why',
    'pnpm why',
    'Show why a package is installed'
  ));

  pushCommand(out, seenIds, buildCommand(
    workspaceRoot,
    cwd,
    'pnpm',
    'list',
    'pnpm list',
    'List installed packages'
  ));

  pushCommand(out, seenIds, buildCommand(
    workspaceRoot,
    cwd,
    'pnpm',
    'outdated',
    'pnpm outdated',
    'Check for outdated packages'
  ));

  // Check for pnpm workspace
  const hasWorkspace = fs.existsSync(path.join(cwd, 'pnpm-workspace.yaml'));
  if (hasWorkspace) {
    pushCommand(out, seenIds, buildCommand(
      workspaceRoot,
      cwd,
      'pnpm',
      'workspace',
      'pnpm workspace',
      'Manage pnpm workspace'
    ));

    pushCommand(out, seenIds, buildCommand(
      workspaceRoot,
      cwd,
      'pnpm',
      'recursive install',
      'pnpm -r install',
      'Install in all workspace packages'
    ));

    pushCommand(out, seenIds, buildCommand(
      workspaceRoot,
      cwd,
      'pnpm',
      'recursive update',
      'pnpm -r update',
      'Update all workspace packages'
    ));
  }
}
