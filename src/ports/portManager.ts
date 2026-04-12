import * as cp from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(cp.exec);

export interface PortProcess {
    port: number;
    pid: number;
    name: string;
    isDev?: boolean;
}

const COMMON_DEV_PORTS = new Set([
    3000, 3001, 3002, 3003, 3004, 3005,
    4173, 4174, 4175,
    4200, 4201, 4202,
    5000, 5001, 5002,
    5173, 5174, 5175, 5176, 5177, 5178, 5179, 5180,
    5500,
    8000, 8001, 8002, 8003,
    8080, 8081, 8082, 8088,
    8888,
    9000, 9001,
]);

const NOISE_PROCESS_PATTERNS = [
    'svchost',
    'system',
    'idle',
    'services',
    'registry',
    'lsass',
    'wininit',
    'csrss',
    'smss',
    'fontdrvhost',
    'dwm',
];

const DEV_SERVER_PATTERNS = [
    'node', 'npm', 'yarn', 'pnpm', 'bun',
    'python', 'python2', 'python3', 'pip',
    'ruby', 'rails', 'rake',
    'java', 'javac', 'gradle', 'maven',
    'go', 'godoc', 'go-run',
    'php', 'artisan', 'composer',
    'rustc', 'cargo', 'cargo-run',
    'vite', 'webpack', 'rollup', 'esbuild',
    'next', 'nuxt', 'remix', 'gatsby',
    'django', 'flask', 'fastapi', 'uvicorn',
    'spring-boot', 'tomcat', 'jetty',
    'hugo', 'jekyll', 'middleman',
    'deno', 'deno-run',
    'podman', 'docker', 'containerd',
    'postgres', 'mysql', 'mongod', 'redis',
    'elasticsearch', 'kibana', 'logstash',
    'rabbitmq', 'activemq', 'kafka',
    'jenkins', 'travis', 'circleci',
    'live-server', 'http-server', 'serve',
    'parcel', 'snowpack', 'wmr',
    'astro', 'svelte-kit', 'svelte-dev',
    'mint', 'elixir', 'mix', 'phoenix',
    'dotnet', 'fsharp', 'mono',
    'lua', 'luajit', 'torch', 'th',
    'julia', 'jupyter',
];

const DEV_PORT_RANGES: [number, number][] = [
    [3000, 3999],
    [5000, 5999],
    [5173, 5180],
    [5174, 5180],
    [5175, 5180],
    [5176, 5180],
    [5177, 5180],
    [5178, 5180],
    [5179, 5180],
    [5180, 5180],
    [5170, 5200],
    [5171, 5200],
    [8000, 8999],
    [8888, 8899],
    [30001, 30100],
    [4000, 4999],
    [7000, 7999],
    [9000, 9999],
    [10000, 10999],
    [4200, 4299],
    [8080, 8999],
];

function isDevServerProcess(name: string): boolean {
    const lower = name.toLowerCase();
    if (lower.includes('code') || lower.includes('vscode')) return false;
    if (lower.includes('electron') || lower.includes('shell')) return false;
    for (const pattern of DEV_SERVER_PATTERNS) {
        if (lower === pattern || lower.startsWith(pattern + ' ') || lower.includes('-' + pattern) || lower.includes('_' + pattern)) {
            return true;
        }
    }
    return false;
}

function isNoiseProcess(name: string): boolean {
    const lower = name.toLowerCase().replace(/\.exe$/i, '');
    return NOISE_PROCESS_PATTERNS.some((pattern) => lower === pattern || lower.startsWith(pattern));
}

function isDevPort(port: number): boolean {
    if (COMMON_DEV_PORTS.has(port)) return true;
    for (const [start, end] of DEV_PORT_RANGES) {
        if (port >= start && port <= end) return true;
    }
    return false;
}

function isRelevantPortProcess(portProcess: PortProcess): boolean {
    if (isNoiseProcess(portProcess.name)) {
        return false;
    }
    return isDevServerProcess(portProcess.name) || isDevPort(portProcess.port);
}

export async function getOpenPorts(devOnly: boolean = false): Promise<PortProcess[]> {
    const platform = process.platform;
    try {
        let ports: PortProcess[];
        if (platform === 'win32') {
            ports = await getPortsWin32();
        } else if (platform === 'darwin') {
            ports = await getPortsDarwin();
        } else {
            ports = await getPortsLinux();
        }
        for (const p of ports) {
            p.isDev = isDevServerProcess(p.name) || isDevPort(p.port);
        }
        ports = ports.filter((p) => !isNoiseProcess(p.name));
        if (devOnly) {
            return ports.filter((p) => isRelevantPortProcess(p));
        }
        return ports;
    } catch (err) {
        console.error('Failed to get ports', err);
        return [];
    }
}

async function getPortsWin32(): Promise<PortProcess[]> {
    const { stdout } = await execAsync('netstat -ano -p tcp');
    const lines = stdout.split('\n');
    const results: PortProcess[] = [];
    for (const line of lines) {
        if (line.includes('LISTENING')) {
            const parts = line.trim().split(/\s+/);
            if (parts.length >= 5) {
                const portPart = parts[1].split(':').pop();
                const pidPart = parts[4];
                if (portPart && pidPart) {
                    const port = parseInt(portPart, 10);
                    const pid = parseInt(pidPart, 10);
                    if (!isNaN(port) && !isNaN(pid) && port > 0) {
                        results.push({ name: 'Unknown (Windows)', port, pid });
                    }
                }
            }
        }
    }

    const deduped = dedupe(results);
    const pidNameMap = await getWindowsPidNameMap();
    for (const res of deduped) {
        const resolvedName = pidNameMap.get(res.pid);
        if (resolvedName) {
            res.name = resolvedName;
        }
    }
    return deduped;
}

async function getWindowsPidNameMap(): Promise<Map<number, string>> {
    try {
        const { stdout } = await execAsync('tasklist /fo csv /nh');
        const lines = stdout.split(/\r?\n/).filter(Boolean);
        const map = new Map<number, string>();

        for (const line of lines) {
            const match = line.match(/^"([^"]+)","(\d+)"/);
            if (!match) continue;
            const [, name, pidText] = match;
            const pid = parseInt(pidText, 10);
            if (!Number.isNaN(pid) && name) {
                map.set(pid, name);
            }
        }

        return map;
    } catch {
        return new Map<number, string>();
    }
}

async function getPortsDarwin(): Promise<PortProcess[]> {
    const { stdout } = await execAsync('lsof -iTCP -sTCP:LISTEN -P -n');
    const lines = stdout.split('\n').slice(1);
    const results: PortProcess[] = [];
    for (const line of lines) {
        const parts = line.trim().split(/\s+/);
        if (parts.length >= 9) {
            const name = parts[0];
            const pid = parseInt(parts[1], 10);
            const portPart = parts[8].split(':').pop();
            if (portPart && !isNaN(pid)) {
                const port = parseInt(portPart, 10);
                if (!isNaN(port) && port > 0) {
                    results.push({ name, pid, port });
                }
            }
        }
    }
    const deduped = dedupe(results);
    for (const res of deduped) {
        try {
            const { stdout: psOut } = await execAsync(`ps -p ${res.pid} -o comm=`);
            const args = psOut.trim();
            if (args) {
                res.name = args;
            }
        } catch (e) {
            // ignore
        }
    }
    return deduped;
}

async function getPortsLinux(): Promise<PortProcess[]> {
    const outputs: PortProcess[] = [];
    try {
        const { stdout } = await execAsync('ss -tulnp');
        const lines = stdout.split('\n').slice(1);
        for (const line of lines) {
            if (line.includes('LISTEN')) {
                const parts = line.trim().split(/\s+/);
                if (parts.length >= 5) {
                    let localAddr = parts[3];
                    if (!localAddr.includes(':')) {
                        localAddr = parts[4];
                    }
                    const addrParts = localAddr?.match(/:(\d+)$/);
                    let port: number | undefined = undefined;
                    if (addrParts && addrParts[1]) {
                        port = parseInt(addrParts[1], 10);
                    }

                    let pid: number | undefined;
                    let name = 'Unknown';
                    const match = line.match(/users:\(\("([^"]+)",pid=(\d+)/);
                    if (match) {
                        name = match[1];
                        pid = parseInt(match[2], 10);
                    } else {
                        const match2 = line.match(/pid=(\d+)/);
                        if (match2) {
                            pid = parseInt(match2[1], 10);
                        }
                    }

                    if (port && !isNaN(port) && pid && !isNaN(pid)) {
                        outputs.push({ port, pid, name });
                    }
                }
            }
        }
    } catch (e) {
        // maybe missing
    }

    if (outputs.length === 0) {
        try {
            const { stdout } = await execAsync('netstat -tulpn');
            const lines = stdout.split('\n').slice(2);
            for (const line of lines) {
                if (line.includes('LISTEN')) {
                    const parts = line.trim().split(/\s+/);
                    if (parts.length >= 7) {
                        const localAddr = parts[3];
                        const pidProg = parts[6]; // PID/Program name
                        const addrParts = localAddr?.match(/:(\d+)$/);
                        if (addrParts && addrParts[1] && pidProg && pidProg !== '-') {
                            const port = parseInt(addrParts[1], 10);
                            const [pidStr, ...nameParts] = pidProg.split('/');
                            const pid = parseInt(pidStr, 10);
                            const name = nameParts.join('/') || 'Unknown';
                            if (!isNaN(port) && !isNaN(pid)) {
                                outputs.push({ port, pid, name });
                            }
                        }
                    }
                }
            }
        } catch (e) { }
    }

    if (outputs.length === 0) {
        try {
            const { stdout } = await execAsync('lsof -iTCP -sTCP:LISTEN -P -n');
            const lines = stdout.split('\n').slice(1);
            for (const line of lines) {
                const parts = line.trim().split(/\s+/);
                if (parts.length >= 9) {
                    const name = parts[0];
                    const pid = parseInt(parts[1], 10);
                    const portPart = parts[8].split(':').pop();
                    if (portPart && !isNaN(pid)) {
                        const port = parseInt(portPart, 10);
                        if (!isNaN(port) && port > 0) {
                            outputs.push({ name, pid, port });
                        }
                    }
                }
            }
        } catch (e) { }
    }

    const deduped = dedupe(outputs);
    for (const res of deduped) {
        if (res.name === 'Unknown' || res.name.length <= 1 || res.name.includes('...')) {
            try {
                const { stdout: psOut } = await execAsync(`ps -p ${res.pid} -o comm=`);
                const args = psOut.trim();
                if (args) {
                    res.name = args;
                }
            } catch (e) { }
        }
    }
    return deduped;
}

function dedupe(arr: PortProcess[]) {
    const map = new Map<number, PortProcess>();
    for (const item of arr) {
        if (item.port && !map.has(item.port)) {
            map.set(item.port, item);
        }
    }
    return Array.from(map.values()).sort((a, b) => a.port - b.port);
}

export async function killProcess(pid: number): Promise<void> {
    const platform = process.platform;
    if (platform === 'win32') {
        await execAsync(`taskkill /F /PID ${pid}`);
    } else {
        try {
            await execAsync(`kill -15 ${pid}`);
        } catch (e) {
            await execAsync(`kill -9 ${pid}`);
        }
    }
}

export async function killProcesses(pids: number[]): Promise<void> {
    for (const pid of pids) {
        try {
            await killProcess(pid);
        } catch (e) {
            // continue with other processes
        }
    }
}
