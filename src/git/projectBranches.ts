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
    const saved = await git('stash', 'list', '--format=%H%x09%gs');
    const items = [
        { label: '$(add) Create new branch…', description: `From ${current || 'current HEAD'}`, name: '', remote: false },
        ...(saved ? [{ label: '$(history) Restore saved edits…', description: 'Recover a stash on a new branch from its original base', name: '', remote: false, restore: true }] : []),
        ...local.map(name => ({ label: name, description: name === current ? 'Current branch' : 'Local branch', name, remote: false })),
        ...remote.map(name => ({ label: name, description: 'origin · create local tracking branch', name, remote: true })),
    ];
    const picked = await vscode.window.showQuickPick(items, {
        title: 'Project branch', placeHolder: 'Switch branch or create a new one', ignoreFocusOut: true,
    });
    if (!picked || (picked.name && picked.name === current)) return false;
    if ('restore' in picked) {
        if (await git('status', '--porcelain')) throw new Error('Carry or save your current edits before restoring saved edits.');
        const stash = await vscode.window.showQuickPick(saved.split('\n').map(line => {
            const [id, ...message] = line.replace(/\r/g, '').split('\t');
            return { label: message.join('\t'), id };
        }), { title: 'Restore saved edits', placeHolder: 'Choose the saved work to recover', ignoreFocusOut: true });
        if (!stash) return false;
        const name = await vscode.window.showInputBox({
            title: 'Restore saved edits on a new branch', value: `saved-edits/${Date.now()}`,
            prompt: 'A new branch starts from the saved edits’ original base. The saved copy is kept as a backup.',
            ignoreFocusOut: true,
            validateInput: async value => {
                try {
                    return !value || await git('check-ref-format', '--branch', value) !== value || local.includes(value)
                        ? 'Enter a valid, unused branch name' : undefined;
                } catch { return 'Enter a valid, unused branch name'; }
            },
        });
        if (!name) return false;
        if (await git('check-ref-format', '--branch', name) !== name) throw new Error('Invalid branch name');
        if (await git('status', '--porcelain')) throw new Error('Your files changed while choosing saved edits. Save them before restoring.');
        await git('stash', 'branch', name, stash.id);
        vscode.window.showInformationMessage(`Restored saved edits on ${name}. Sync will publish them on this branch. The saved copy is kept as a backup.`);
        return true;
    }
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
        let savedId: string | undefined;
        if (await git('status', '--porcelain')) {
            const choice = await vscode.window.showQuickPick([
                { label: 'Carry my edits to this branch', detail: `Keep your uncommitted files. Sync will commit and publish them on ${picked.name}.`, action: 'carry' },
                { label: 'Save edits for later and switch', detail: `Save edits from ${current || 'detached HEAD'} in a stash, then open ${picked.name} without them.`, action: 'save' },
            ], { title: `Switch to ${picked.name}`, placeHolder: 'What should happen to your uncommitted edits?', ignoreFocusOut: true });
            if (!choice) return false;
            if (choice.action === 'save') {
                await git('stash', 'push', '--include-untracked', '-m', `Ultraview saved edits from ${current || 'detached HEAD'}`);
                savedId = await git('rev-parse', 'refs/stash');
            }
        }
        try {
            if (picked.remote) await git('switch', '--track', '-c', picked.name, `origin/${picked.name}`);
            else await git('switch', '--no-guess', '--', picked.name);
        } catch (err: any) {
            if (savedId) {
                throw new Error(`Switch failed. Your edits are saved safely (${savedId.slice(0, 8)}). Use “Restore saved edits…” in the branch menu. ${err?.stderr || err?.message}`);
            }
            throw new Error(`Git could not switch without overwriting your edits. You are still on ${current || 'detached HEAD'}. Choose “Save edits for later and switch” to keep them safe. ${err?.stderr || err?.message}`);
        }
        if (savedId) vscode.window.showInformationMessage(`Switched to ${picked.name}. Your previous edits are saved; use “Restore saved edits…” in the branch menu to recover them.`);
    }
    return true;
}
