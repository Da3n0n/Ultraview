import * as vscode from 'vscode';
import * as cp from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

const DELETE_RETRY_COUNT = 15;
const WINDOWS_DELETE_RETRY_DELAY_MS = 300;
const WINDOWS_HANDLE_RELEASE_DELAY_MS = 1500;

/**
 * Handles the "Force Delete" command for a file or folder.
 */
export async function forceDelete(uri?: vscode.Uri) {
    const targetUri = uri ?? vscode.window.activeTextEditor?.document?.uri;

    if (!targetUri || targetUri.scheme !== 'file') {
        vscode.window.showErrorMessage('Force Delete only works on local files and folders.');
        return;
    }

    const filePath = path.resolve(targetUri.fsPath);
    if (!fs.existsSync(filePath)) {
        vscode.window.showErrorMessage('The selected file or folder does not exist.');
        return;
    }

    try {
        await releaseKnownVsCodeLocks(filePath);

        // 1. Identify locking processes
        const processes = await getLockingProcesses(filePath);

        if (processes.length > 0) {
            const processInfo = processes.map(p => `${p.name} (PID: ${p.pid})`).join(', ');
            const selection = await vscode.window.showWarningMessage(
                `The following processes are locking "${path.basename(filePath)}": ${processInfo}. Do you want to kill them and delete?`,
                { modal: true },
                'Force Delete'
            );

            if (selection !== 'Force Delete') {
                return;
            }

            // 2. Kill processes
            await killProcesses(processes.map(p => p.pid));

            // Give the OS a moment to release handles
            await delay(WINDOWS_HANDLE_RELEASE_DELAY_MS);
        }

        // 3. Delete the file or folder with retries
        const result = await deletePathWithRetries(filePath);

        if (result === 'scheduled') {
            vscode.window.showInformationMessage(`Force delete queued for "${path.basename(filePath)}". It will be removed as soon as the last lock releases.`);
        } else {
            vscode.window.showInformationMessage(`Successfully force deleted "${path.basename(filePath)}".`);
        }
    } catch (error: any) {
        vscode.window.showErrorMessage(`Failed to force delete: ${error.message}`);
    }
}

async function deletePathWithRetries(originalPath: string): Promise<'deleted' | 'scheduled'> {
    let currentPath = originalPath;
    let movedAside = false;
    let lastError: NodeJS.ErrnoException | Error | null = null;

    for (let attempt = 0; attempt < DELETE_RETRY_COUNT; attempt++) {
        if (!fs.existsSync(currentPath)) {
            return 'deleted';
        }

        try {
            if (attempt === 1) {
                await releaseKnownVsCodeLocks(currentPath);
            }

            if (!movedAside) {
                currentPath = await movePathAsideIfPossible(currentPath);
                movedAside = currentPath !== originalPath;
            }

            clearReadonlyRecursive(currentPath);
            removePath(currentPath);

            if (!fs.existsSync(currentPath)) {
                return 'deleted';
            }
        } catch (error: any) {
            lastError = error;

            if (!isRetryableDeleteError(error)) {
                break;
            }
        }

        await delay(WINDOWS_DELETE_RETRY_DELAY_MS + (attempt * 100));
    }

    if (fs.existsSync(currentPath) && process.platform === 'win32') {
        await deletePathWithPowerShell(currentPath);
        if (!fs.existsSync(currentPath)) {
            return 'deleted';
        }
    }

    if (fs.existsSync(currentPath) && process.platform === 'win32') {
        await scheduleBackgroundDelete(currentPath);
        return 'scheduled';
    }

    if (lastError) {
        throw lastError;
    }

    throw new Error(`Unable to delete "${originalPath}".`);
}

async function movePathAsideIfPossible(targetPath: string): Promise<string> {
    const parentPath = path.dirname(targetPath);
    const baseName = path.basename(targetPath);

    for (let attempt = 0; attempt < 3; attempt++) {
        const candidatePath = path.join(
            parentPath,
            `.ultraview-delete-${baseName}-${process.pid}-${Date.now()}-${attempt}`
        );

        try {
            fs.renameSync(targetPath, candidatePath);
            return candidatePath;
        } catch (error: any) {
            if (!isRetryableDeleteError(error)) {
                return targetPath;
            }

            await delay(75 * (attempt + 1));
        }
    }

    return targetPath;
}

function clearReadonlyRecursive(targetPath: string): void {
    if (!fs.existsSync(targetPath)) {
        return;
    }

    const stats = fs.lstatSync(targetPath);
    safelyChmod(targetPath, stats);

    if (!stats.isDirectory() || stats.isSymbolicLink()) {
        return;
    }

    for (const entry of fs.readdirSync(targetPath)) {
        clearReadonlyRecursive(path.join(targetPath, entry));
    }
}

function safelyChmod(targetPath: string, stats: fs.Stats): void {
    try {
        const mode = stats.isDirectory() ? 0o777 : 0o666;
        fs.chmodSync(targetPath, mode);
    } catch {
        // Best-effort only.
    }
}

function removePath(targetPath: string): void {
    fs.rmSync(targetPath, {
        recursive: true,
        force: true,
        maxRetries: 2,
        retryDelay: 100,
    });
}

function isRetryableDeleteError(error: NodeJS.ErrnoException | undefined): boolean {
    return error?.code === 'EBUSY'
        || error?.code === 'EPERM'
        || error?.code === 'ENOTEMPTY'
        || error?.code === 'EACCES'
        || error?.code === 'EMFILE'
        || error?.code === 'ENFILE';
}

async function deletePathWithPowerShell(targetPath: string): Promise<void> {
    const script = `
$target = '${escapePowerShellString(targetPath)}'
if (-not (Test-Path -LiteralPath $target)) {
    exit 0
}

try {
    Get-ChildItem -LiteralPath $target -Force -Recurse -ErrorAction SilentlyContinue | ForEach-Object {
        try {
            $_.Attributes = 'Normal'
        } catch {}
    }
} catch {}

try {
    $item = Get-Item -LiteralPath $target -Force -ErrorAction Stop
    try {
        $item.Attributes = 'Normal'
    } catch {}
    Remove-Item -LiteralPath $target -Recurse -Force -ErrorAction Stop
} catch {
    Write-Error $_
    exit 1
}
`;

    await new Promise<void>((resolve, reject) => {
        cp.execFile(
            'powershell',
            ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
            (error, _stdout, stderr) => {
                if (error) {
                    reject(new Error(stderr.trim() || error.message));
                    return;
                }

                resolve();
            }
        );
    });
}

async function scheduleBackgroundDelete(targetPath: string): Promise<void> {
    const script = `
$target = '${escapePowerShellString(targetPath)}'
for ($attempt = 0; $attempt -lt 600; $attempt++) {
    if (-not (Test-Path -LiteralPath $target)) {
        exit 0
    }

    try {
        Get-ChildItem -LiteralPath $target -Force -Recurse -ErrorAction SilentlyContinue | ForEach-Object {
            try {
                $_.Attributes = 'Normal'
            } catch {}
        }
    } catch {}

    try {
        $item = Get-Item -LiteralPath $target -Force -ErrorAction Stop
        try {
            $item.Attributes = 'Normal'
        } catch {}
        Remove-Item -LiteralPath $target -Recurse -Force -ErrorAction Stop
    } catch {}

    Start-Sleep -Milliseconds 1000
}
exit 1
`;

    await new Promise<void>((resolve, reject) => {
        const child = cp.spawn(
            'powershell',
            ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden', '-Command', script],
            {
                detached: true,
                stdio: 'ignore',
            }
        );

        child.once('error', (error) => {
            reject(error);
        });

        child.unref();
        resolve();
    });
}

async function releaseKnownVsCodeLocks(targetPath: string): Promise<void> {
    await closeTabsForTarget(targetPath);
    removeMatchingWorkspaceFolders(targetPath);

    if (isDirectoryPath(targetPath)) {
        for (const terminal of vscode.window.terminals) {
            try {
                terminal.dispose();
            } catch {
                // Best-effort only.
            }
        }
    }

    await delay(250);
}

async function closeTabsForTarget(targetPath: string): Promise<void> {
    const tabsToClose = vscode.window.tabGroups.all
        .flatMap(group => group.tabs)
        .filter(tab => !tab.isDirty)
        .filter(tab => isTabInsideTarget(tab, targetPath));

    if (tabsToClose.length > 0) {
        await vscode.window.tabGroups.close(tabsToClose, true);
    }
}

function isTabInsideTarget(tab: vscode.Tab, targetPath: string): boolean {
    const input = tab.input;

    if (input instanceof vscode.TabInputText || input instanceof vscode.TabInputCustom || input instanceof vscode.TabInputNotebook) {
        return isPathInsideTarget(input.uri.fsPath, targetPath);
    }

    if (input instanceof vscode.TabInputTextDiff || input instanceof vscode.TabInputNotebookDiff) {
        return isPathInsideTarget(input.original.fsPath, targetPath)
            || isPathInsideTarget(input.modified.fsPath, targetPath);
    }

    return false;
}

function removeMatchingWorkspaceFolders(targetPath: string): void {
    const workspaceFolders = vscode.workspace.workspaceFolders ?? [];
    const indexesToRemove = workspaceFolders
        .map((folder, index) => ({ folder, index }))
        .filter(({ folder }) => isPathInsideTarget(folder.uri.fsPath, targetPath));

    for (const { index } of indexesToRemove.sort((left, right) => right.index - left.index)) {
        vscode.workspace.updateWorkspaceFolders(index, 1);
    }
}

function isDirectoryPath(targetPath: string): boolean {
    try {
        return fs.lstatSync(targetPath).isDirectory();
    } catch {
        return false;
    }
}

function isPathInsideTarget(candidatePath: string, targetPath: string): boolean {
    const normalizedCandidate = path.resolve(candidatePath);
    const normalizedTarget = path.resolve(targetPath);
    const relative = path.relative(normalizedTarget, normalizedCandidate);

    return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function escapePowerShellString(value: string): string {
    return value.replace(/'/g, "''");
}

function delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
}

interface ProcessInfo {
    pid: number;
    name: string;
}

/**
 * Uses the appropriate tool based on platform to identify processes locking a file or folder.
 */
async function getLockingProcesses(targetPath: string): Promise<ProcessInfo[]> {
    const platform = process.platform;

    if (platform === 'win32') {
        return getLockingProcessesWindows(targetPath);
    } else {
        return getLockingProcessesUnix(targetPath);
    }
}

/**
 * Windows implementation using PowerShell and Restart Manager API.
 */
async function getLockingProcessesWindows(targetPath: string): Promise<ProcessInfo[]> {
    return new Promise((resolve) => {
        const script = `
$path = "${targetPath.replace(/"/g, '`"')}"
$signature = @'
[DllImport("rstrtmgr.dll", CharSet = CharSet.Unicode)]
public static extern int RmStartSession(out uint pSessionHandle, uint dwSessionFlags, string strSessionKey);
[DllImport("rstrtmgr.dll")]
public static extern int RmEndSession(uint dwSessionHandle);
[DllImport("rstrtmgr.dll", CharSet = CharSet.Unicode)]
public static extern int RmRegisterResources(uint dwSessionHandle, uint nFiles, string[] rgsFilenames, uint nApplications, uint rgApplications, uint nServices, string[] rgsServiceNames);
[DllImport("rstrtmgr.dll")]
public static extern int RmGetList(uint dwSessionHandle, out uint pnProcInfoNeeded, ref uint pnProcInfo, [In, Out] RM_PROCESS_INFO[] rgAffectedApps, out uint lpdwRebootReasons);

[StructLayout(LayoutKind.Sequential)]
public struct RM_UNIQUE_PROCESS {
    public int dwProcessId;
    public System.Runtime.InteropServices.ComTypes.FILETIME ProcessStartTime;
}

[StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
public struct RM_PROCESS_INFO {
    public RM_UNIQUE_PROCESS Process;
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 256)]
    public string strAppName;
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 64)]
    public string strServiceShortName;
    public int ApplicationType;
    public uint AppStatus;
    public uint TSSessionId;
    [MarshalAs(UnmanagedType.Bool)]
    public bool bRestartable;
}
'@

Add-Type -TypeDefinition $signature -Namespace RestartManager -Name NativeMethods

$results = @()
$sessionHandle = 0
$sessionKey = [Guid]::NewGuid().ToString()
$res = [RestartManager.NativeMethods]::RmStartSession([ref]$sessionHandle, 0, $sessionKey)

if ($res -eq 0) {
    try {
        $res = [RestartManager.NativeMethods]::RmRegisterResources($sessionHandle, 1, @($path), 0, 0, 0, $null)
        if ($res -eq 0) {
            $pnProcInfoNeeded = 0
            $pnProcInfo = 0
            $lpdwRebootReasons = 0
            $res = [RestartManager.NativeMethods]::RmGetList($sessionHandle, [ref]$pnProcInfoNeeded, [ref]$pnProcInfo, $null, [ref]$lpdwRebootReasons)
            
            if ($res -eq 234) { # ERROR_MORE_DATA
                $pnProcInfo = $pnProcInfoNeeded
                $rgAffectedApps = New-Object RestartManager.NativeMethods+RM_PROCESS_INFO[] $pnProcInfo
                $res = [RestartManager.NativeMethods]::RmGetList($sessionHandle, [ref]$pnProcInfoNeeded, [ref]$pnProcInfo, $rgAffectedApps, [ref]$lpdwRebootReasons)
                if ($res -eq 0) {
                    $results += $rgAffectedApps | Select-Object @{Name='pid'; Expression={$_.Process.dwProcessId}}, @{Name='name'; Expression={$_.strAppName}}
                }
            }
        }
    } finally {
        [RestartManager.NativeMethods]::RmEndSession($sessionHandle) | Out-Null
    }
}

# Backup: Check for processes running from this folder or mentioning it (common for node/powershell etc)
$pathEscaped = [regex]::Escape($path)
$cimProcesses = Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -match $pathEscaped -or ($_.ExecutablePath -and $_.ExecutablePath -like "*$path*") }
foreach ($p in $cimProcesses) {
    if ($null -eq ($results | Where-Object { $_.pid -eq $p.ProcessId })) {
        $results += [PSCustomObject]@{ pid = $p.ProcessId; name = $p.Name }
    }
}

$results | ConvertTo-Json
`;

        cp.exec(`powershell -NoProfile -Command & {${script}}`, (error, stdout, stderr) => {
            if (error) {
                console.error(`PS Error: ${stderr}`);
                resolve([]);
                return;
            }
            try {
                const output = stdout.trim();
                if (!output || output === "[]") {
                    resolve([]);
                } else {
                    const parsed = JSON.parse(output);
                    resolve(Array.isArray(parsed) ? parsed : [parsed]);
                }
            } catch (e) {
                console.error(`Parse Error: ${e}`);
                resolve([]);
            }
        });
    });
}

/**
 * macOS/Linux implementation using lsof.
 */
async function getLockingProcessesUnix(targetPath: string): Promise<ProcessInfo[]> {
    return new Promise((resolve) => {
        // Use +D for directory (recursive) or just path for file
        const isDir = fs.lstatSync(targetPath).isDirectory();
        const cmd = `lsof -F pc ${isDir ? '+D' : ''} "${targetPath}"`;

        cp.exec(cmd, (error, stdout) => {
            if (error && error.code !== 1) { // lsof returns 1 if no files are open
                console.error(`lsof Error: ${error.message}`);
                resolve([]);
                return;
            }

            const processes: ProcessInfo[] = [];
            const lines = stdout.split('\n');
            let currentPid: number | null = null;

            for (const line of lines) {
                if (line.startsWith('p')) {
                    currentPid = parseInt(line.substring(1));
                } else if (line.startsWith('c') && currentPid !== null) {
                    processes.push({
                        pid: currentPid,
                        name: line.substring(1)
                    });
                    currentPid = null;
                }
            }

            // De-duplicate by PID
            const unique = Array.from(new Map(processes.map(p => [p.pid, p])).values());
            resolve(unique);
        });
    });
}

/**
 * Kills processes by their PIDs.
 */
async function killProcesses(pids: number[]): Promise<void> {
    const uniquePids = [...new Set(pids)];
    const isWindows = process.platform === 'win32';

    for (const pid of uniquePids) {
        try {
            if (pid === process.pid) {
                continue;
            }

            if (isWindows) {
                cp.execSync(`taskkill /T /F /PID ${pid}`, { stdio: 'ignore' });
            } else {
                cp.execSync(`kill -9 ${pid}`, { stdio: 'ignore' });
            }
            // Give OS time to release handles
            await new Promise(resolve => setTimeout(resolve, 200));
        } catch (e) {
            // Process may have already exited
            console.error(`Failed to kill process ${pid}: ${e}`);
        }
    }
}
