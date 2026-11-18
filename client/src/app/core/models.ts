// Shapes returned by the SvnAdmin API (camelCase JSON).

export interface Me {
  username: string;
  fullName: string;
  email: string;
  /** Can use admin pages right now (in the admin group and, if required, signed in with MFA). */
  isAdmin: boolean;
  inAdminGroup: boolean;
  /** Admin who must set up an authenticator app or passkey before using admin pages. */
  needsMfaSetup: boolean;
  hasMfa: boolean;
  adminGroup: string;
  publicUrl: string;
  minPasswordLength: number;
  emailEnabled: boolean;
}

export type LoginResult =
  | { status: 'ok'; me: Me; recoveryCodesLeft?: number | null }
  | { status: 'mfa'; totp: boolean; passkey: boolean };

export interface PasskeyInfo {
  id: number;
  name: string;
  createdAt: string;
  lastUsedAt: string | null;
  transports: string;
}

export interface MyAccount {
  username: string;
  fullName: string;
  email: string;
  passwordChangedAt: string | null;
  lastLoginAt: string | null;
  groups: string[];
  hasTotp: boolean;
  recoveryCodesLeft: number;
  passkeys: PasskeyInfo[];
  access: { repo: string | null; path: string; access: Access; via: string; url: string }[];
}

export interface AccessMatrix {
  path: string;
  repos: string[];
  rows: { username: string; fullName: string; isEnabled: boolean; groups: string[]; repos: Record<string, { access: Access; varies: boolean; via: string }> }[];
}

export interface InactiveReport {
  days: number;
  lastScanUtc: string | null;
  users: { username: string; fullName: string; email: string; createdAt: string; lastLoginAt: string | null; lastCommitAt: string | null; lastRepo: string | null; commits: number; isNew: boolean; groups: string[] }[];
}

export interface SvnLock {
  repo: string;
  path: string;
  owner: string;
  createdAt: string | null;
  expires: string;
  comment: string;
}

export interface ImportRow {
  line: number;
  username: string;
  fullName: string;
  email: string;
  groups: string[];
  status: string;
  password: string | null;
}

export interface EmailStatus {
  configured: boolean;
  enabled: boolean;
  host: string;
  port: number;
  username: string;
  passwordSet: boolean;
  fromAddress: string;
  fromName: string;
  savedInApp: boolean;
  usesPickupFolder: boolean;
  appUrl: string;
  passkeyRpId: string;
  requireAdminMfa: boolean;
}

/** password: null keeps the saved one, '' clears it. */
export interface EmailSettingsForm {
  enabled: boolean;
  host: string;
  port: number;
  username: string;
  password: string | null;
  fromAddress: string;
  fromName: string;
  testTo?: string | null;
}

export interface User {
  username: string;
  fullName: string;
  email: string;
  notes: string;
  isEnabled: boolean;
  isAdmin: boolean;
  groups: string[];
  passwordChangedAt: string | null;
  passwordAgeDays: number | null;
  passwordStale: boolean;
  weakHash: boolean;
  lastAdminLoginAt: string | null;
  lockedUntil: string | null;
  createdAt: string;
  hasMfa: boolean;
  invitePending: boolean;
  lastLoginAt: string | null;
  lastCommitAt: string | null;
  offboardedAt: string | null;
}

export interface UserAccess {
  repo: string | null;
  path: string;
  via: string;
  access: Access;
}

export interface Group {
  name: string;
  description: string;
  users: string[];
  groups: string[];
  memberOf: string[];
  ruleCount: number;
  effectiveUserCount: number;
  isAdminGroup: boolean;
}

export type Access = '' | 'r' | 'rw';
export type PrincipalType = 'user' | 'group' | 'all' | 'authenticated' | 'anonymous';

export interface Rule {
  principalType: PrincipalType;
  principalName: string;
  access: Access;
}

export interface Section {
  repo: string | null;
  path: string;
  rules: Rule[];
}

export interface Repo {
  name: string;
  description: string;
  isArchived: boolean;
  archivedAt: string | null;
  missingOnDisk: boolean;
  url: string;
  revision: number | null;
  lastAuthor: string | null;
  lastCommitAt: string | null;
  lastMessage: string | null;
  sizeBytes: number | null;
  createdAt: string;
}

export interface TreeEntry {
  name: string;
  kind: 'dir' | 'file';
}

export interface LogEntry {
  repo: string;
  revision: number;
  author: string;
  date: string | null;
  message: string;
  paths: { action: string; path: string; kind: string }[];
}

export interface BackupRun {
  id: number;
  repoName: string;
  kind: string;
  trigger: string;
  startedAt: string;
  finishedAt: string | null;
  status: 'running' | 'ok' | 'failed';
  revision: number | null;
  targetPath: string;
  message: string;
}

export interface ConfigSnapshot {
  id: string;
  createdUtc: string;
  sizeBytes: number;
  files: { name: string; sizeBytes: number }[];
}

export interface BackupSettings {
  enabled: boolean;
  dailyTime: string;
  configSnapshotsToKeep: number;
}

export interface AuditEntry {
  id: number;
  at: string;
  actor: string;
  action: string;
  target: string;
  details: string;
  ip: string;
}

export interface AuditPage {
  total: number;
  page: number;
  pageSize: number;
  items: AuditEntry[];
}

export interface FileStatus {
  path: string;
  exists: boolean;
  lastWriteUtc: string | null;
  changedOutsideTool: boolean;
  everWritten: boolean;
}

export interface SystemStatus {
  files: { passwd: FileStatus; authz: FileStatus };
  tools: Record<string, boolean>;
  paths: Record<string, string | boolean>;
  adminGroup: string;
  publicUrl: string;
  minPasswordLength: number;
  passwordMaxAgeDays: number;
  version: string;
}

export interface Dashboard {
  users: { total: number; enabled: number; stalePasswords: number; weakHashes: number };
  groups: number;
  rules: number;
  repos: { active: number; archived: number; missing: number; totalBytes: number; recent: Repo[] };
  backups: {
    settings: BackupSettings;
    running: boolean;
    lastRun: BackupRun | null;
    failedLast24h: number;
    reposNeverBackedUp: number;
  };
  files: { passwd: FileStatus; authz: FileStatus };
  recentAudit: AuditEntry[];
}
