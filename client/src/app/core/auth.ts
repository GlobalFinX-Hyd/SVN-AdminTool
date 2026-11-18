import { HttpErrorResponse, HttpInterceptorFn } from '@angular/common/http';
import { Injectable, computed, inject, signal } from '@angular/core';
import { CanActivateFn, Router } from '@angular/router';
import { catchError, throwError } from 'rxjs';
import { Api } from './api';
import { LoginResult, Me } from './models';
import { assertionToJson, toRequestOptions } from './passkey';

@Injectable({ providedIn: 'root' })
export class Auth {
  private api = inject(Api);
  readonly me = signal<Me | null>(null);
  readonly isAdmin = computed(() => !!this.me()?.isAdmin);
  private checked = false;

  /** Asks the server once whether the session cookie is still valid. */
  async ensureLoaded(): Promise<boolean> {
    if (this.me()) return true;
    if (this.checked) return false;
    this.checked = true;
    try {
      this.me.set(await this.api.me());
      return true;
    } catch {
      return false;
    }
  }

  /** Step 1. Returns the server's answer: signed in, or a second factor is needed. */
  async login(username: string, password: string): Promise<LoginResult> {
    return this.accept(await this.api.login(username, password));
  }

  /** Step 2 (authenticator or recovery code). */
  async mfa(code: string, kind: 'totp' | 'recovery'): Promise<LoginResult> {
    return this.accept(await this.api.mfa(code, kind));
  }

  /** Username-less sign-in with a passkey. Throws the browser's error if the user cancels. */
  async passkey(): Promise<LoginResult> {
    const { handle, options } = await this.api.passkeyLoginOptions();
    const cred = (await navigator.credentials.get({ publicKey: toRequestOptions(options) })) as PublicKeyCredential | null;
    if (!cred) throw new DOMException('Cancelled', 'NotAllowedError');
    return this.accept(await this.api.passkeyLogin(handle, assertionToJson(cred)));
  }

  async logout() {
    try { await this.api.logout(); } finally { this.clear(); }
  }

  set(me: Me) { this.me.set(me); this.checked = true; }

  /** Re-reads the signed-in user's details (e.g. after email settings change). */
  async refresh() { try { this.me.set(await this.api.me()); } catch { /* keep current */ } }

  clear() {
    this.me.set(null);
    this.checked = true;
  }

  /** Where to land after sign-in. */
  home(): string {
    const me = this.me();
    if (!me) return '/login';
    if (me.isAdmin) return '/';
    return me.needsMfaSetup ? '/account?setup=1' : '/account';
  }

  private accept(r: LoginResult): LoginResult {
    if (r.status === 'ok') this.set(r.me);
    return r;
  }
}

/** Any signed-in user. */
export const authGuard: CanActivateFn = async (_route, state) => {
  const auth = inject(Auth);
  const router = inject(Router);
  return (await auth.ensureLoaded()) ? true : router.createUrlTree(['/login'], { queryParams: { next: state.url } });
};

/** Admin pages. Developers go to My account; admins without MFA are sent to set it up. */
export const adminGuard: CanActivateFn = async (_route, state) => {
  const auth = inject(Auth);
  const router = inject(Router);
  if (!(await auth.ensureLoaded())) return router.createUrlTree(['/login'], { queryParams: { next: state.url } });
  const me = auth.me()!;
  if (me.isAdmin) return true;
  return router.createUrlTree(['/account'], { queryParams: me.inAdminGroup ? { setup: 1 } : {} });
};

/** Session expired or revoked: drop to the login page. */
export const sessionInterceptor: HttpInterceptorFn = (req, next) => {
  const auth = inject(Auth);
  const router = inject(Router);
  return next(req).pipe(
    catchError((err: unknown) => {
      if (err instanceof HttpErrorResponse && err.status === 401 && !req.url.includes('/api/auth/') && !req.url.includes('/api/public/')) {
        auth.clear();
        router.navigate(['/login'], { queryParams: { next: router.url, expired: 1 } });
      }
      return throwError(() => err);
    }),
  );
};
