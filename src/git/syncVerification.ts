type Runner = (command: string) => Promise<{ stdout: string; stderr: string }>;

/** A fresh remote read is mandatory; cached tracking refs cannot prove sync. */
export async function verifyProjectSync(run: Runner): Promise<boolean> {
    const branch = (await run('git branch --show-current')).stdout.trim();
    if (!branch || /["'\r\n]/.test(branch)) throw new Error('Cannot verify Sync without a supported local branch');
    await run(`git fetch --no-tags --no-recurse-submodules origin "+refs/heads/${branch}:refs/remotes/origin/${branch}"`);
    const remote = (await run(`git ls-remote --exit-code origin "refs/heads/${branch}"`)).stdout.trim().split(/\s+/)[0];
    if (!/^[a-f0-9]{40,64}$/.test(remote)) throw new Error('Remote branch could not be verified');
    const head = (await run('git rev-parse HEAD')).stdout.trim();
    const status = (await run('git status --porcelain')).stdout.trim();
    return head === remote && !status;
}

/** Never publish a gitlink pointing to a separate vendor repository. */
export async function assertNoImportedGitlinks(run: Runner): Promise<void> {
    const index = (await run('git ls-files --stage -z')).stdout;
    const links = index.split('\0').filter(entry => entry.startsWith('160000 '));
    if (links.length) throw new Error(
        `Imported repositories still need to be copied into the project: ${links.map(entry => entry.slice(entry.indexOf('\t') + 1)).join(', ')}. No vendor push was attempted.`
    );
}
