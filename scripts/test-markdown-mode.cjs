const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const ts = require('typescript');

function load(file, mocks) {
    const source = ts.transpileModule(fs.readFileSync(file, 'utf8'), {
        compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
    }).outputText;
    const context = { exports: {}, require: name => mocks[name] ?? require(name) };
    vm.runInNewContext(source, context);
    return context.exports;
}

const vscode = {
    EventEmitter: class { event = () => {}; },
    Uri: { file: path => ({ fsPath: path }) },
};
const { buildEditorPage } = load('src/markdown/builder.ts', {
    vscode,
    '../settings/markdownSettings': { getMarkdownSettings: () => ({ defaultView: 'split' }) },
    '../webview/shared/buildReactWebviewPage': {
        buildReactWebviewPage: options => JSON.stringify(options.initialState),
    },
});
const writes = [];
const { MarkdownProvider } = load('src/providers/markdownProvider.ts', {
    vscode,
    fs: {
        readFileSync: file => `# ${file}`,
        writeFileSync: (file, content) => writes.push({ file, content }),
        watch: () => ({ close() {} }),
    },
    '../markdown': { buildEditorPage },
});
const storage = new Map();
const ctx = {
    extensionPath: '.',
    globalState: {
        get: key => storage.get(key),
        update: (key, value) => { storage.set(key, value); return Promise.resolve(); },
    },
};

async function open(provider, file) {
    let onMessage;
    let onDispose;
    const messages = [];
    const panel = {
        webview: {
            onDidReceiveMessage: handler => { onMessage = handler; },
            postMessage: message => { messages.push(message); return Promise.resolve(true); },
        },
        onDidDispose: handler => { onDispose = handler; },
    };
    const document = { uri: { fsPath: file }, setContent(content) { this.content = content; } };
    await provider.resolveCustomEditor(document, panel, {});
    return {
        state: JSON.parse(panel.webview.html), messages, document,
        send: message => onMessage(message), dispose: () => onDispose(),
    };
}

(async () => {
    const provider = new MarkdownProvider(ctx);
    const first = await open(provider, 'first.md');
    const existing = await open(provider, 'existing.md');
    assert.equal(first.state.viewMode, undefined, 'Use configured default until a mode is selected');
    assert.equal(first.state.settings.defaultView, 'split');

    for (const mode of ['raw', 'rich', 'split']) {
        first.send({ type: 'setViewMode', viewMode: mode });
        assert.equal(existing.messages.at(-1).viewMode, mode, 'Existing tabs follow the last selection');
        const next = await open(provider, `${mode}.md`);
        assert.equal(next.state.viewMode, mode, 'New files start in the last selected mode');
        assert.equal(next.state.initialContent, `# ${mode}.md`, 'Each file keeps its own content');
        next.dispose();
        const reloaded = await open(new MarkdownProvider(ctx), `reload-${mode}.md`);
        assert.equal(reloaded.state.viewMode, mode, 'Selection survives extension reload');
        reloaded.dispose();
    }

    // A webview starting from older HTML must receive the latest preference when ready.
    const delayed = await open(provider, 'delayed.md');
    first.send({ type: 'setViewMode', viewMode: 'raw' });
    delayed.send({ type: 'ready' });
    assert.equal(delayed.messages.at(-1).viewMode, 'raw');
    first.send({ type: 'setViewMode', viewMode: 'invalid' });
    const next = await open(provider, 'next.md');
    assert.equal(next.state.viewMode, 'raw', 'Reject invalid modes');
    const beforeDispose = existing.messages.length;
    existing.dispose();
    first.send({ type: 'setViewMode', viewMode: 'rich' });
    assert.equal(existing.messages.length, beforeDispose, 'Do not send to disposed editors');
    assert.equal(writes.length, 0, 'Mode changes must not write Markdown files');
    first.send({ type: 'save', content: '# edited' });
    assert.deepEqual(writes, [{ file: 'first.md', content: '# edited' }]);
    assert.equal(first.document.content, '# edited');

    storage.set('markdown.viewMode', 'invalid');
    const invalid = await open(new MarkdownProvider(ctx), 'invalid.md');
    assert.equal(invalid.state.viewMode, undefined, 'Invalid stored modes fall back to the configured default');
    for (const editor of [first, delayed, next, invalid]) editor.dispose();
    console.log('Markdown mode persistence regression checks passed.');
})().catch(error => { console.error(error); process.exitCode = 1; });
