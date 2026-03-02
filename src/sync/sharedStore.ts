import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { EventEmitter } from 'events';

// ─── Schema ──────────────────────────────────────────────────────────────────

export interface SyncData {
    version: number;
    accounts: SyncAccount[];
    sshKeys: SyncSshKey[];
    projects: SyncProject[];
    profiles: SyncProfile[];
    localAccounts: { workspaceUri: string; accountId: string }[];
}

/** Mirrors GitAccount but tokens are NEVER written to disk — they stay in context.secrets */
export interface SyncAccount {
    id: string;
    provider: string;
    username: string;
    email?: string;
    sshKeyId?: string;
    authMethod?: 'oauth' | 'ssh' | 'pat';
    lastValidatedAt?: number;
    tokenExpiresAt?: number;
    createdAt: number;
}

export interface SyncSshKey {
    id: string;
    name: string;
    publicKey: string;
    privateKeyPath?: string;
    provider: string;
    accountId: string;
    createdAt: number;
}

export interface SyncProject {
    id: string;
    name: string;
    path: string;
    repoUrl?: string;
    gitProfile?: string;
    accountId?: string;
}

export interface SyncProfile {
    id: string;
    name: string;
    userName?: string;
    userEmail?: string;
}

// ─── Constants ────────────────────────────────────────────────────────────────

const SYNC_VERSION = 1;
const STATE_KEY_SYNC_DIR = 'ultraview.sync.directory';
const DEFAULT_SYNC_DIR = path.join(os.homedir(), '.ultraview');
const SYNC_FILE_NAME = 'sync.json';

const EMPTY_DATA: SyncData = {
    version: SYNC_VERSION,
    accounts: [],
    sshKeys: [],
    projects: [],
    profiles: [],
    localAccounts: [],
};

// ─── SharedStore ──────────────────────────────────────────────────────────────

/**
 * A file-backed shared store that all VS Code-family IDEs read from and write to.
 * Located at `~/.ultraview/sync.json` (configurable).
 *
 * - Tokens are explicitly excluded from the JSON; they live in context.secrets.
 * - A fs.watch watcher hot-reloads the file when another IDE writes it.
 * - A simple write-lock (file rename dance) prevents interleaved writes.
 */
export class SharedStore extends EventEmitter {
    private syncDir: string;
    private syncFile: string;
    private watcher?: fs.FSWatcher;
    private data: SyncData = { ...EMPTY_DATA };
    private writing = false;
    private pendingWrite: NodeJS.Timeout | null = null;

    constructor(private context: vscode.ExtensionContext) {
        super();
        this.syncDir = context.globalState.get<string>(STATE_KEY_SYNC_DIR, DEFAULT_SYNC_DIR);
        this.syncFile = path.join(this.syncDir, SYNC_FILE_NAME);
    }

    // ── Public API ────────────────────────────────────────────────────────────

    /** Call once on activation to load data and start watching. */
    async initialize(): Promise<void> {
        await this._ensureDir();
        this._load();
        this._startWatcher();
        // Migrate old globalState data into the file (one-time)
        await this._migrate();
    }

    /** Returns the current in-memory data (safe copy). */
    read(): SyncData {
        return JSON.parse(JSON.stringify(this.data)) as SyncData;
    }

    /** Merge a partial patch into the data and flush to disk. */
    write(patch: Partial<SyncData>): void {
        this.data = { ...this.data, ...patch };
        this._scheduleSave();
    }

    /** Full path to the sync file, for display in UI. */
    get syncFilePath(): string {
        return this.syncFile;
    }

    /** Full path to the sync directory. */
    get syncDirPath(): string {
        return this.syncDir;
    }

    /**
     * Lets the user choose a new sync directory.
     * Copies the existing data to the new location, then switches over.
     */
    async changeSyncDirectory(): Promise<void> {
        const choice = await vscode.window.showQuickPick([
            { label: '📂 Browse for folder', value: 'browse' },
            { label: '🏠 Use default (~/.ultraview)', value: 'default' },
        ], { placeHolder: 'Choose how to set the sync folder' });

        if (!choice) return;

        let chosen: string | undefined;
        if (choice.value === 'default') {
            chosen = DEFAULT_SYNC_DIR;
        } else {
            const uris = await vscode.window.showOpenDialog({
                canSelectFolders: true,
                canSelectFiles: false,
                openLabel: 'Use this folder for Ultraview sync',
                title: 'Select Ultraview Sync Folder',
            });
            if (!uris || !uris[0]) return;
            chosen = uris[0].fsPath;
        }

        if (chosen === this.syncDir) {
            vscode.window.showInformationMessage('Ultraview: Already using that sync folder.');
            return;
        }

        // Migrate data to new location
        const snapshot = this.read();
        this._stopWatcher();
        this.syncDir = chosen;
        this.syncFile = path.join(chosen, SYNC_FILE_NAME);
        await this._ensureDir();

        // If there's already data there, merge (prefer existing file on disk)
        const onDisk = this._readFile();
        if (onDisk) {
            // Merge: disk data wins for existing IDs, our current data fills any gaps
            this.data = this._merge(onDisk, snapshot);
        } else {
            this.data = snapshot;
        }

        this._save();
        await this.context.globalState.update(STATE_KEY_SYNC_DIR, chosen);
        this._startWatcher();
        this.emit('changed');

        vscode.window.showInformationMessage(
            `✅ Ultraview sync folder set to: ${chosen}\n\nAll other IDEs with Ultraview installed should be pointed to the same folder.`
        );
    }

    dispose(): void {
        this._stopWatcher();
        if (this.pendingWrite) clearTimeout(this.pendingWrite);
    }

    // ── Private ───────────────────────────────────────────────────────────────

    private async _ensureDir(): Promise<void> {
        try {
            await fs.promises.mkdir(this.syncDir, { recursive: true });
        } catch { /* already exists or permission error — handled at read time */ }
    }

    private _load(): void {
        const onDisk = this._readFile();
        if (onDisk) {
            this.data = onDisk;
        }
    }

    private _readFile(): SyncData | null {
        try {
            const raw = fs.readFileSync(this.syncFile, 'utf-8');
            const parsed = JSON.parse(raw) as SyncData;
            if (parsed && typeof parsed === 'object' && typeof parsed.version === 'number') {
                return parsed;
            }
        } catch { /* file doesn't exist yet or is corrupt */ }
        return null;
    }

    private _scheduleSave(): void {
        if (this.pendingWrite) clearTimeout(this.pendingWrite);
        this.pendingWrite = setTimeout(() => { this._save(); }, 100);
    }

    private _save(): void {
        if (this.writing) {
            this._scheduleSave();
            return;
        }
        this.writing = true;
        try {
            const json = JSON.stringify(this.data, null, 2);
            // Atomic write: write to temp file then rename
            const tmp = this.syncFile + '.tmp';
            fs.writeFileSync(tmp, json, 'utf-8');
            fs.renameSync(tmp, this.syncFile);
        } catch (err: any) {
            console.warn('[Ultraview SharedStore] Failed to save sync.json:', err?.message);
        } finally {
            this.writing = false;
        }
    }

    private _startWatcher(): void {
        try {
            this.watcher = fs.watch(this.syncDir, (event, filename) => {
                if (filename === SYNC_FILE_NAME && !this.writing) {
                    // Debounce to avoid reading mid-write from another process
                    setTimeout(() => {
                        const fresh = this._readFile();
                        if (fresh) {
                            this.data = fresh;
                            this.emit('changed');
                        }
                    }, 300);
                }
            });
        } catch {
            // If we can't watch (e.g., network drive), that's okay — just no live sync
        }
    }

    private _stopWatcher(): void {
        try { this.watcher?.close(); } catch { /* ignore */ }
        this.watcher = undefined;
    }

    /**
     * Merge two SyncData objects. Items are merged by ID — `a` wins for conflicts.
     */
    private _merge(a: SyncData, b: SyncData): SyncData {
        const mergeById = <T extends { id: string }>(arr1: T[], arr2: T[]): T[] => {
            const map = new Map<string, T>();
            for (const item of arr2) map.set(item.id, item);
            for (const item of arr1) map.set(item.id, item); // a wins
            return Array.from(map.values());
        };
        return {
            version: SYNC_VERSION,
            accounts: mergeById(a.accounts, b.accounts),
            sshKeys: mergeById(a.sshKeys, b.sshKeys),
            projects: mergeById(a.projects, b.projects),
            profiles: mergeById(a.profiles, b.profiles),
            localAccounts: mergeById(
                a.localAccounts.map(l => ({ id: l.workspaceUri, ...l })),
                b.localAccounts.map(l => ({ id: l.workspaceUri, ...l }))
            ).map(({ id: _id, ...rest }) => rest as { workspaceUri: string; accountId: string }),
        };
    }

    /**
     * One-time migration: copy any data already in globalState into the sync file.
     * We read the old keys directly — they are still present until overwritten.
     */
    private async _migrate(): Promise<void> {
        const migrated = this.context.globalState.get<boolean>('ultraview.sync.migrated', false);
        if (migrated) return;

        const oldAccounts = this.context.globalState.get<any[]>('ultraview.git.accounts.v1', []);
        const oldSshKeys = this.context.globalState.get<any[]>('ultraview.git.sshKeys.v1', []);
        const oldProjects = this.context.globalState.get<any[]>('ultraview.git.projects.v1', []);
        const oldProfiles = this.context.globalState.get<any[]>('ultraview.git.profiles.v1', []);
        const oldGlobalAccount = this.context.globalState.get<string | undefined>('ultraview.git.globalAccount');
        const oldLocalAccounts = this.context.globalState.get<any[]>('ultraview.git.localAccounts', []);

        const hasLegacy =
            oldAccounts.length > 0 ||
            oldSshKeys.length > 0 ||
            oldProjects.length > 0 ||
            oldProfiles.length > 0;

        if (hasLegacy) {
            // Strip tokens from accounts before writing to disk
            const safeAccounts: SyncAccount[] = oldAccounts.map((a: any) => {
                const { token: _token, ...safe } = a;
                return safe as SyncAccount;
            });

            const merged = this._merge(
                {
                    version: SYNC_VERSION,
                    accounts: safeAccounts,
                    sshKeys: oldSshKeys,
                    projects: oldProjects,
                    profiles: oldProfiles,
                    localAccounts: oldLocalAccounts,
                },
                this.data
            );
            this.data = merged;
            this._save();

            vscode.window.showInformationMessage(
                `✅ Ultraview: Migrated ${oldAccounts.length} account(s) and ${oldProjects.length} project(s) to shared sync file at ${this.syncFile}`
            );
        }

        await this.context.globalState.update('ultraview.sync.migrated', true);
    }
}
