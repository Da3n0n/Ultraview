import * as vscode from 'vscode';
import { SharedStore, SyncDrawing } from '../sync/sharedStore';

function simpleUuid(): string {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
    const r = (Math.random() * 16) | 0;
    const v = c === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

export class DrawingManager {
  constructor(
    private context: vscode.ExtensionContext,
    private store: SharedStore
  ) {}

  // ── List drawings ─────────────────────────────────────────────────────────────

  /** Returns all global drawings (no projectId) */
  listGlobalDrawings(): SyncDrawing[] {
    const drawings = this.store.read().drawings ?? [];
    return drawings.filter(d => !d.projectId);
  }

  /** Returns all drawings for a specific project */
  listProjectDrawings(projectId: string): SyncDrawing[] {
    const drawings = this.store.read().drawings ?? [];
    return drawings.filter(d => d.projectId === projectId);
  }

  /** Returns all drawings for the active workspace */
  listActiveWorkspaceDrawings(): SyncDrawing[] {
    const wsPath = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? '';
    const projects = this.store.read().projects ?? [];
    const projectId = projects.find((p: { path: string }) => p.path === wsPath)?.id;
    if (!projectId) return [];
    return this.listProjectDrawings(projectId);
  }

  /** Returns all drawings visible in sidebar (global + active project) */
  listSidebarDrawings(): SyncDrawing[] {
    const wsPath = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? '';
    const projects = this.store.read().projects ?? [];
    const projectId = projects.find((p: { path: string }) => p.path === wsPath)?.id;
    const drawings = this.store.read().drawings ?? [];
    return drawings.filter(d => !d.projectId || d.projectId === projectId);
  }

  // ── CRUD ───────────────────────────────────────────────────────────────────────

  createDrawing(name: string, projectId?: string): SyncDrawing {
    const drawings = this.store.read().drawings ?? [];
    const drawing: SyncDrawing = {
      id: simpleUuid(),
      name,
      projectId,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      tldrawContent: undefined,
    };
    drawings.push(drawing);
    this.store.write({ drawings });
    return drawing;
  }

  getDrawing(id: string): SyncDrawing | undefined {
    const drawings = this.store.read().drawings ?? [];
    return drawings.find(d => d.id === id);
  }

  updateDrawing(id: string, patch: Partial<Omit<SyncDrawing, 'id' | 'createdAt'>>): void {
    const drawings = this.store.read().drawings ?? [];
    const idx = drawings.findIndex(d => d.id === id);
    if (idx >= 0) {
      drawings[idx] = { ...drawings[idx], ...patch, updatedAt: Date.now() };
      this.store.write({ drawings });
    }
  }

  saveDrawingContent(id: string, tldrawContent: string): void {
    this.updateDrawing(id, { tldrawContent });
  }

  deleteDrawing(id: string): void {
    const drawings = (this.store.read().drawings as SyncDrawing[]).filter(d => d.id !== id);
    this.store.write({ drawings });
  }

  renameDrawing(id: string, name: string): void {
    this.updateDrawing(id, { name });
  }

  moveDrawingToProject(id: string, projectId: string | undefined): void {
    this.updateDrawing(id, { projectId });
  }

  // ── Helpers ───────────────────────────────────────────────────────────────────

  getProjectIdForPath(projectPath: string): string | undefined {
    const projects = this.store.read().projects;
    return projects.find((p: { path: string }) => p.path === projectPath)?.id;
  }

  getOrCreateProjectId(): string | undefined {
    const wsPath = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!wsPath) return undefined;
    const existing = this.getProjectIdForPath(wsPath);
    if (existing) return existing;
    // Create a transient project entry just for drawing association
    const projects = this.store.read().projects as Array<{ id: string; path: string; name: string }>;
    const id = simpleUuid();
    const name = wsPath.split(/[/\\]/).pop() ?? 'Workspace';
    projects.push({ id, path: wsPath, name });
    this.store.write({ projects });
    return id;
  }
}
