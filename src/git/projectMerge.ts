import * as vscode from 'vscode';
import * as fs from 'fs';
import { execFile } from 'child_process';
import { promisify } from 'util';

const exec = promisify(execFile);

/** A local branch merge, called under the project's Sync/Push/Pull lock. */
export async function mergeProjectBranches(projectPath: string, publishAfterMerge = false): Promise<string | undefined> {
    const git = async (...args: string[]) => (await exec('git', args, {
        cwd: projectPath, windowsHide: true, encoding: 'utf8', maxBuffer: 4 * 1024 * 1024,
    })).stdout.trim();
    const gitPathExists = async (name: string) => fs.existsSync(await git('rev-parse', '--path-format=absolute', '--git-path', name));
    const assertReady = async () => {
        for (const marker of ['MERGE_HEAD', 'CHERRY_PICK_HEAD', 'REVERT_HEAD', 'rebase-merge', 'rebase-apply', 'sequencer']) {
            if (await gitPathExists(marker)) throw new Error('Finish or abort the Git operation already in progress before merging branches.');
        }
        if (await git('status', '--porcelain')) {
            throw new Error('Commit or stash your local changes before merging branches.');
        }
    };
    await assertReady();
    const current = await git('branch', '--show-current');
    const refs = (await git('for-each-ref', '--format=%(refname)', 'refs/heads/', 'refs/remotes/origin/'))
        .replace(/\r/g, '').split('\n');
    const locals = refs.filter(ref => ref.startsWith('refs/heads/')).map(ref => ({
        label: ref.slice('refs/heads/'.length), ref,
    }));
    if (!locals.length) throw new Error('Create your first commit before merging branches.');
    const target = await vscode.window.showQuickPick(
        [...locals].sort((a, b) => Number(b.label === current) - Number(a.label === current))
            .map(item => ({ ...item, description: item.label === current ? 'Destination · current branch' : 'Destination · local branch' })),
        { title: 'Merge: choose destination', placeHolder: 'Which branch should receive the changes? For example: main', ignoreFocusOut: true }
    );
    if (!target) return undefined;
    const sources = [
        ...locals.filter(item => item.ref !== target.ref).map(item => ({ ...item, description: 'Local branch' })),
        ...refs.filter(ref => ref.startsWith('refs/remotes/origin/') && !ref.endsWith('/HEAD'))
            .filter(ref => ref !== `refs/remotes/origin/${target.label}`)
            .map(ref => ({ label: ref.slice('refs/remotes/'.length), ref, description: 'Remote branch · last fetched version' })),
    ];
    if (!sources.length) throw new Error('There is no other branch to merge. Create a feature branch first.');
    const source = await vscode.window.showQuickPick(sources, {
        title: `Merge into ${target.label}`, placeHolder: `Which branch's changes should be brought into ${target.label}?`, ignoreFocusOut: true,
    });
    if (!source) return undefined;
    const action = await vscode.window.showWarningMessage(
        `${publishAfterMerge ? 'Merge & Sync' : 'Merge'} ${source.label} into ${target.label}?`,
        { modal: true, detail: `This brings ${source.label}'s commits into ${target.label} and leaves ${target.label} selected. The source branch is kept. ${publishAfterMerge ? `After a successful merge, Sync will publish ${target.label} to its remote.` : 'Click Sync afterward to publish the result.'} If conflicts occur, the attempted merge will be aborted.` },
        publishAfterMerge ? 'Merge & Sync' : 'Merge'
    );
    if (action !== (publishAfterMerge ? 'Merge & Sync' : 'Merge')) return undefined;
    // The user may have edited files while the picker was open.
    await assertReady();
    await git('switch', '--no-guess', '--', target.label);
    try {
        // Explicit refs avoid a same-named tag being merged accidentally.
        await git('merge', '--ff', '--commit', '--no-edit', '--no-squash', '--no-autostash', '--', source.ref);
    } catch (err: any) {
        const conflicts = await git('diff', '--name-only', '--diff-filter=U');
        if (await gitPathExists('MERGE_HEAD')) {
            try { await git('merge', '--abort'); }
            catch {
                throw new Error(`Merge could not be aborted. Finish or abort it in Source Control before using Sync. ${conflicts ? `Conflicting files: ${conflicts}` : ''}`);
            }
        }
        if (conflicts) {
            throw new Error(`Merge ${source.label} into ${target.label} was aborted because both branches changed the same content. Conflicting files: ${conflicts}. Resolve these changes in Source Control before trying again.`);
        }
        throw new Error(`Could not merge ${source.label} into ${target.label}: ${err?.stderr || err?.message || String(err)}`);
    }
    return `Merged ${source.label} into ${target.label}. Click Sync to publish ${target.label}.`;
}
