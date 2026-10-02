import type { AuthMethod, GitAccount, GitProject } from '../git/types';

export interface GitStatusState {
  isGitRepo: boolean;
  localChanges: number;
  ahead: number;
  behind: number;
  branch: string;
  branchWorkBase?: string;
  unmergedBranches?: number;
}

export interface GitAccountState extends GitAccount {
  authStatus?: 'valid' | 'warning' | 'expired';
  authMethod?: AuthMethod;
}

export interface GitPanelStateMessage {
  type: 'state';
  projects: GitProject[];
  activeRepo: string;
  activeRepoName: string;
  accounts: GitAccountState[];
  activeAccountId: string | null;
  activeProjectId: string | null;
  gitStatuses: Record<string, GitStatusState>;
  onlyProjectId?: string;
}

export type GitPanelInboundMessage =
  | GitPanelStateMessage
  | { type: 'gitOpDone'; projectId: string }
  | { type: 'projectAdded' | 'projectRemoved' | 'accountAdded' | 'accountRemoved' | 'accountUpdated' | 'sshKeyGenerated' };

export type GitPanelOutboundMessage =
  | { type: 'ready' | 'refresh' | 'refreshProjects' | 'addProject' | 'addCurrentProject' | 'addRepo' | 'addAccount' | 'openPanel' }
  | { type: 'open' | 'delete' | 'gitPull' | 'gitPush' | 'gitSync' | 'gitBranch' | 'gitMerge' | 'gitMergeSync' | 'gitBranchWork' | 'projectCommands' | 'refreshSingleProject'; id: string }
  | { type: 'switchAccount' | 'authOptions' | 'removeAccount' | 'reAuthAccount'; accountId: string };
