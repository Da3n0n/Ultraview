import * as fs from 'fs/promises';
import * as path from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';

const exec = promisify(execFile);

/** Import nested Git checkouts as files; never push or rewrite their history. */
export async function vendorRepositories(projectPath: string): Promise<string[]> {
    const root = await fs.realpath(projectPath);
    const git = async (cwd: string, args: string[]) => (await exec('git', args, {
        cwd, windowsHide: true, timeout: 120000, maxBuffer: 64 * 1024 * 1024,
    })).stdout;
    const roots: string[] = [];
    const excluded = new Set(['.git', 'node_modules', '.venv', 'venv', '__pycache__', '.gitnexus', 'dist', 'build', '.next', '.cache', '.hutch', '.cottontail-tmp', 'checkpoints', 'artifacts']);
    const scan = async (directory: string): Promise<void> => {
        const entries = await fs.readdir(directory, { withFileTypes: true });
        if (directory !== root && entries.some(entry => entry.name === '.git')) roots.push(directory);
        for (const entry of entries) {
            if (entry.isDirectory() && !entry.isSymbolicLink() && !excluded.has(entry.name)) {
                await scan(path.join(directory, entry.name));
            }
        }
    };
    // Git supplies visible top-level content, respecting ignored downloads and
    // runtime environments while still including tracked submodule paths.
    const visible = new Set((await git(root, ['ls-files', '--cached', '--others', '--exclude-standard', '--directory', '-z']))
        .split('\0').filter(Boolean).map(file => file.split('/')[0]));
    for (const name of visible) {
        if (excluded.has(name)) continue;
        const directory = path.join(root, name);
        const stat = await fs.lstat(directory).catch(() => undefined);
        if (stat?.isDirectory() && !stat.isSymbolicLink()) await scan(directory);
    }
    if (!roots.length) return [];
    const manifestPath = path.join(root, '.ultraview-vendors.json');
    const manifest: { version: number; repositories: Record<string, any> } = await fs.readFile(manifestPath, 'utf8')
        .then(text => JSON.parse(text), (error: any) => { if (error.code !== 'ENOENT') throw error; return { version: 1, repositories: {} }; });
    if (manifest.version !== 1 || !manifest.repositories) throw new Error('Unsupported vendor manifest');
    const gitDir = (await git(root, ['rev-parse', '--absolute-git-dir'])).trim();
    const backup = await fs.mkdtemp(path.join(gitDir, 'ultraview-import-'));
    const imported: string[] = [];
    // Children first: their files become ordinary tracked files in the parent
    // before the parent's own repository boundary is removed.
    for (const directory of roots.sort((a, b) => b.length - a.length)) {
        const relative = path.relative(root, directory);
        if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('Import path escapes project');
        const parent = roots.filter(candidate => candidate !== directory && directory.startsWith(candidate + path.sep))
            .sort((a, b) => b.length - a.length)[0] ?? root;
        const localPath = path.relative(parent, directory).replace(/\\/g, '/');
        const unresolved = await git(directory, ['ls-files', '-u']);
        if (unresolved.trim()) throw new Error(`Resolve conflicts in ${relative} before importing it`);
        const head = (await git(directory, ['rev-parse', 'HEAD'])).trim();
        const upstream = (await git(directory, ['remote', 'get-url', 'origin']).catch(() => '')).trim()
            .replace(/(https?:\/\/)[^/@]+@/i, '$1');
        let upstreamRef = (await git(directory, ['symbolic-ref', 'refs/remotes/origin/HEAD']).catch(() => '')).trim();
        if (!upstreamRef) upstreamRef = 'refs/remotes/origin/main';
        const base = (await git(directory, ['merge-base', 'HEAD', upstreamRef]).catch(() => head)).trim();
        manifest.repositories[relative.replace(/\\/g, '/')] = {
            upstream, branch: upstreamRef.replace('refs/remotes/origin/', ''), base, importedHead: head,
        };
        const files = [...new Set((await git(directory, ['ls-files', '--cached', '--others', '--exclude-standard', '-z'])).split('\0').filter(Boolean))];
        const saved = path.join(backup, String(imported.length));
        await fs.mkdir(saved);
        await fs.writeFile(path.join(saved, 'manifest.json'), JSON.stringify({ directory, files }, null, 2));
        const parentIndex = (await git(parent, ['rev-parse', '--path-format=absolute', '--git-path', 'index'])).trim();
        await fs.copyFile(parentIndex, path.join(saved, 'parent-index')).catch((error: any) => {
            if (error.code !== 'ENOENT') throw error;
        });
        await fs.copyFile(path.join(parent, '.gitmodules'), path.join(saved, 'parent-gitmodules')).catch((error: any) => {
            if (error.code !== 'ENOENT') throw error;
        });
        // Keep all repository metadata outside the worktree for recovery. For
        // submodules the .git file is saved; its object database stays in modules/.
        const metadata = path.join(directory, '.git');
        const metadataStat = await fs.lstat(metadata);
        if (metadataStat.isSymbolicLink()) throw new Error(`Cannot import symbolic Git metadata in ${relative}`);
        const indexEntry = await git(parent, ['ls-files', '--stage', '--', localPath]);
        if (indexEntry.startsWith('160000 ')) await git(parent, ['rm', '--cached', '-f', '--', localPath]);
        await fs.rename(metadata, path.join(saved, 'git-metadata'));
        const modulesFile = path.join(parent, '.gitmodules');
        if (await fs.stat(modulesFile).then(() => true, () => false)) {
            let config = '';
            try { config = await git(parent, ['config', '-z', '-f', '.gitmodules', '--get-regexp', '^submodule\\..*\\.path$']); }
            catch (error: any) { if (error.code !== 1) throw error; }
            for (const entry of config.split('\0').filter(Boolean)) {
                const newline = entry.indexOf('\n');
                if (entry.slice(newline + 1) === localPath) {
                    await git(parent, ['config', '-f', '.gitmodules', '--remove-section', entry.slice(0, newline).replace(/\.path$/, '')]);
                }
            }
            await git(parent, ['add', '-f', '--', '.gitmodules']);
        }
        // Preserve formerly tracked files even if a parent ignore rule matches
        // vendor/. Deleted files stay deleted; generated untracked files are not
        // force-added. NUL pathspecs support spaces and large dependency trees.
        const existing: string[] = [];
        for (const file of files) {
            if (await fs.lstat(path.join(directory, file)).then(() => true, () => false)) {
                existing.push(`${localPath}/${file}`);
            }
        }
        if (existing.length) {
            const specs = path.join(saved, 'paths');
            await fs.writeFile(specs, existing.join('\0') + '\0');
            await git(parent, ['--literal-pathspecs', 'add', '-f', `--pathspec-from-file=${specs}`, '--pathspec-file-nul']);
        }
        imported.push(relative.replace(/\\/g, '/'));
        await fs.writeFile(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
    }
    return imported;
}
