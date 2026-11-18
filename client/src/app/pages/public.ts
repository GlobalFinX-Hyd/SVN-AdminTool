import { Component, OnInit, inject, input, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { Api, errorMessage } from '../core/api';
import { generatePassword } from '../core/ui';
import { MxIcon } from '../ui/icon';
import { PasswordField } from '../ui/password-field';

const STYLES = `
  .pr-page { min-height: 100vh; display: flex; align-items: center; justify-content: center; padding: var(--mx-space-4); background: var(--sa-background); }
  .pr-card { width: 100%; max-width: 420px; padding: 2rem; }
  .pr-icon { width: 44px; height: 44px; display: inline-flex; align-items: center; justify-content: center; border: 1px solid var(--sa-border); border-radius: 10px; color: var(--mx-primary-text); margin-bottom: 1rem; }
  .pr-card h1 { font-size: 1.3rem; font-weight: 700; margin: 0 0 .35rem; }
  .pr-lead { color: var(--sa-text-secondary); font-size: .9rem; margin-bottom: 1.25rem; }
  .pr-btn { width: 100%; height: 44px; }
  .pr-back { display: block; text-align: center; margin-top: 1rem; font-size: .85rem; }
`;

/** Public "forgot password" page for users who can't sign in. */
@Component({
  selector: 'app-forgot',
  imports: [FormsModule, RouterLink, MxIcon],
  styles: [STYLES],
  template: `
    <div class="pr-page"><div class="mx-card pr-card">
      <span class="pr-icon"><mx-icon name="lock_reset" [size]="24" /></span>
      <h1>Forgot your SVN password?</h1>
      @if (!sent()) {
        <p class="pr-lead">Enter your username or email. If your account has an email address, we'll send a link to choose a new password.</p>
        <form class="mx-form" (ngSubmit)="submit()">
          <div class="mx-field">
            <label for="login">Username or email</label>
            <input id="login" name="login" [(ngModel)]="login" autocomplete="username" required autofocus />
          </div>
          @if (error()) { <div class="mx-alert danger">{{ error() }}</div> }
          <button class="mx-btn primary pr-btn" [disabled]="busy() || !login.trim()">@if (busy()) { <span class="spinner"></span> } Send reset link</button>
        </form>
      } @else {
        <div class="mx-alert success"><mx-icon name="mark_email_read" /><div class="mx-alert-body">{{ sent() }}</div></div>
        <p class="pr-lead mt-4">The link works once and expires soon. No email? Ask your IT team to reset your password.</p>
      }
      <a routerLink="/login" class="pr-back">Back to sign in</a>
    </div></div>
  `,
})
export class ForgotPage {
  private api = inject(Api);
  protected login = '';
  protected busy = signal(false);
  protected sent = signal('');
  protected error = signal('');

  async submit() {
    this.busy.set(true);
    this.error.set('');
    try { this.sent.set((await this.api.forgot(this.login.trim())).message); }
    catch (e) { this.error.set(errorMessage(e)); }
    finally { this.busy.set(false); }
  }
}

/** Landing page for emailed links: "welcome, set your password" and "reset your password". */
@Component({
  selector: 'app-set-password',
  imports: [FormsModule, RouterLink, MxIcon, PasswordField],
  styles: [STYLES],
  template: `
    <div class="pr-page"><div class="mx-card pr-card">
      @if (state() === 'loading') {
        <div class="mx-empty"><span class="spinner"></span><p>Checking your link…</p></div>
      } @else if (state() === 'invalid') {
        <span class="pr-icon"><mx-icon name="link_off" [size]="24" /></span>
        <h1>This link can't be used</h1>
        <p class="pr-lead">{{ error() }}</p>
        <a routerLink="/account/forgot" class="mx-btn primary pr-btn">Get a new link</a>
      } @else if (state() === 'done') {
        <span class="pr-icon"><mx-icon name="task_alt" [size]="24" /></span>
        <h1>Password set</h1>
        <p class="pr-lead">Use your new password for TortoiseSVN (it may ask for it the next time you update or commit) and to sign in here.</p>
        <a routerLink="/login" class="mx-btn primary pr-btn">Sign in</a>
      } @else {
        <span class="pr-icon"><mx-icon [name]="purpose() === 'welcome' ? 'waving_hand' : 'lock_reset'" [size]="24" /></span>
        <h1>{{ purpose() === 'welcome' ? 'Welcome, ' + (fullName() || username()) : 'Choose a new password' }}</h1>
        <p class="pr-lead">Your SVN username is <strong>{{ username() }}</strong>. Choose a password of at least {{ min() }} characters.</p>
        <form class="mx-form" (ngSubmit)="submit()">
          <app-password-field label="New password" [(value)]="password" [min]="min()" [username]="username()" />
          <div class="mx-field">
            <label for="pw2">Type it again</label>
            <input id="pw2" name="pw2" type="password" [(ngModel)]="confirm" autocomplete="new-password" />
            @if (confirm && confirm !== password) { <span class="mx-error">The two passwords don't match.</span> }
          </div>
          @if (error()) { <div class="mx-alert danger">{{ error() }}</div> }
          <button class="mx-btn primary pr-btn" [disabled]="busy() || !password || password !== confirm">Set password</button>
        </form>
      }
    </div></div>
  `,
})
export class SetPasswordPage implements OnInit {
  private api = inject(Api);
  readonly token = input<string>();
  protected state = signal<'loading' | 'ready' | 'invalid' | 'done'>('loading');
  protected username = signal('');
  protected fullName = signal('');
  protected purpose = signal<'reset' | 'welcome'>('reset');
  protected min = signal(10);
  protected busy = signal(false);
  protected error = signal('');
  protected password = '';
  protected confirm = '';
  protected gen = () => generatePassword();

  async ngOnInit() {
    try {
      const t = await this.api.checkLink(this.token() ?? '');
      this.username.set(t.username);
      this.fullName.set(t.fullName);
      this.purpose.set(t.purpose);
      this.min.set(t.minPasswordLength);
      this.state.set('ready');
    } catch (e) {
      this.error.set(errorMessage(e));
      this.state.set('invalid');
    }
  }

  async submit() {
    this.busy.set(true);
    this.error.set('');
    try { await this.api.useLink(this.token() ?? '', this.password); this.state.set('done'); }
    catch (e) { this.error.set(errorMessage(e)); }
    finally { this.busy.set(false); }
  }
}
