const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const cp = require('node:child_process');
const net = require('node:net');
const ts = require('typescript');

const source = ts.transpileModule(fs.readFileSync('src/ports/portManager.ts', 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
}).outputText;

function load(responses) {
    const calls = [];
    const mock = {
        ...cp,
        execFile(file, args, options, callback) {
            calls.push(file);
            if (file === 'netstat.exe') {
                assert.deepEqual(Array.from(args), ['-ano'], 'Scan both IPv4 and IPv6; -p tcp hides IPv6 Vite listeners');
            }
            assert.equal(options.windowsHide, true);
            assert.ok(options.timeout > 0);
            assert.ok(options.maxBuffer >= 8 * 1024 * 1024);
            const response = responses[file];
            if (response instanceof Error) callback(response, '', '');
            else callback(null, response ?? '', '');
        },
    };
    mock.execFile[require('node:util').promisify.custom] = (file, args, options) =>
        new Promise((resolve, reject) => mock.execFile(file, args, options, (error, stdout, stderr) =>
            error ? reject(error) : resolve({ stdout, stderr })));
    const context = {
        exports: {}, process: { platform: 'win32' },
        console: { error() {} },
        require: name => name === 'child_process' ? mock : require(name),
    };
    vm.runInNewContext(source, context);
    return { ...context.exports, calls };
}

(async () => {
    const fixture = [
        '  TCP    127.0.0.1:5175    0.0.0.0:0    LISTENING    123',
        '  TCP    [::1]:5175       [::]:0       ABHÖREN      456',
        '  TCP    [::]:5175        [::]:0       LISTENING    123',
        '  TCP    [::1]:5174       [::]:0       LISTENING    456',
        '  UDP    [::]:5176        *:*          456',
        '  TCP    127.0.0.1:5174    127.0.0.1:5175    ESTABLISHED    999',
        '  TCP    0.0.0.0:8080    0.0.0.0:0    LISTENING    4',
    ].join('\r\n');
    const scanner = load({ 'netstat.exe': fixture, 'tasklist.exe': '"node.exe","123"\r\n"node.exe","456"\r\n"System","4"' });
    const ports = await scanner.getOpenPorts();
    assert.equal(ports.length, 4, 'Keep both owners and system listeners, dedupe only the same PID/port, exclude UDP');
    assert.ok(ports.some(p => p.port === 5174 && p.pid === 456 && p.name === 'node.exe' && p.isDev), 'IPv6-only Vite listener must be visible');
    assert.deepEqual(Array.from(ports.filter(p => p.port === 5175), p => p.pid), [123, 456]);
    assert.ok(ports.filter(p => p.port === 5175).every(p => p.isDev && p.name === 'node.exe'));
    assert.equal((await scanner.getOpenPorts(true)).length, 3, 'Explicit dev filter remains available');

    for (const netstatOutput of [new Error('netstat unavailable'), '', 'unrecognised output']) {
        const fallback = load({
            'netstat.exe': netstatOutput,
            'powershell.exe': '[{"LocalPort":5175,"OwningProcess":123}]',
            'tasklist.exe': new Error('access denied'),
        });
        const found = await fallback.getOpenPorts();
        assert.equal(found[0].port, 5175);
        assert.equal(found[0].pid, 123);
        assert.equal(found[0].isDev, true);
        assert.match(found[0].name, /Unknown/);
        assert.ok(fallback.calls.includes('powershell.exe'));
    }
    const single = load({ 'powershell.exe': '{"LocalPort":5175,"OwningProcess":456}' });
    assert.equal((await single.getOpenPorts())[0].pid, 456);
    const failed = load({ 'netstat.exe': new Error('failed'), 'powershell.exe': new Error('failed') });
    await assert.rejects(failed.getOpenPorts(), /Windows port scan failed/);
    console.log('Port discovery regression checks passed.');

    // Overlapping refreshes share work and cannot overwrite a newer request.
    let scans = 0;
    let finish;
    const providerContext = {
        exports: {},
        require: name => {
            if (name === 'vscode') return {};
            if (name === '../ports/portsHtml') return {};
            if (name === '../ports/portManager') return {
                getOpenPorts: () => { scans++; return new Promise(resolve => { finish = resolve; }); },
            };
            return require(name);
        },
    };
    vm.runInNewContext(ts.transpileModule(fs.readFileSync('src/providers/portsProvider.ts', 'utf8'), {
        compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
    }).outputText + '\nexports.postPortsState = postPortsState;', providerContext);
    const messages = [];
    const webview = { postMessage: async message => messages.push(message) };
    const first = providerContext.exports.postPortsState(webview, false);
    const second = providerContext.exports.postPortsState(webview, false);
    assert.equal(scans, 1);
    finish(ports);
    await Promise.all([first, second]);
    assert.equal(messages.length, 1);
    assert.equal(messages[0].ports, ports);

    // A scan error is reported separately, leaving the client's prior list intact.
    const errorContext = {
        ...providerContext, exports: {},
        require: name => name === '../ports/portManager'
            ? { getOpenPorts: async () => { throw new Error('scan denied'); } }
            : providerContext.require(name),
    };
    vm.runInNewContext(ts.transpileModule(fs.readFileSync('src/providers/portsProvider.ts', 'utf8'), {
        compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
    }).outputText + '\nexports.postPortsState = postPortsState;', errorContext);
    await errorContext.exports.postPortsState(webview, false);
    assert.match(messages[1].error, /scan denied/);
    assert.equal(messages[1].ports, undefined);
    console.log('Port pane concurrency and error reporting checks passed.');

    if (process.argv.includes('--live')) {
        const context = { exports: {}, process, console, require };
        vm.runInNewContext(source, context);
        const servers = [];
        try {
            for (const host of ['127.0.0.1', '::1']) {
                const server = net.createServer();
                servers.push(server);
                await new Promise((resolve, reject) => {
                    server.once('error', reject);
                    server.listen(0, host, resolve);
                });
            }
            const found = await context.exports.getOpenPorts();
            for (const server of servers) {
                const { address, port } = server.address();
                assert.ok(found.some(p => p.port === port && p.pid === process.pid), `Live listener ${address}:${port} must be visible`);
                console.log(`Live Windows listener ${address}:${port}, PID ${process.pid}, discovered successfully.`);
            }
        } finally {
            await Promise.all(servers.map(server => new Promise(resolve => server.close(resolve))));
        }
    }
})().catch(error => { console.error(error); process.exitCode = 1; });
