import { Component, inject, input, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Router, RouterLink } from '@angular/router';
import { errorMessage } from '../core/api';
import { Auth } from '../core/auth';
import { Branding } from '../core/branding';
import { LoginResult } from '../core/models';
import { isPasskeyCancel, passkeysSupported } from '../core/passkey';
import { Toasts } from '../core/ui';

/** Sign-in for admins and developers (centred card, passkey option, MFA step). */
@Component({
  selector: 'app-login',
  imports: [FormsModule, RouterLink],
  template: `
    <div class="login-page">
      <div class="mx-card login-card">
        <div class="brand">
          <img [src]="brand.logoUrl" class="brand-logo" alt="" />
          <h1>{{ brand.productName() }}</h1>
          <p>{{ step() === 'password' ? 'Sign in with your SVN username and password' : 'Two-step sign-in' }}</p>
        </div>

        @if (expired() && step() === 'password') { <div class="mx-alert warning mb-4">Your session ended. Please sign in again.</div> }

        @if (step() === 'password') {
          <form (ngSubmit)="submitPassword()" class="mx-form">
            <div class="mx-field">
              <label for="username">Username</label>
              <input id="username" name="username" [(ngModel)]="username" autocomplete="username webauthn" placeholder="Your SVN username" [disabled]="busy()" required />
            </div>
            <div class="mx-field">
              <label for="password">Password</label>
              <input id="password" name="password" type="password" [(ngModel)]="password" autocomplete="current-password" placeholder="Your SVN password" [disabled]="busy()" required />
            </div>
            @if (error()) { <div class="error-msg" role="alert">{{ error() }}</div> }
            <button type="submit" class="mx-btn primary btn-login" [disabled]="busy()">
              @if (busy()) { <span class="spinner"></span> Signing in… } @else { Sign in }
            </button>
            @if (canPasskey) {
              <div class="or-divider"><span>or</span></div>
              <button type="button" class="mx-btn secondary btn-login" (click)="signInWithPasskey()" [disabled]="busy()">
                <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
                  <circle cx="9" cy="7" r="4" fill="none" stroke="currentColor" stroke-width="2"/>
                  <path d="M2 21v-1a6 6 0 0 1 9.5-4.9" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
                  <circle cx="18" cy="12" r="3" fill="none" stroke="currentColor" stroke-width="2"/>
                  <path d="M18 15v6m0-2h2m-2-2h1.5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
                </svg>
                Sign in with a passkey
              </button>
            }
            <a routerLink="/account/forgot" class="forgot-link">Forgot password?</a>
          </form>
        } @else {
          <form (ngSubmit)="submitCode()" class="mx-form">
            <div class="mx-field">
              <label for="code">{{ kind() === 'totp' ? 'Code from your authenticator app' : 'Recovery code' }}</label>
              <input id="code" name="code" [(ngModel)]="code" [attr.inputmode]="kind() === 'totp' ? 'numeric' : 'text'"
                     autocomplete="one-time-code" [placeholder]="kind() === 'totp' ? '6-digit code' : 'xxxxx-xxxxx'" [disabled]="busy()" required autofocus />
              <small class="mx-help">{{ kind() === 'totp' ? 'Open your authenticator app and enter the current code for ' + brand.productName() + '.' : 'Each recovery code works once.' }}</small>
            </div>
            @if (error()) { <div class="error-msg" role="alert">{{ error() }}</div> }
            <button type="submit" class="mx-btn primary btn-login" [disabled]="busy() || !code">
              @if (busy()) { <span class="spinner"></span> Checking… } @else { Verify }
            </button>
            @if (mfaPasskey() && canPasskey) {
              <button type="button" class="mx-btn secondary btn-login" (click)="signInWithPasskey()" [disabled]="busy()">Use a passkey instead</button>
            }
            <div class="links">
              @if (mfaTotp()) {
                <button type="button" class="link-btn" (click)="switchKind()">{{ kind() === 'totp' ? 'Use a recovery code' : 'Use the authenticator app' }}</button>
              }
              <button type="button" class="link-btn" (click)="backToPassword()">Start over</button>
            </div>
          </form>
        }
        <p class="footer-note">Subversion administration</p>
      </div>
    </div>
  `,
  styles: [`
    .login-page { min-height: 100vh; display: flex; align-items: center; justify-content: center; padding: var(--mx-space-4); background: var(--sa-background); }
    .login-card { width: 100%; max-width: 420px; padding: 2rem; }
    .brand { display: flex; flex-direction: column; align-items: center; text-align: center; margin-bottom: 1.5rem; }
    .brand-logo { height: 56px; object-fit: contain; margin-bottom: 1rem; }
    .brand h1 { font-size: 1.35rem; font-weight: 700; margin: 0; }
    .brand p { font-size: .85rem; color: var(--sa-text-secondary); margin: 4px 0 0; }
    .error-msg { background: var(--mx-danger-bg); color: var(--mx-danger-fg); border-radius: var(--mx-radius); padding: .65rem .9rem; font-size: .875rem; }
    .btn-login { width: 100%; height: 44px; margin-left: 0 !important; }
    .forgot-link { display: block; text-align: center; font-size: .85rem; }
    .or-divider { display: flex; align-items: center; gap: .75rem; color: var(--sa-text-muted); font-size: .8rem; }
    .or-divider::before, .or-divider::after { content: ''; flex: 1; border-top: 1px solid var(--sa-border); }
    .links { display: flex; justify-content: space-between; }
    .link-btn { border: 0; background: none; padding: 0; color: var(--mx-primary-text); font-size: .85rem; cursor: pointer; }
    .link-btn:hover { text-decoration: underline; }
    .footer-note { text-align: center; color: var(--sa-text-muted); font-size: .75rem; margin: 1.5rem 0 0; }
  `],
})
export class LoginPage {
  protected brand = inject(Branding);
  private auth = inject(Auth);
  private router = inject(Router);
  private toasts = inject(Toasts);
  readonly next = input<string>();
  readonly expired = input<string>();

  protected canPasskey = passkeysSupported();
  protected username = '';
  protected password = '';
  protected code = '';
  protected step = signal<'password' | 'mfa'>('password');
  protected kind = signal<'totp' | 'recovery'>('totp');
  protected mfaTotp = signal(false);
  protected mfaPasskey = signal(false);
  protected busy = signal(false);
  protected error = signal('');

  async submitPassword() {
    if (!this.username || !this.password) { this.error.set('Enter your username and password.'); return; }
    await this.run(() => this.auth.login(this.username.trim(), this.password));
    this.password = '';
  }

  async submitCode() {
    await this.run(() => this.auth.mfa(this.code.trim(), this.kind()));
    this.code = '';
  }

  async signInWithPasskey() {
    this.busy.set(true);
    this.error.set('');
    try {
      this.done(await this.auth.passkey());
    } catch (e) {
      if (!isPasskeyCancel(e)) this.error.set(errorMessage(e));
    } finally {
      this.busy.set(false);
    }
  }

  switchKind() { this.kind.set(this.kind() === 'totp' ? 'recovery' : 'totp'); this.code = ''; this.error.set(''); }

  backToPassword() { this.step.set('password'); this.error.set(''); this.code = ''; }

  private async run(fn: () => Promise<LoginResult>) {
    this.busy.set(true);
    this.error.set('');
    try { this.done(await fn()); }
    catch (e) { this.error.set(errorMessage(e)); }
    finally { this.busy.set(false); }
  }

  private done(r: LoginResult) {
    if (r.status === 'mfa') {
      this.mfaTotp.set(r.totp);
      this.mfaPasskey.set(r.passkey);
      this.kind.set(r.totp ? 'totp' : 'recovery');
      this.step.set('mfa');
      return;
    }
    if (r.recoveryCodesLeft !== undefined && r.recoveryCodesLeft !== null && r.recoveryCodesLeft <= 3)
      this.toasts.show('warning', `You have ${r.recoveryCodesLeft} recovery code(s) left. Make new ones on My account.`);
    const next = this.next();
    const safe = next && next.startsWith('/') && !next.startsWith('//') && !next.startsWith('/login');
    this.router.navigateByUrl(safe && (r.me.isAdmin || next.startsWith('/account')) ? next : this.auth.home());
  }
}
