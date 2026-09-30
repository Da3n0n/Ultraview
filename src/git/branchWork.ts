import * as vscode from 'vscode';
import { execFile } from 'child_process';
import { promisify } from 'util';

const exec = promisify(execFile);

/** Inspect branch work without checking out, committing or publishing anything. */
export async function showBranchWork(projectPath: string): Promise<void> {
    const git = async (...args: string[]) => (await exec('git', args, {
        cwd: projectPath, windowsHide: true, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024,
    })).stdout.trim();
    const refs = (await git('for-each-ref', '--format=%(refname)%09%(objectname)', 'refs/heads/', 'refs/remotes/origin/'))
        .replace(/\r/g, '').split('\n').filter(Boolean).map(line => {
            const [ref, id] = line.split('\t');
            return { ref, id, label: ref.replace(/^refs\/(heads|remotes)\//, '') };
        }).filter(item => item.ref !== 'refs/remotes/origin/HEAD');
    if (!refs.length) {
        vscode.window.showInformationMessage('Create your first commit to compare branch work.');
        return;
    }
    let base = ['refs/heads/main', 'refs/heads/master', 'refs/remotes/origin/main', 'refs/remotes/origin/master']
        .map(ref => refs.find(item => item.ref === ref)).find(Boolean);
    if (!base) {
        base = await vscode.window.showQuickPick(refs, {
            title: 'Branch work: choose baseline', placeHolder: 'Which branch should the others be compared with?', ignoreFocusOut: true,
        });
    }
    if (!base) return;
    const current = await git('branch', '--show-current');
    const locals = new Set(refs.filter(item => item.ref.startsWith('refs/heads/')).map(item => item.label));
    const branches = [];
    for (const item of refs) {
        if (item.ref === base.ref || (item.ref.startsWith('refs/remotes/origin/') && locals.has(item.label.slice('origin/'.length)))) continue;
        const [behind, ahead] = (await git('rev-list', '--left-right', '--count', `${base.id}...${item.id}`)).split(/\s+/).map(Number);
        branches.push({ ...item, ahead, behind,
            description: `${ahead} commits not in ${base.label} · ${behind} ${base.label} commits missing`,
            detail: `${item.label === current ? 'Selected branch. ' : ''}Committed branch work; separate from uncommitted files and remote Sync status.${item.ref.startsWith('refs/remotes/') ? ' Last fetched remote version.' : ''}`,
        });
    }
    branches.sort((a, b) => b.ahead - a.ahead || a.label.localeCompare(b.label));
    const picked = await vscode.window.showQuickPick([
        { label: 'Current files on disk', id: '', ref: '', description: `Compare ${current || 'detached HEAD'} and its uncommitted edits with ${base.label}`, detail: 'This is the checkout Sync would commit. Other branches’ files are not automatically included.' },
        ...branches,
    ], { title: `Branch work compared with ${base.label}`, placeHolder: 'View current files or work on another branch', ignoreFocusOut: true });
    if (!picked) return;
    let comparisonBase = base.id;
    let explanation: string;
    let diff: string;
    if (picked.id) {
        try {
            comparisonBase = await git('merge-base', base.id, picked.id);
            explanation = `Committed work on ${picked.label} since its common ancestor with ${base.label}.\nThis is branch work, not uncommitted edits. Merge the branch into ${base.label} to include it there; Sync alone does not do that.`;
        } catch {
            explanation = `No common ancestor. Comparing the complete snapshots of ${base.label} and ${picked.label}.`;
        }
        diff = await git('diff', '--no-ext-diff', '--no-textconv', '--no-color', comparisonBase, picked.id, '--');
    } else {
        explanation = `Current tracked files on disk compared with ${base.label}, including staged and unstaged edits.\nSelected branch: ${current || 'detached HEAD'}. Sync publishes this checkout to its selected branch, not to every branch.`;
        diff = await git('diff', '--no-ext-diff', '--no-textconv', '--no-color', comparisonBase, '--');
        const untracked = await git('ls-files', '--others', '--exclude-standard');
        if (untracked) explanation += `\n\nNew untracked files (not included in the patch below):\n${untracked}`;
    }
    const document = await vscode.workspace.openTextDocument({
        language: 'diff', content: `Branch work: ${picked.label} vs ${base.label}\n\n${explanation}\n\n${diff || 'No file differences for this comparison.'}\n`,
    });
    await vscode.window.showTextDocument(document, { preview: false });
}
