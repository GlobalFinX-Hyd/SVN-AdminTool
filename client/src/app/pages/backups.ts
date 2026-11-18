import { DatePipe } from '@angular/common';
import { Component, OnInit, inject, input, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Router } from '@angular/router';
import { Api } from '../core/api';
import { BackupRun, BackupSettings, ConfigSnapshot } from '../core/models';
import { Confirm, Toasts, formatBytes } from '../core/ui';
import { usePageActions } from '../ui/command';
import { AgoPipe } from '../ui/helpers';
import { MxIcon } from '../ui/icon';

/** Config backups: snapshots of the passwd file, the authz file and the SvnAdmin database. */
@Component({
  selector: 'app-backups',
  imports: [FormsModule, DatePipe, MxIcon, AgoPipe],
  template: `
    <div class="mx-page-header">
      <div><h1>Config backups</h1><p>Snapshots of the passwd file, the authz file and the SvnAdmin database.</p></div>
      <div class="mx-actions">
        <button class="mx-btn primary" (click)="runNow()" [disabled]="busy()">@if (busy()) { <span class="spinner"></span> Backing up… } @else { <mx-icon name="backup" />Back up now }</button>
      </div>
    </div>

    <div class="mx-cols side">
      <div class="mx-stack">
        <section class="mx-card">
          <h2>Schedule</h2>
          @if (settings(); as s) {
            <div class="mx-form">
              <label class="mx-check"><input type="checkbox" [(ngModel)]="s.enabled" />Back up every day</label>
              <div class="mx-field"><label for="b-time">Time (server time)</label><input id="b-time" type="time" [(ngModel)]="s.dailyTime" /></div>
              <div class="mx-field"><label for="b-keep">Snapshots to keep</label><input id="b-keep" type="number" min="1" max="365" [(ngModel)]="s.configSnapshotsToKeep" />
                <span class="mx-help">Older snapshots are deleted automatically.</span></div>
              <div class="mx-form-actions"><button class="mx-btn primary" (click)="save(s)">Save</button></div>
            </div>
          }
        </section>
        <section class="mx-card">
          <h2>What's in a snapshot</h2>
          <ul class="small" style="margin: 0; padding-left: 1.1rem">
            <li><code>svn_users.passwd</code>: every SVN account and password hash</li>
            <li><code>svn_access_control.authz</code>: groups and folder permissions</li>
            <li><code>svnadmin.db</code>: SvnAdmin's database (users' details, two-step sign-in, audit log)</li>
          </ul>
          <p class="small text-secondary mt-4" style="margin-bottom: 0"><strong>Restore</strong> puts back passwords, which accounts are enabled, groups and folder permissions.
            Names, emails, two-step sign-in and the audit log stay as they are now. A fresh snapshot is taken first, so you can undo a restore by restoring that one.</p>
        </section>
      </div>

      <div class="mx-stack">
        <section class="mx-card flush">
          <div class="mx-card-head"><h2><mx-icon name="inventory_2" />Snapshots</h2><span class="small text-secondary">{{ snapshots().length }}</span></div>
          <div class="mx-table-wrap scroll">
            <table class="mx-table">
              <thead><tr><th>Taken</th><th>Contains</th><th class="right"></th></tr></thead>
              <tbody>
                @for (s of snapshots(); track s.id) {
                  <tr>
                    <td><div class="nowrap"><strong>{{ s.createdUtc | date: 'EEE d MMM y' }}</strong> · {{ s.createdUtc | date: 'h:mm:ss a' }}</div>
                      <div class="small mx-muted">{{ s.createdUtc | ago }} · {{ bytes(s.sizeBytes) }}</div>
                      <div class="small mx-muted mono">{{ s.id }}</div></td>
                    <td class="small">@for (f of s.files; track f.name) { <div class="truncate" [title]="f.name + ' · ' + bytes(f.sizeBytes)">{{ label(f.name) }}</div> }</td>
                    <td class="right"><div class="mx-row-actions" style="justify-content: flex-end">
                      <button class="mx-btn sm secondary" (click)="restore(s, $first)" [disabled]="busy()"><mx-icon name="settings_backup_restore" />Restore</button>
                      <a class="mx-icon-btn" [href]="api.snapshotDownloadUrl(s.id)" download title="Download as zip" aria-label="Download as zip"><mx-icon name="download" [size]="18" /></a>
                      <button class="mx-icon-btn danger" [title]="snapshots().length > 1 ? 'Delete' : 'The only snapshot can\\'t be deleted'"
                              aria-label="Delete snapshot" (click)="remove(s)" [disabled]="busy() || snapshots().length <= 1"><mx-icon name="delete" [size]="18" /></button>
                    </div></td>
                  </tr>
                } @empty { <tr><td colspan="3"><div class="mx-empty"><mx-icon name="backup" /><h3>No snapshots yet</h3><p>Press "Back up now" to take the first one.</p></div></td></tr> }
              </tbody>
            </table>
          </div>
        </section>

        @if (failures().length) {
          <section class="mx-card flush">
            <div class="mx-card-head"><h2><mx-icon name="error" class="text-danger" />Failed backups</h2></div>
            <ul class="mx-list">
              @for (r of failures(); track r.id) {
                <li><div class="mx-row"><span class="mx-chip danger">failed</span><span class="small text-secondary">{{ r.startedAt | ago }} · {{ r.trigger }}</span></div>
                  <div class="small text-danger">{{ r.message }}</div></li>
              }
            </ul>
          </section>
        }
      </div>
    </div>
  `,
})
export class BackupsPage implements OnInit {
  protected api = inject(Api);
  private toasts = inject(Toasts);
  private confirm = inject(Confirm);
  private router = inject(Router);
  readonly run = input<string>();
  protected snapshots = signal<ConfigSnapshot[]>([]);
  protected failures = signal<BackupRun[]>([]);
  protected settings = signal<BackupSettings | null>(null);
  protected busy = signal(false);
  protected bytes = formatBytes;

  constructor() { usePageActions({ refresh: () => this.load() }); }

  async ngOnInit() {
    this.api.backupSettings().then((s) => this.settings.set(s)).catch((e) => this.toasts.error(e));
    await this.load();
    if (this.run()) { this.router.navigate([], { queryParams: {}, replaceUrl: true }); await this.runNow(); }
  }

  async load() {
    try {
      const r = await this.api.backups();
      this.snapshots.set(r.snapshots);
      const lastOk = r.runs.find((x) => x.status === 'ok');
      this.failures.set(r.runs.filter((x) => x.status === 'failed' && (!lastOk || x.startedAt > lastOk.startedAt)).slice(0, 5));
    } catch (e) { this.toasts.error(e); }
  }

  async runNow() {
    this.busy.set(true);
    try {
      const s = await this.api.runBackup();
      this.toasts.ok(`Config backed up (${s.files.length} files, ${formatBytes(s.sizeBytes)}).`);
      await this.load();
    } catch (e) { this.toasts.error(e); } finally { this.busy.set(false); }
  }

  async restore(s: ConfigSnapshot, isLatest: boolean) {
    const when = new Date(s.createdUtc).toLocaleString();
    const ok = await this.confirm.ask({
      title: `Restore the snapshot from ${when}?`,
      body: 'SVN access goes back to how it was then:\n' +
        '• passwords and which accounts are enabled (accounts created since are disabled)\n' +
        '• all groups and folder permissions\n\n' +
        'Names, emails, two-step sign-in and the audit log are not changed. A snapshot of the current state is taken first, so this can be undone.' +
        (isLatest ? '' : '\n\nNewer snapshots exist; changes made since this one will be undone.'),
      confirmText: 'Restore',
      danger: true,
      typeToConfirm: 'restore',
    });
    if (!ok) return;
    this.busy.set(true);
    try {
      const r = await this.api.restoreSnapshot(s.id);
      this.toasts.ok(`Restored the ${when} snapshot. To undo, restore the newest one (${r.safetySnapshot}).`);
      if (r.warnings.length) this.toasts.show('warning', 'Restored with warnings:\n' + r.warnings.join('\n'), 15000);
      await this.load();
    } catch (e) { this.toasts.error(e); } finally { this.busy.set(false); }
  }

  /** Short, plain names for the snapshot files (full name and size on hover). */
  label(file: string) {
    if (file.endsWith('.passwd')) return 'Users & passwords';
    if (file.endsWith('.authz')) return 'Groups & permissions';
    if (file.endsWith('.db')) return 'SvnAdmin database';
    return file;
  }

  async remove(s: ConfigSnapshot) {
    const when = new Date(s.createdUtc).toLocaleString();
    const ok = await this.confirm.ask({
      title: `Delete the snapshot from ${when}?`,
      body: `Its ${s.files.length} files (${formatBytes(s.sizeBytes)}) are deleted from the server. This can't be undone.`,
      confirmText: 'Delete', danger: true,
    });
    if (!ok) return;
    this.busy.set(true);
    try { await this.api.deleteSnapshot(s.id); this.toasts.ok(`Deleted the ${when} snapshot.`); await this.load(); }
    catch (e) { this.toasts.error(e); } finally { this.busy.set(false); }
  }

  async save(s: BackupSettings) {
    try { await this.api.saveBackupSettings(s); this.toasts.ok(s.enabled ? `Daily config backup at ${s.dailyTime}.` : 'Scheduled config backups are off.'); }
    catch (e) { this.toasts.error(e); }
  }
}
