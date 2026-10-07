const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const ts = require('typescript');

const source = ts.createSourceFile('provider.ts', fs.readFileSync('src/providers/gitProvider.ts', 'utf8'), ts.ScriptTarget.Latest, true);
const names = ['isTransientGitError', 'withTransientRetry', 'pushWithTransientRecovery', 'formatGitError', 'gitSync', 'gitSyncAll'];
const code = source.statements.filter(n => ts.isFunctionDeclaration(n) && names.includes(n.name?.text)).map(n => n.getText(source)).join('\n');
const internalError = 'remote: Internal Server Error\nremote: Request ID FD10:233089:1BE2B5:2818CC:6AC67996\n! [remote rejected] main -> main (Internal Server Error)';
const failure = text => Object.assign(new Error('Command failed: git push --recurse-submodules=no -u origin main\n' + text), { stderr: text });

function fixture({ failures = [], lostResponse = false, remoteOffline = false, verificationFailures = 0 } = {}) {
    const state = { pushes: 0, merges: 0, commits: 0, published: false, dirty: true, commands: [], delays: [], verifications: 0 };
    const context = {
        console: { log() {} },
        setTimeout: (callback, delay) => { state.delays.push(delay); callback(); },
        clearIndexLock() {}, isGitRepo: async () => true,
        removeLegacyRewriteArtifacts: async () => {}, resolveOrAttachHead: async () => 'main',
        recoverInterruptedGitState: async () => {}, hasRemote: async () => true,
        gitCommitLocal: async () => { if (!state.dirty) return false; state.commits++; state.dirty = false; return true; },
        assertNoImportedGitlinks: async () => {},
        syncChangedSubmodules: async () => ({ notes: [], paths: [] }),
        getSyncDirection: async () => ({ ahead: 1, behind: 0, diverged: false }),
        mergeRemoteBranch: async () => { state.merges++; },
        parseMovedRepository: () => undefined, isLfsLockVerificationError: () => false,
        recoverFromWorkflowScope: async () => { throw new Error('Workflow history must not be rewritten'); },
        createGitRunner: () => async command => {
            state.commands.push(command);
            if (command.startsWith('git push')) {
                const error = failures[state.pushes++];
                if (lostResponse) state.published = true;
                if (error) throw failure(error);
                state.published = true;
            }
            return { stdout: '', stderr: '' };
        },
        verifyProjectSync: async () => {
            state.verifications++;
            if (remoteOffline || (state.published && verificationFailures-- > 0)) throw failure('The requested URL returned error: 503');
            return state.published && !state.dirty;
        },
    };
    vm.createContext(context);
    vm.runInContext(ts.transpileModule(code, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText, context);
    return { state, context };
}

(async () => {
    const classify = fixture().context.isTransientGitError;
    assert.equal(classify(internalError, ''), true);
    for (const status of [429, 500, 502, 503, 504]) assert.equal(classify(`The requested URL returned error: ${status}`, ''), true);
    for (const text of ['GH001: file assets/500.png exceeds size limit', 'permission denied', 'pre-receive hook declined', 'protected branch', 'Authentication failed', 'SSL certificate problem', 'remote: rejected change to file 500.txt', 'remote: Request ID ABC500XYZ']) {
        assert.equal(classify(text, ''), false, text);
    }

    // The reported GitHub rejection must retry without merging or force pushing.
    let f = fixture({ failures: Array(4).fill(internalError) });
    assert.match(await f.context.gitSyncAll('fixture'), /verified/);
    assert.equal(f.state.pushes, 5); assert.equal(f.state.merges, 0); assert.equal(f.state.commits, 1);
    assert.deepEqual(f.state.delays, [2000, 4000, 8000, 15000]);
    assert.ok(f.state.commands.every(command => !command.includes('--force')));

    // A server that remains down must not produce a success or drop the commit.
    f = fixture({ failures: Array(6).fill(internalError), remoteOffline: true });
    await assert.rejects(f.context.gitSyncAll('fixture'), /local commits are preserved/);
    assert.equal(f.state.pushes, 6); assert.equal(f.state.merges, 0); assert.equal(f.state.commits, 1);
    assert.equal(f.state.published, false);
    assert.deepEqual(f.state.delays, [2000, 4000, 8000, 15000, 15000]);

    // Lost acknowledgement: a verified update needs no duplicate push.
    f = fixture({ failures: [internalError], lostResponse: true });
    assert.match(await f.context.gitSyncAll('fixture'), /verified/);
    assert.equal(f.state.pushes, 1);
    assert.ok(f.state.commands.includes('git branch --set-upstream-to=origin/main main'));

    // Policy rejections fail immediately, even if their output contains 500.
    for (const error of ['! [remote rejected] main -> main (pre-receive hook declined)', 'Authentication failed', 'GH001: file 500.png exceeds size limit']) {
        f = fixture({ failures: [error] });
        await assert.rejects(f.context.gitSyncAll('fixture'));
        assert.equal(f.state.pushes, 1); assert.equal(f.state.merges, 0);
        assert.deepEqual(f.state.delays, []);
    }
    for (const reason of ['fetch first', 'non-fast-forward']) {
        f = fixture({ failures: [`! [rejected] main -> main (${reason})`] });
        assert.match(await f.context.gitSyncAll('fixture'), /verified/);
        assert.equal(f.state.merges, 1); assert.equal(f.state.pushes, 2);
    }
    f = fixture({ verificationFailures: 2 });
    assert.match(await f.context.gitSyncAll('fixture'), /verified/);
    assert.equal(f.state.pushes, 1); assert.deepEqual(f.state.delays, [2000, 4000]);
    f = fixture({ remoteOffline: true });
    await assert.rejects(f.context.gitSyncAll('fixture'), /503/);
    assert.equal(f.state.pushes, 1);
    console.log('Sync recovery passed: GitHub 500, bounded backoff, preserved commits, lost acknowledgement, policy/auth errors, branch races, verification outages');
})().catch(error => { console.error(error); process.exitCode = 1; });
