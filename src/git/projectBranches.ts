import * as vscode from 'vscode';
import { execFile } from 'child_process';
import { promisify } from 'util';

const exec = promisify(execFile);

/** Called inside the same project lock used by Sync, Push and Pull. */
export async function pickProjectBranch(projectPath: string): Promise<boolean> {
    const git = async (...args: string[]) => (await exec('git', args, {
        cwd: projectPath, windowsHide: true, encoding: 'utf8', maxBuffer: 4 * 1024 * 1024,
    })).stdout.trim();
    const current = await git('branch', '--show-current');
    const refs = await git('for-each-ref', '--format=%(refname)', 'refs/heads/', 'refs/remotes/origin/');
    const local = refs.replace(/\r/g, '').split('\n').filter(ref => ref.startsWith('refs/heads/'))
        .map(ref => ref.slice('refs/heads/'.length));
    const remote = refs.replace(/\r/g, '').split('\n').filter(ref => ref.startsWith('refs/remotes/origin/') && !ref.endsWith('/HEAD'))
        .map(ref => ref.slice('refs/remotes/origin/'.length)).filter(name => !local.includes(name));
    const items = [
        { label: '$(add) Create new branch…', description: `From ${current || 'current HEAD'}`, name: '', remote: false },
        ...local.map(name => ({ label: name, description: name === current ? 'Current branch' : 'Local branch', name, remote: false })),
        ...remote.map(name => ({ label: name, description: 'origin · create local tracking branch', name, remote: true })),
    ];
    const picked = await vscode.window.showQuickPick(items, {
        title: 'Project branch', placeHolder: 'Switch branch or create a new one', ignoreFocusOut: true,
    });
    if (!picked || (picked.name && picked.name === current)) return false;
    if (!picked.name) {
        const name = await vscode.window.showInputBox({
            title: 'Create new branch', prompt: 'Create and switch to a branch from the current checkout',
            placeHolder: 'feature/my-change', ignoreFocusOut: true,
            validateInput: async value => {
                if (!value || value !== value.trim()) return 'Enter a branch name without surrounding spaces';
                try {
                    if (await git('check-ref-format', '--branch', value) !== value) return 'Enter a literal branch name';
                    if (local.includes(value)) return 'A local branch with this name already exists';
                    return undefined;
                } catch { return 'Invalid Git branch name'; }
            },
        });
        if (!name) return false;
        // Revalidate at the mutation boundary; never interpolate branch names into a shell.
        if (await git('check-ref-format', '--branch', name) !== name) throw new Error('Invalid branch name');
        await git('switch', '--no-track', '-c', name);
    } else {
        if (await git('status', '--porcelain')) {
            throw new Error('Commit or stash your local changes before switching branches. Sync can commit and publish them on the current branch.');
        }
        if (picked.remote) await git('switch', '--track', '-c', picked.name, `origin/${picked.name}`);
        else await git('switch', '--no-guess', '--', picked.name);
    }
    return true;
}
