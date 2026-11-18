import { DatePipe, KeyValuePipe } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { Component, OnInit, computed, inject, signal } from '@angular/core';
import { Api } from '../core/api';
import { Auth } from '../core/auth';
import { Branding } from '../core/branding';
import { EmailSettingsForm, EmailStatus, FileStatus, SystemStatus } from '../core/models';
import { Confirm, Toasts } from '../core/ui';
import { Modal } from '../shared/modal';
import { usePageActions } from '../ui/command';
import { AgoPipe } from '../ui/helpers';
import { MxIcon } from '../ui/icon';

@Component({
  selector: 'app-system',
  imports: [DatePipe, KeyValuePipe, FormsModule, Modal, MxIcon, AgoPipe],
  template: `
    <div class="mx-page-header">
      <div><h1>System</h1><p>Apache files, email, sign-in security and paths.</p></div>
      <div class="mx-actions"><button class="mx-btn secondary" (click)="load()" title="Refresh (r)"><mx-icon name="refresh" />Refresh</button></div>
    </div>

    @if (s(); as s) {
      <div class="mx-stack">
        @if (s.files.authz.changedOutsideTool) {
          <div class="mx-alert warning" role="alert"><mx-icon name="warning" />
            <div class="mx-alert-body"><strong>The authz file was edited outside SvnAdmin.</strong> No change is saved until you choose:
              <strong>Re-import</strong> keeps the hand edit (SvnAdmin's groups and rules become what's in the file), or
              <strong>Overwrite</strong> puts SvnAdmin's version back (the edited file is kept in the config history folder).</div>
            <div class="mx-alert-actions">
              <button class="mx-btn sm secondary" (click)="showDiff()">Compare</button>
              <button class="mx-btn sm" (click)="reimport()">Re-import</button>
              <button class="mx-btn sm danger" (click)="overwrite()">Overwrite</button>
            </div></div>
        }

        <div class="mx-cols two">
          <section class="mx-card">
            <h2>Apache files</h2>
            @for (f of [{ label: 'Users (passwd)', v: s.files.passwd }, { label: 'Permissions (authz)', v: s.files.authz }]; track f.label) {
              <div class="mb-4">
                <div class="mx-row"><strong class="grow">{{ f.label }}</strong><span class="mx-chip" [class]="'mx-chip ' + chip(f.v)">{{ state(f.v) }}</span></div>
                <code class="small" style="word-break: break-all">{{ f.v.path }}</code>
                @if (f.v.lastWriteUtc) { <div class="small text-secondary" [title]="f.v.lastWriteUtc | date: 'medium'">Changed {{ f.v.lastWriteUtc | ago }}</div> }
              </div>
            }
            <button class="mx-btn sm secondary" (click)="preview()"><mx-icon name="visibility" />Preview the authz SvnAdmin writes</button>
          </section>

          <section class="mx-card" id="email">
            <div class="mx-row mb-2"><h2 class="grow" style="margin: 0">Email</h2>
              @if (email(); as e) { @if (e.configured) { <span class="mx-chip success">On</span> } @else { <span class="mx-chip neutral">Off</span> } }</div>
            <p class="small text-secondary">Used for welcome emails and "Forgot password" links. Any SMTP server that supports STARTTLS (port 587) or TLS (port 465).</p>
            @if (email()?.usesPickupFolder) { <div class="mx-alert warning mb-4"><mx-icon name="science" /><div class="mx-alert-body">Development mode: emails are written to a folder, not sent.</div></div> }
            <div class="mx-form cols-2">
              <label class="mx-check span-all"><input type="checkbox" [(ngModel)]="ef.enabled" />Send emails</label>
              <div class="mx-field"><label for="e-host">SMTP server</label><input id="e-host" [(ngModel)]="ef.host" placeholder="smtp.example.com" autocomplete="off" /></div>
              <div class="mx-field"><label for="e-port">Port</label>
                <select id="e-port" [(ngModel)]="ef.port"><option [ngValue]="587">587 (STARTTLS, recommended)</option><option [ngValue]="465">465 (SSL)</option><option [ngValue]="2525">2525 (STARTTLS)</option><option [ngValue]="25">25 (STARTTLS)</option></select></div>
              <div class="mx-field"><label for="e-user">SMTP username</label><input id="e-user" [(ngModel)]="ef.username" placeholder="postmaster@mg.example.com" autocomplete="off" /></div>
              <div class="mx-field">
                <label for="e-pass">SMTP password</label>
                @if (email()?.passwordSet && !changingPassword()) {
                  <div class="mx-row" style="flex-wrap: nowrap"><input id="e-pass" class="grow" value="Saved (hidden)" disabled />
                    <button type="button" class="mx-btn sm secondary" (click)="changingPassword.set(true)">Change</button></div>
                } @else {
                  <input id="e-pass" type="password" [(ngModel)]="newPassword" autocomplete="new-password" [placeholder]="email()?.passwordSet ? 'Leave empty to keep the saved one' : ''" />
                }
                <span class="mx-help">Stored encrypted; never shown again.</span>
              </div>
              <div class="mx-field"><label for="e-from">From address</label><input id="e-from" type="email" [(ngModel)]="ef.fromAddress" placeholder="svnadmin@example.com" /></div>
              <div class="mx-field"><label for="e-fromname">From name</label><input id="e-fromname" [(ngModel)]="ef.fromName" [placeholder]="brand.productName()" /></div>
              <div class="mx-field span-all">
                <label for="e-to">Send a test to</label>
                <div class="mx-row" style="flex-wrap: nowrap">
                  <input id="e-to" class="mx-input grow" type="email" [(ngModel)]="testTo" [placeholder]="myEmail() || 'you@example.com'" />
                  <button type="button" class="mx-btn secondary" [disabled]="busy()" (click)="testEmail()"><mx-icon name="send" />Send test email</button>
                </div>
                <span class="mx-help">Uses the values above, even before you save.</span>
              </div>
              <div class="mx-form-actions"><button class="mx-btn primary" [disabled]="busy()" (click)="saveEmail()">Save email settings</button></div>
            </div>
            <p class="small mx-muted mt-4" style="margin-bottom: 0">Links in emails point to <code>{{ email()?.appUrl || 'Svn:AppUrl not set' }}</code>.</p>
          </section>

          <section class="mx-card">
            <h2>Sign-in security</h2>
            <dl class="mx-kv">
              <dt>Admin group</dt><dd><code>&#64;{{ s.adminGroup }}</code></dd>
              <dt>Admins need two-step</dt><dd>{{ email()?.requireAdminMfa ? 'Yes' : 'No' }}</dd>
              <dt>Passkey domain</dt><dd><code>{{ email()?.passkeyRpId || 'not set' }}</code></dd>
              <dt>Min password length</dt><dd>{{ s.minPasswordLength }}</dd>
              <dt>Flag passwords older than</dt><dd>{{ s.passwordMaxAgeDays ? s.passwordMaxAgeDays + ' days' : 'off' }}</dd>
            </dl>
          </section>

          <section class="mx-card">
            <h2>Paths and tools</h2>
            <dl class="mx-kv">
              <dt>Checkout URL</dt><dd><code>{{ s.publicUrl || 'not set' }}</code></dd>
              @for (p of s.paths | keyvalue; track p.key) { <dt>{{ p.key }}</dt><dd><code class="small" style="word-break: break-all">{{ p.value }}</code></dd> }
              @for (t of s.tools | keyvalue; track t.key) {
                <dt>{{ t.key }}</dt><dd>@if (t.value) { <span class="text-success">found</span> } @else { <span class="text-danger">not found, set Svn:SvnBinDir</span> }</dd>
              }
              <dt>Version</dt><dd>{{ s.version }}</dd>
            </dl>
          </section>
        </div>
      </div>
    }

    @if (text(); as t) {
      <app-modal [title]="t.title" size="xl" (closed)="text.set(null)">
        @if (t.second !== undefined) {
          <div class="mx-cols two">
            <div><div class="small text-secondary mb-2">File on disk now</div><pre class="code">{{ t.body }}</pre></div>
            <div><div class="small text-secondary mb-2">What SvnAdmin would write</div><pre class="code">{{ t.second }}</pre></div>
          </div>
        } @else { <pre class="code">{{ t.body }}</pre> }
        <ng-container footer><button class="mx-btn primary" (click)="text.set(null)">Close</button></ng-container>
      </app-modal>
    }
  `,
})
export class SystemPage implements OnInit {
  private api = inject(Api);
  protected brand = inject(Branding);
  private toasts = inject(Toasts);
  private confirm = inject(Confirm);
  protected s = signal<SystemStatus | null>(null);
  protected email = signal<EmailStatus | null>(null);
  protected busy = signal(false);
  protected text = signal<{ title: string; body: string; second?: string } | null>(null);
  protected myEmail = computed(() => this.auth.me()?.email ?? '');
  protected changingPassword = signal(false);
  protected ef: EmailSettingsForm = { enabled: false, host: '', port: 587, username: '', password: null, fromAddress: '', fromName: '' };
  protected newPassword = '';
  protected testTo = '';
  private auth = inject(Auth);

  constructor() { usePageActions({ refresh: () => this.load() }); }
  async ngOnInit() {
    await this.load();
    if (location.hash === '#email') setTimeout(() => document.getElementById('email')?.scrollIntoView({ behavior: 'smooth', block: 'start' }));
  }

  async load() {
    try {
      const [s, e] = await Promise.all([this.api.systemStatus(), this.api.emailStatus()]);
      this.s.set(s);
      this.email.set(e);
      this.ef = { enabled: e.enabled, host: e.host, port: e.port || 587, username: e.username, password: null, fromAddress: e.fromAddress, fromName: e.fromName || this.brand.productName() };
      this.newPassword = '';
      this.changingPassword.set(false);
    } catch (e) { this.toasts.error(e); }
  }

  state(f: FileStatus) { return !f.exists ? 'missing' : f.changedOutsideTool ? 'edited outside SvnAdmin' : f.everWritten ? 'in sync' : 'imported'; }
  chip(f: FileStatus) { return !f.exists ? 'danger' : f.changedOutsideTool ? 'warning' : 'success'; }

  /** The form's values; an empty password field keeps the saved password. */
  private form(): EmailSettingsForm {
    return { ...this.ef, port: Number(this.ef.port), password: this.newPassword ? this.newPassword : null };
  }

  async testEmail() {
    this.busy.set(true);
    try {
      const r = await this.api.testEmail({ ...this.form(), testTo: this.testTo.trim() || null });
      this.toasts.ok(`Test email sent to ${r.sentTo}. Check that inbox (and its spam folder).`);
    } catch (e) { this.toasts.error(e); } finally { this.busy.set(false); }
  }

  async saveEmail() {
    this.busy.set(true);
    try {
      await this.api.saveEmail(this.form());
      this.toasts.ok(this.ef.enabled ? 'Email settings saved. Welcome and reset emails are on.' : 'Email settings saved. Sending is off.');
      await this.load();
      await this.auth.refresh();
    } catch (e) { this.toasts.error(e); } finally { this.busy.set(false); }
  }

  async preview() { try { this.text.set({ title: 'authz preview', body: await this.api.authzPreview() }); } catch (e) { this.toasts.error(e); } }

  async showDiff() {
    try {
      const [cur, next] = await Promise.all([this.api.authzCurrent(), this.api.authzPreview()]);
      this.text.set({ title: 'Compare authz', body: cur, second: next });
    } catch (e) { this.toasts.error(e); }
  }

  async reimport() {
    if (!(await this.confirm.ask({ title: 'Re-import the authz file?', body: "SvnAdmin's groups and rules become what the file contains now. Users aren't affected.", confirmText: 'Re-import' }))) return;
    try {
      const r = await this.api.reimportAuthz();
      if (r.warnings.length) this.toasts.show('warning', 'Imported with warnings:\n' + r.warnings.join('\n'), 15000);
      else this.toasts.ok('Authz file re-imported.');
      await this.load();
    } catch (e) { this.toasts.error(e); }
  }

  async overwrite() {
    if (!(await this.confirm.ask({ title: 'Overwrite the authz file?', body: "The hand edit is discarded and SvnAdmin's version written. The edited file is kept in the config history folder.", confirmText: 'Overwrite', danger: true }))) return;
    try { await this.api.overwriteAuthz(); this.toasts.ok('Authz file overwritten.'); await this.load(); } catch (e) { this.toasts.error(e); }
  }
}
