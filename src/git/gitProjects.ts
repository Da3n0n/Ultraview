import * as vscode from 'vscode';
import { GitProject, GitProfile } from './types';
import { SharedStore } from '../sync/sharedStore';

function simpleUuid(): string {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
    const r = (Math.random() * 16) | 0;
    const v = c === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

export class GitProjects {
  constructor(
    private context: vscode.ExtensionContext,
    private store: SharedStore
  ) { }

  // ── Projects ─────────────────────────────────────────────────────────────

  listProjects(): GitProject[] {
    return this.store.read().projects as GitProject[];
  }

  saveProjects(list: GitProject[]) {
    this.store.write({ projects: list });
  }

  addProject(p: Partial<GitProject>): GitProject {
    const projects = this.store.read().projects as GitProject[];

    // Prevent duplicate entries for the same path
    if (p.path) {
      const existingIdx = projects.findIndex(existing => existing.path === p.path);
      if (existingIdx >= 0) {
        projects[existingIdx] = { ...projects[existingIdx], ...p };
        this.store.write({ projects });
        return projects[existingIdx];
      }
    }

    const proj: GitProject = {
      id: p.id || simpleUuid(),
      name: p.name || 'New Project',
      path: p.path || '',
      repoUrl: p.repoUrl,
      gitProfile: p.gitProfile,
    };
    projects.push(proj);
    this.store.write({ projects });
    return proj;
  }

  updateProject(id: string, patch: Partial<GitProject>) {
    const projects = this.store.read().projects as GitProject[];
    const idx = projects.findIndex(p => p.id === id);
    if (idx >= 0) {
      projects[idx] = { ...projects[idx], ...patch };
      this.store.write({ projects });
    }
  }

  removeProject(id: string) {
    const projects = (this.store.read().projects as GitProject[]).filter(p => p.id !== id);
    this.store.write({ projects });
  }

  // ── Profiles ─────────────────────────────────────────────────────────────

  listProfiles(): GitProfile[] {
    return this.store.read().profiles as GitProfile[];
  }

  saveProfiles(list: GitProfile[]) {
    this.store.write({ profiles: list });
  }

  addProfile(p: Partial<GitProfile>): GitProfile {
    const profiles = this.store.read().profiles as GitProfile[];
    const prof: GitProfile = {
      id: p.id || simpleUuid(),
      name: p.name || 'profile',
      userName: p.userName,
      userEmail: p.userEmail,
    };
    profiles.push(prof);
    this.store.write({ profiles });
    return prof;
  }

  setProjectProfile(projectId: string, profileId?: string) {
    this.updateProject(projectId, { gitProfile: profileId });
  }

  setProjectAccount(projectId: string, accountId?: string) {
    this.updateProject(projectId, { accountId });
  }

  getProjectAccount(projectId: string): string | undefined {
    const projects = this.store.read().projects as GitProject[];
    const proj = projects.find(p => p.id === projectId);
    return proj?.accountId;
  }

  getProjectByPath(projectPath: string): GitProject | undefined {
    const projects = this.store.read().projects as GitProject[];
    return projects.find(p => p.path === projectPath);
  }
}
