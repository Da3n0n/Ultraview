import { execFile, spawn } from 'child_process';
import { promisify } from 'util';

const exec = promisify(execFile);

/** Check staged objects, not worktree sizes (Git LFS pointers remain valid). */
export async function assertGitHubBlobSizes(projectPath: string, limit = 100 * 1024 * 1024): Promise<void> {
    const options = { cwd: projectPath, windowsHide: true, timeout: 30000, maxBuffer: 32 * 1024 * 1024 };
    const remote = await exec('git', ['remote', 'get-url', 'origin'], options).catch(() => undefined);
    if (!remote || !/^(?:https?:\/\/(?:[^/@]+@)?github\.com\/|git@github\.com:)/i.test(remote.stdout.trim())) return;
    const { stdout } = await exec('git', ['ls-files', '--stage', '-z'], options);
    const names = new Map<string, string>();
    for (const entry of stdout.split('\0')) {
        const match = entry.match(/^100\d{3} ([a-f0-9]+) 0\t([\s\S]+)$/);
        if (match) names.set(match[1], match[2]);
    }
    if (!names.size) return;
    const sizes = await new Promise<string>((resolve, reject) => {
        const child = spawn('git', ['cat-file', '--batch-check=%(objectname) %(objectsize)'], options);
        let output = '';
        let errorOutput = '';
        child.stdout.on('data', chunk => { output += chunk; });
        child.stderr.on('data', chunk => { errorOutput += chunk; });
        child.on('error', reject);
        child.stdin.on('error', reject);
        child.on('close', code => code === 0 ? resolve(output) : reject(new Error(errorOutput || 'Could not check staged file sizes')));
        child.stdin.end([...names.keys()].join('\n') + '\n');
    });
    const oversized = sizes.trim().split('\n').flatMap(line => {
        const [oid, size] = line.split(' ');
        if (!/^\d+$/.test(size)) throw new Error('Could not determine staged file size');
        return Number(size) > limit ? [`${names.get(oid)} (${(Number(size) / 1024 / 1024).toFixed(1)} MiB)`] : [];
    });
    if (oversized.length) throw new Error(
        `Commit stopped: GitHub rejects files larger than 100 MiB: ${oversized.slice(0, 5).join(', ')}. ` +
        'Keep downloaded models/build artifacts local using .gitignore and unstage them, or configure Git LFS. Files remain on disk; no commit was created.'
    );
}
