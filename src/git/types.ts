export interface GitProject {
  id: string;
  name: string;
  path: string;
  repoUrl?: string;
  gitProfile?: string; // profile id used for commits
  accountId?: string;  // bound git account id
  lastOpened?: number; // timestamp of most recent open
}

export interface GitProfile {
  id: string;
  name: string;
  userName?: string;
  userEmail?: string;
}

export type GitProvider = 'github' | 'gitlab' | 'azure';
export type AuthMethod = 'oauth' | 'ssh' | 'pat';

export interface GitAccount {
  id: string;
  provider: GitProvider;
  username: string;
  email?: string;
  providerUserId?: number; // Numeric user ID from GitHub/GitLab (needed for noreply email)
  token?: string; // HTTPS token (encrypted in storage)
  sshKeyId?: string; // Reference to SSH key
  authMethod?: AuthMethod;
  lastValidatedAt?: number;
  tokenExpiresAt?: number;
  createdAt: number;
}

export interface SshKey {
  id: string;
  name: string;
  publicKey: string;
  privateKeyPath?: string;
  provider: GitProvider;
  accountId: string;
  createdAt: number;
}
