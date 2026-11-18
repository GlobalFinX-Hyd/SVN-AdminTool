import { DatePipe } from '@angular/common';
import { Component, OnInit, inject, input, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute } from '@angular/router';
import { Api, errorMessage } from '../core/api';
import { Auth } from '../core/auth';
import { Branding } from '../core/branding';
import { MyAccount, PasskeyInfo } from '../core/models';
import { attestationToJson, isPasskeyCancel, passkeysSupported, toCreationOptions } from '../core/passkey';
import { Confirm, Toasts, accessLabel } from '../core/ui';
import { Modal } from '../shared/modal';
import { usePageActions } from '../ui/command';
import { AgoPipe, copyText } from '../ui/helpers';
import { MxIcon } from '../ui/icon';
import { PasswordField } from '../ui/password-field';

/** Self-service for every SVN user: password, two-step sign-in (authenticator app, passkeys, recovery codes), my access. */
@Component({
  selector: 'app-account',
  imports: [FormsModule, Modal, MxIcon, PasswordField, DatePipe, AgoPipe],
  template: `
    <div class="mx-page-header">
      <div><h1>My account</h1><p>Your SVN password, two-step sign-in, and what you can access.</p></div>
    </div>

    @if (auth.me()?.needsMfaSetup) {
      <div class="mx-alert warning mb-4" role="alert">
        <mx-icon name="shield_lock" />
        <div class="mx-alert-body"><strong>Admins must use two-step sign-in.</strong> Add a passkey or an authenticator app below, then the admin pages unlock.</div>
      </div>
    }

    @if (a(); as a) {
      <div class="mx-cols two">
        <div class="mx-stack">
          <section class="mx-card">
            <h2>Profile</h2>
            <dl class="mx-kv">
              <dt>Username</dt><dd><strong>{{ a.username }}</strong></dd>
              <dt>Name</dt><dd>{{ a.fullName || '—' }}</dd>
              <dt>Email</dt><dd>{{ a.email || 'None. Ask IT to add one so you can reset your password yourself.' }}</dd>
              <dt>Groups</dt><dd>@for (g of a.groups; track g) { <span class="mx-chip neutral" style="margin: 0 4px 4px 0">{{ g }}</span> } @empty { none }</dd>
              <dt>Password changed</dt><dd [title]="a.passwordChangedAt ? (a.passwordChangedAt | date: 'medium') : ''">{{ a.passwordChangedAt | ago: 'unknown' }}</dd>
              <dt>Last sign-in here</dt><dd>{{ a.lastLoginAt | ago: 'never' }}</dd>
            </dl>
          </section>

          <section class="mx-card" id="password">
            <h2>Change password</h2>
            <p class="small text-secondary">This is your SVN password. TortoiseSVN will ask for the new one next time you update or commit.</p>
            <form class="mx-form" (ngSubmit)="changePassword()">
              <div class="mx-field">
                <label for="cur">Current password</label>
                <input id="cur" name="cur" type="password" [(ngModel)]="current" autocomplete="current-password" />
              </div>
              <app-password-field label="New password" [(value)]="newPw" [min]="auth.me()?.minPasswordLength ?? 10" [username]="a.username" />
              <div class="mx-form-actions"><button class="mx-btn primary" [disabled]="busy() || !current || !newPw">Change password</button></div>
            </form>
          </section>
        </div>

        <div class="mx-stack">
          <section class="mx-card" id="mfa">
            <h2>Two-step sign-in</h2>
            <p class="small text-secondary">Protects your SvnAdmin sign-in (this site). SVN itself still uses just your password.</p>

            <div class="factor">
              <mx-icon name="passkey" [size]="22" />
              <div class="grow">
                <div class="factor-title">Passkeys @if (a.passkeys.length) { <span class="mx-chip success">{{ a.passkeys.length }} added</span> }</div>
                <div class="small text-secondary">Sign in with Windows Hello, Touch ID, your phone, or a security key. No code to type.</div>
              </div>
              @if (canPasskey) { <button class="mx-btn sm" (click)="addPasskey()" [disabled]="busy()"><mx-icon name="add" />Add passkey</button> }
            </div>
            @if (a.passkeys.length) {
              <ul class="mx-list keys">
                @for (p of a.passkeys; track p.id) {
                  <li class="mx-row">
                    <mx-icon name="key" [size]="18" class="text-secondary" />
                    <div class="grow"><div>{{ p.name }}</div><div class="small text-secondary">Added {{ p.createdAt | ago }} · last used {{ p.lastUsedAt | ago: 'never' }}</div></div>
                    <button class="mx-icon-btn" title="Rename" aria-label="Rename passkey" (click)="rename(p)"><mx-icon name="edit" [size]="18" /></button>
                    <button class="mx-icon-btn danger" title="Remove" aria-label="Remove passkey" (click)="removePasskey(p)"><mx-icon name="delete" [size]="18" /></button>
                  </li>
                }
              </ul>
            }
            @if (!canPasskey) { <p class="small text-secondary">This browser can't use passkeys.</p> }

            <hr />
            <div class="factor">
              <mx-icon name="phonelink_lock" [size]="22" />
              <div class="grow">
                <div class="factor-title">Authenticator app @if (a.hasTotp) { <span class="mx-chip success">On</span> } @else { <span class="mx-chip neutral">Off</span> }</div>
                <div class="small text-secondary">Microsoft Authenticator, Google Authenticator, 1Password and similar apps.</div>
              </div>
              @if (a.hasTotp) { <button class="mx-btn sm secondary" (click)="askPassword('remove-totp')">Remove</button> }
              @else { <button class="mx-btn sm" (click)="startTotp()" [disabled]="busy()"><mx-icon name="qr_code_2" />Set up</button> }
            </div>

            @if (a.hasTotp || a.passkeys.length) {
              <hr />
              <div class="factor">
                <mx-icon name="password" [size]="22" />
                <div class="grow">
                  <div class="factor-title">Recovery codes <span class="mx-chip" [class.warning]="a.recoveryCodesLeft <= 3" [class.neutral]="a.recoveryCodesLeft > 3">{{ a.recoveryCodesLeft }} left</span></div>
                  <div class="small text-secondary">One-time codes for when you don't have your phone or passkey.</div>
                </div>
                <button class="mx-btn sm secondary" (click)="askPassword('codes')">Make new codes</button>
              </div>
            }
          </section>

          <section class="mx-card flush">
            <div class="mx-card-head"><h2><mx-icon name="folder_data" />What I can access</h2></div>
            <div class="mx-table-wrap">
              <table class="mx-table compact">
                <thead><tr><th>Repository</th><th>Folder</th><th>Access</th><th>Because of</th><th></th></tr></thead>
                <tbody>
                  @for (r of a.access; track $index) {
                    <tr [class.dim]="r.access === ''">
                      <td>{{ r.repo ?? 'All repositories' }}</td><td><code>{{ r.path }}</code></td>
                      <td><span class="mx-chip" [class]="'mx-chip ' + (r.access === 'rw' ? 'success' : r.access === 'r' ? 'info' : 'danger')">{{ label(r.access) }}</span></td>
                      <td><code>{{ r.via }}</code></td>
                      <td class="right">@if (r.url && r.access) { <button class="mx-icon-btn" title="Copy checkout URL" aria-label="Copy checkout URL" (click)="copy(r.url)"><mx-icon name="content_copy" [size]="18" /></button> }</td>
                    </tr>
                  } @empty { <tr><td colspan="5"><div class="mx-empty"><mx-icon name="folder_off" /><p>No access yet. Ask your team lead.</p></div></td></tr> }
                </tbody>
              </table>
            </div>
          </section>
        </div>
      </div>
    } @else {
      <div class="mx-empty"><span class="spinner"></span></div>
    }

    @if (totp(); as t) {
      <app-modal title="Set up an authenticator app" (closed)="totp.set(null)">
        <ol class="steps">
          <li>Open your authenticator app and add an account by scanning this code.</li>
        </ol>
        <div class="qr"><img [src]="t.qrPngDataUri" width="200" height="200" alt="QR code for the authenticator app" /></div>
        <p class="small text-secondary">Can't scan? Enter this key instead (time-based, 6 digits):</p>
        <div class="mx-row"><div class="mx-secret grow">{{ t.secret }}</div><button class="mx-icon-btn" title="Copy key" aria-label="Copy key" (click)="copy(t.secret)"><mx-icon name="content_copy" /></button></div>
        <ol class="steps" start="2"><li>Enter the 6-digit code the app shows.</li></ol>
        <div class="mx-field">
          <label for="totp-code">Code</label>
          <input id="totp-code" inputmode="numeric" autocomplete="one-time-code" maxlength="7" [(ngModel)]="code" (keydown.enter)="confirmTotp()" />
        </div>
        <ng-container footer>
          <button class="mx-btn secondary" (click)="totp.set(null)">Cancel</button>
          <button class="mx-btn primary" [disabled]="busy() || code.trim().length < 6" (click)="confirmTotp()">Turn on</button>
        </ng-container>
      </app-modal>
    }

    @if (codes(); as c) {
      <app-modal title="Save your recovery codes" (closed)="codes.set(null)">
        <div class="mx-alert warning mb-4"><mx-icon name="warning" /><div class="mx-alert-body">Each code works once. Keep them somewhere safe, like a password manager. They won't be shown again.</div></div>
        <ul class="mx-codes">@for (x of c; track x) { <li style="list-style:none">{{ x }}</li> }</ul>
        <ng-container footer>
          <button class="mx-btn secondary" (click)="copy(c.join('\\n'))"><mx-icon name="content_copy" />Copy</button>
          <button class="mx-btn secondary" (click)="download(c)"><mx-icon name="download" />Download</button>
          <button class="mx-btn primary" (click)="codes.set(null)">I've saved them</button>
        </ng-container>
      </app-modal>
    }

    @if (pwFor(); as purpose) {
      <app-modal [title]="purpose === 'codes' ? 'Make new recovery codes' : 'Remove the authenticator app'" (closed)="pwFor.set(null)">
        <p>{{ purpose === 'codes' ? 'Your old recovery codes stop working.' : 'You will no longer be asked for a code from the app.' }} Enter your password to continue.</p>
        <div class="mx-field"><label for="confirm-pw">Password</label><input id="confirm-pw" type="password" [(ngModel)]="confirmPw" autocomplete="current-password" (keydown.enter)="confirmPassword()" /></div>
        <ng-container footer>
          <button class="mx-btn secondary" (click)="pwFor.set(null)">Cancel</button>
          <button class="mx-btn" [class.danger]="purpose !== 'codes'" [class.primary]="purpose === 'codes'" [disabled]="busy() || !confirmPw" (click)="confirmPassword()">Continue</button>
        </ng-container>
      </app-modal>
    }

    @if (renaming(); as p) {
      <app-modal title="Rename passkey" (closed)="renaming.set(null)">
        <div class="mx-field"><label for="pk-name">Name</label><input id="pk-name" [(ngModel)]="newName" maxlength="100" (keydown.enter)="saveName(p)" /></div>
        <ng-container footer>
          <button class="mx-btn secondary" (click)="renaming.set(null)">Cancel</button>
          <button class="mx-btn primary" [disabled]="!newName.trim()" (click)="saveName(p)">Save</button>
        </ng-container>
      </app-modal>
    }
  `,
  styles: [`
    .factor { display: flex; align-items: flex-start; gap: 12px; }
    .factor > mx-icon { color: var(--mx-primary-text); margin-top: 2px; }
    .factor-title { font-weight: 600; color: var(--sa-text-primary); display: flex; align-items: center; gap: 8px; }
    .keys { margin-top: 8px; border: 1px solid var(--sa-border); border-radius: var(--mx-radius); }
    .keys li { flex-wrap: nowrap; padding: 8px 12px; }
    .qr { display: flex; justify-content: center; margin: 8px 0 12px; }
    .qr img { border-radius: 8px; background: #fff; padding: 8px; border: 1px solid var(--sa-border); }
    .steps { padding-left: 1.2rem; margin: 0 0 8px; }
  `],
})
export class AccountPage implements OnInit {
  protected brand = inject(Branding);
  private api = inject(Api);
  protected auth = inject(Auth);
  private toasts = inject(Toasts);
  private confirm = inject(Confirm);
  private route = inject(ActivatedRoute);
  readonly setup = input<string>();

  protected a = signal<MyAccount | null>(null);
  protected busy = signal(false);
  protected totp = signal<{ secret: string; otpAuthUri: string; qrPngDataUri: string } | null>(null);
  protected codes = signal<string[] | null>(null);
  protected pwFor = signal<'codes' | 'remove-totp' | null>(null);
  protected renaming = signal<PasskeyInfo | null>(null);
  protected canPasskey = passkeysSupported();
  protected current = '';
  protected newPw = '';
  protected code = '';
  protected confirmPw = '';
  protected newName = '';
  protected label = accessLabel;

  constructor() {
    usePageActions({ refresh: () => this.load() });
  }

  async ngOnInit() {
    await this.load();
    const frag = this.route.snapshot.fragment ?? (this.setup() ? 'mfa' : null);
    if (frag) setTimeout(() => document.getElementById(frag)?.scrollIntoView({ behavior: 'smooth', block: 'start' }));
    if (frag === 'password') setTimeout(() => document.getElementById('cur')?.focus(), 300);
  }

  async load() {
    try { this.a.set(await this.api.account()); } catch (e) { this.toasts.error(e); }
  }

  async changePassword() {
    await this.busyRun(async () => {
      await this.api.changeOwnPassword(this.current, this.newPw);
      this.current = '';
      this.newPw = '';
      this.toasts.ok('Password changed. Use it for SVN from now on.');
      await this.load();
    });
  }

  async startTotp() {
    await this.busyRun(async () => { this.code = ''; this.totp.set(await this.api.totpSetup()); });
  }

  async confirmTotp() {
    await this.busyRun(async () => {
      const r = await this.api.totpConfirm(this.code.replace(/\s/g, ''));
      this.totp.set(null);
      this.auth.set(r.me);
      this.codes.set(r.recoveryCodes);
      this.toasts.ok('Authenticator app turned on.');
      await this.load();
    });
  }

  async addPasskey() {
    this.busy.set(true);
    try {
      const { handle, options } = await this.api.passkeyRegisterOptions();
      const cred = (await navigator.credentials.create({ publicKey: toCreationOptions(options) })) as PublicKeyCredential | null;
      if (!cred) return;
      const r = await this.api.passkeyRegister(handle, attestationToJson(cred), '');
      this.auth.set(r.me);
      if (r.recoveryCodes) this.codes.set(r.recoveryCodes);
      this.toasts.ok(`Passkey "${r.passkey.name}" added.`);
      await this.load();
    } catch (e) {
      if (!isPasskeyCancel(e)) this.toasts.error(e);
    } finally {
      this.busy.set(false);
    }
  }

  rename(p: PasskeyInfo) { this.newName = p.name; this.renaming.set(p); }

  async saveName(p: PasskeyInfo) {
    try { await this.api.renamePasskey(p.id, this.newName.trim()); this.renaming.set(null); await this.load(); }
    catch (e) { this.toasts.error(e); }
  }

  async removePasskey(p: PasskeyInfo) {
    if (!(await this.confirm.ask({ title: `Remove "${p.name}"?`, body: 'You won\'t be able to sign in with this passkey any more.', confirmText: 'Remove', danger: true }))) return;
    try { await this.api.deletePasskey(p.id); this.toasts.ok('Passkey removed.'); await this.load(); }
    catch (e) { this.toasts.error(e); }
  }

  askPassword(purpose: 'codes' | 'remove-totp') { this.confirmPw = ''; this.pwFor.set(purpose); }

  async confirmPassword() {
    const purpose = this.pwFor();
    await this.busyRun(async () => {
      if (purpose === 'codes') this.codes.set((await this.api.newRecoveryCodes(this.confirmPw)).recoveryCodes);
      else { await this.api.totpRemove(this.confirmPw); this.toasts.ok('Authenticator app removed.'); }
      this.pwFor.set(null);
      await this.load();
    });
  }

  async copy(text: string) {
    if (await copyText(text)) this.toasts.ok('Copied.');
  }

  download(codes: string[]) {
    const blob = new Blob([`${this.brand.productName()} recovery codes for ${this.a()?.username}\r\nEach code works once.\r\n\r\n${codes.join('\r\n')}\r\n`], { type: 'text/plain' });
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = 'svnadmin-recovery-codes.txt';
    link.click();
  }

  private async busyRun(fn: () => Promise<void>) {
    this.busy.set(true);
    try { await fn(); } catch (e) { this.toasts.error(errorMessage(e)); } finally { this.busy.set(false); }
  }
}
