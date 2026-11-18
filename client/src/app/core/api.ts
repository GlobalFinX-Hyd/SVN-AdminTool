import { HttpClient, HttpErrorResponse, HttpParams } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import {
  AccessMatrix, AuditPage, BackupRun, BackupSettings, ConfigSnapshot, Dashboard, EmailSettingsForm, EmailStatus, Group, ImportRow, InactiveReport, LogEntry,
  LoginResult, Me, MyAccount, PasskeyInfo, Repo, Rule, Section, SvnLock, SystemStatus, TreeEntry, User, UserAccess,
} from './models';

/** Thin typed wrapper over the SvnAdmin REST API. All methods return promises. */
@Injectable({ providedIn: 'root' })
export class Api {
  private http = inject(HttpClient);

  private get<T>(url: string, params?: Record<string, string | number | null | undefined>) {
    let p = new HttpParams();
    for (const [k, v] of Object.entries(params ?? {})) if (v !== null && v !== undefined && v !== '') p = p.set(k, v);
    return firstValueFrom(this.http.get<T>(url, { params: p }));
  }
  private post<T>(url: string, body: unknown = {}) { return firstValueFrom(this.http.post<T>(url, body)); }
  private put<T>(url: string, body: unknown) { return firstValueFrom(this.http.put<T>(url, body)); }
  private del<T>(url: string, params?: Record<string, string>) {
    return firstValueFrom(this.http.delete<T>(url, { params: new HttpParams({ fromObject: params ?? {} }) }));
  }
  private text(url: string) { return firstValueFrom(this.http.get(url, { responseType: 'text' })); }

  // auth
  login(username: string, password: string) { return this.post<LoginResult>('/api/auth/login', { username, password }); }
  mfa(code: string, kind: 'totp' | 'recovery') { return this.post<LoginResult>('/api/auth/mfa', { code, kind }); }
  passkeyLoginOptions() { return this.post<{ handle: string; options: unknown }>('/api/auth/passkey/options'); }
  passkeyLogin(handle: string, credential: unknown) { return this.post<LoginResult>('/api/auth/passkey', { handle, credential }); }
  logout() { return this.post<void>('/api/auth/logout'); }
  me() { return this.get<Me>('/api/auth/me'); }

  // my account (any signed-in user)
  account() { return this.get<MyAccount>('/api/account'); }
  changeOwnPassword(currentPassword: string, newPassword: string) {
    return this.post<void>('/api/account/password', { currentPassword, newPassword });
  }
  totpSetup() { return this.post<{ secret: string; otpAuthUri: string; qrPngDataUri: string }>('/api/account/totp/setup'); }
  totpConfirm(code: string) { return this.post<{ recoveryCodes: string[]; me: Me }>('/api/account/totp/confirm', { code }); }
  totpRemove(password: string) { return this.post<void>('/api/account/totp/remove', { password }); }
  newRecoveryCodes(password: string) { return this.post<{ recoveryCodes: string[] }>('/api/account/recovery-codes', { password }); }
  passkeyRegisterOptions() { return this.post<{ handle: string; options: unknown }>('/api/account/passkeys/options'); }
  passkeyRegister(handle: string, credential: unknown, name: string) {
    return this.post<{ passkey: PasskeyInfo; recoveryCodes: string[] | null; me: Me }>('/api/account/passkeys', { handle, credential, name });
  }
  renamePasskey(id: number, name: string) { return this.put<void>(`/api/account/passkeys/${id}`, { name }); }
  deletePasskey(id: number) { return this.del<void>(`/api/account/passkeys/${id}`); }

  // public (no session)
  forgot(login: string) { return this.post<{ message: string }>('/api/public/forgot', { login }); }
  checkLink(token: string) {
    return this.get<{ username: string; fullName: string; purpose: 'reset' | 'welcome'; minPasswordLength: number }>('/api/public/link', { token });
  }
  useLink(token: string, password: string) { return this.post<{ message: string }>('/api/public/link', { token, password }); }

  // admin: reports, locks, user extras
  accessMatrix(path: string, includeDisabled: boolean) {
    return this.get<AccessMatrix>('/api/reports/access', { path, includeDisabled: includeDisabled ? 'true' : null });
  }
  inactive(days: number) { return this.get<InactiveReport>('/api/reports/inactive', { days }); }
  rescanActivity() { return this.post<void>('/api/reports/rescan'); }
  locks() { return this.get<SvnLock[]>('/api/locks'); }
  breakLocks(locks: { repo: string; path: string }[]) {
    return this.post<{ repo: string; broken: number; error: string | null }[]>('/api/locks/break', { locks });
  }
  offboard(username: string, reason: string, breakLocks: boolean) {
    return this.post<{ groups: string[]; removedRules: number; brokenLocks: number }>(`/api/users/${enc(username)}/offboard`, { reason, breakLocks });
  }
  sendWelcome(username: string) { return this.post<void>(`/api/users/${enc(username)}/send-welcome`); }
  sendReset(username: string) { return this.post<void>(`/api/users/${enc(username)}/send-reset`); }
  resetMfa(username: string) { return this.post<void>(`/api/users/${enc(username)}/reset-mfa`); }
  bulk(usernames: string[], action: string, group?: string) {
    return this.post<{ done: number; errors: string[] }>('/api/users/bulk', { usernames, action, group });
  }
  importUsers(csv: string, sendWelcome: boolean, dryRun: boolean) {
    return this.post<{ created: number; rows: ImportRow[] }>('/api/users/import', { csv, sendWelcome, dryRun });
  }
  emailStatus() { return this.get<EmailStatus>('/api/system/email'); }
  saveEmail(f: EmailSettingsForm) { return this.put<void>('/api/system/email', f); }
  testEmail(f: EmailSettingsForm) { return this.post<{ sentTo: string }>('/api/system/email/test', f); }

  // users
  users() { return this.get<User[]>('/api/users'); }
  createUser(body: { username: string; fullName: string; email: string; password: string | null; groups: string[]; notes: string; sendWelcome: boolean }) {
    return this.post<User>('/api/users', body);
  }
  updateUser(username: string, body: { fullName: string; email: string; notes: string; isEnabled: boolean; groups: string[] }) {
    return this.put<User>(`/api/users/${enc(username)}`, body);
  }
  setPassword(username: string, password: string) { return this.post<void>(`/api/users/${enc(username)}/password`, { password }); }
  unlockUser(username: string) { return this.post<void>(`/api/users/${enc(username)}/unlock`); }
  deleteUser(username: string) { return this.del<{ removedRules: number }>(`/api/users/${enc(username)}`); }
  userAccess(username: string) { return this.get<UserAccess[]>(`/api/users/${enc(username)}/access`); }

  // groups
  groups() { return this.get<Group[]>('/api/groups'); }
  createGroup(body: { name: string; description: string; users: string[]; groups: string[] }) { return this.post<Group>('/api/groups', body); }
  updateGroup(name: string, body: { name: string; description: string; users: string[]; groups: string[] }) {
    return this.put<Group>(`/api/groups/${enc(name)}`, body);
  }
  deleteGroup(name: string) { return this.del<{ removedRules: number }>(`/api/groups/${enc(name)}`); }

  // permissions
  sections(repo?: string | null) { return this.get<Section[]>('/api/access', { repo }); }
  saveSection(body: { repo: string | null; path: string; originalPath: string | null; rules: Rule[] }) {
    return this.put<void>('/api/access/section', body);
  }
  deleteSection(repo: string | null, path: string) {
    return this.del<void>('/api/access/section', repo ? { repo, path } : { path });
  }

  // repositories
  repos() { return this.get<Repo[]>('/api/repos'); }
  createRepo(body: { name: string; description: string; createLayout: boolean; grants: Rule[] }) { return this.post<Repo>('/api/repos', body); }
  updateRepo(name: string, description: string) { return this.put<void>(`/api/repos/${enc(name)}`, { description }); }
  archiveRepo(name: string) { return this.post<void>(`/api/repos/${enc(name)}/archive`); }
  restoreRepo(name: string) { return this.post<void>(`/api/repos/${enc(name)}/restore`); }
  tree(name: string, path: string) { return this.get<TreeEntry[]>(`/api/repos/${enc(name)}/tree`, { path }); }
  repoLog(name: string, limit = 50) { return this.get<LogEntry[]>(`/api/repos/${enc(name)}/log`, { limit }); }
  activity(limit = 50, author?: string) { return this.get<LogEntry[]>('/api/activity', { limit, author }); }

  // config backups
  backups() { return this.get<{ running: boolean; snapshots: ConfigSnapshot[]; runs: BackupRun[] }>('/api/backups'); }
  snapshotDownloadUrl(id: string) { return `/api/backups/${enc(id)}/download`; }
  backupSettings() { return this.get<BackupSettings>('/api/backups/settings'); }
  saveBackupSettings(s: BackupSettings) { return this.put<void>('/api/backups/settings', s); }
  runBackup() { return this.post<ConfigSnapshot>('/api/backups/run'); }
  deleteSnapshot(id: string) { return this.del<void>(`/api/backups/${enc(id)}`); }
  restoreSnapshot(id: string) { return this.post<{ safetySnapshot: string; warnings: string[] }>(`/api/backups/${enc(id)}/restore`); }

  // audit + system
  audit(f: AuditFilter, page: number, pageSize: number) {
    return this.get<AuditPage>('/api/audit', { ...f, page, pageSize });
  }
  /** CSV download link. Pass no filter to download the whole log. */
  auditExportUrl(f: AuditFilter = {}) {
    let p = new HttpParams();
    for (const [k, v] of Object.entries(f)) if (v) p = p.set(k, v);
    const qs = p.toString();
    return '/api/audit/export' + (qs ? '?' + qs : '');
  }
  dashboard() { return this.get<Dashboard>('/api/dashboard'); }
  systemStatus() { return this.get<SystemStatus>('/api/system/status'); }
  authzPreview() { return this.text('/api/system/authz-preview'); }
  authzCurrent() { return this.text('/api/system/authz-current'); }
  reimportAuthz() { return this.post<{ warnings: string[] }>('/api/system/authz/reimport'); }
  overwriteAuthz() { return this.post<void>('/api/system/authz/overwrite'); }
}

function enc(s: string) { return encodeURIComponent(s); }

/** Audit log filters. from/to are ISO instants; "to" is exclusive. */
export interface AuditFilter { search?: string; action?: string; from?: string; to?: string; }

/** Pulls the server's { message } out of an HTTP error, or a sensible fallback. */
export function errorMessage(err: unknown): string {
  if (err instanceof HttpErrorResponse) {
    const body = err.error;
    if (body && typeof body === 'object' && 'message' in body) return String(body.message);
    if (typeof body === 'string' && body.startsWith('{')) {
      try { return JSON.parse(body).message ?? err.message; } catch { /* fall through */ }
    }
    if (err.status === 0) return 'Cannot reach the SvnAdmin server.';
    return `Request failed (${err.status}).`;
  }
  return err instanceof Error ? err.message : String(err);
}
