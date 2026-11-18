import { Component, DestroyRef, ElementRef, HostListener, OnInit, computed, effect, inject, signal } from '@angular/core';
import { NavigationEnd, Router, RouterLink, RouterLinkActive, RouterOutlet } from '@angular/router';
import { filter } from 'rxjs';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { Auth } from './core/auth';
import { Branding } from './core/branding';
import { Theme } from './theme';
import { MxIcon } from './ui/icon';
import { CommandItem, Commands } from './ui/command';
import { CommandPalette, GO_KEYS, isTypingTarget } from './ui/command-palette';

interface NavItem { label: string; icon: string; route: string; exact?: boolean; }
interface NavGroup { label?: string; items: NavItem[]; }

const COLLAPSED_KEY = 'svnadmin.shell.collapsed';
const MOBILE_QUERY = '(max-width: 899.98px)';

/**
 * App shell: 56px header (brand, sidebar toggle, search, theme, user menu),
 * 256px sidebar (68px when collapsed, remembered; Ctrl+B), off-canvas drawer below 900px.
 */
@Component({
  selector: 'app-shell',
  imports: [RouterOutlet, RouterLink, RouterLinkActive, MxIcon, CommandPalette],
  template: `
    <div class="shell" [class.compact]="compact() && !mobile()" [class.mobile]="mobile()" [class.drawer-open]="drawerOpen()" (keydown.escape)="drawerOpen.set(false)">
      <header class="header">
        <a class="brand" routerLink="/" [attr.aria-label]="brand.productName() + ' home'">
          <img class="brand-logo" [src]="brand.logoUrl" alt="" />
          <span class="brand-name">{{ brand.productName() }}</span>
        </a>
        <button type="button" class="icon-btn sidebar-toggle" aria-controls="mx-sidebar" [attr.aria-expanded]="expanded()"
                [attr.aria-label]="toggleLabel()" [title]="toggleLabel() + ' (' + mod + '+B)'" (click)="toggleSidebar()">
          <mx-icon [name]="mobile() ? 'menu' : compact() ? 'left_panel_open' : 'left_panel_close'" />
        </button>

        <div class="header-actions"></div>

        <div class="header-end">
          <button type="button" class="search-pill" (click)="commands.open()" aria-label="Search">
            <mx-icon name="search" [size]="18" /><span>Search…</span><kbd>{{ mod }} K</kbd>
          </button>
          <button type="button" class="icon-btn search-icon" aria-label="Search" title="Search ({{ mod }}+K)" (click)="commands.open()"><mx-icon name="search" /></button>
          <button type="button" class="icon-btn" title="Keyboard shortcuts (?)" aria-label="Keyboard shortcuts" (click)="commands.openHelp()"><mx-icon name="keyboard" /></button>
          <button type="button" class="icon-btn" [attr.aria-label]="theme.dark() ? 'Switch to light mode' : 'Switch to dark mode'"
                  [title]="theme.dark() ? 'Light mode' : 'Dark mode'" (click)="theme.toggle()">
            <mx-icon [name]="theme.dark() ? 'light_mode' : 'dark_mode'" />
          </button>
          <div class="mx-menu-wrap">
            <button type="button" class="user-btn" aria-haspopup="menu" [attr.aria-expanded]="menuOpen()" (click)="menuOpen.set(!menuOpen())">
              <span class="avatar" aria-hidden="true">{{ initial() }}</span>
              <span class="user-name">{{ displayName() }}</span>
              <mx-icon name="expand_more" [size]="18" />
            </button>
            @if (menuOpen()) {
              <div class="mx-menu" role="menu" (click)="menuOpen.set(false)">
                <div class="menu-head" (click)="$event.stopPropagation()">
                  <div class="menu-name">{{ displayName() }}</div>
                  <div class="menu-email">{{ auth.me()?.email || auth.me()?.username }}</div>
                </div>
                <a class="mx-menu-item" role="menuitem" routerLink="/account"><mx-icon name="manage_accounts" />My account</a>
                <a class="mx-menu-item" role="menuitem" routerLink="/account" fragment="password"><mx-icon name="lock_reset" />Change password</a>
                <div class="mx-menu-sep"></div>
                <button type="button" class="mx-menu-item" role="menuitem" (click)="logout()"><mx-icon name="logout" />Sign out</button>
              </div>
            }
          </div>
        </div>
      </header>

      <div class="body">
        @if (mobile() && drawerOpen()) { <div class="backdrop" (click)="drawerOpen.set(false)" aria-hidden="true"></div> }
        <aside class="sidebar" id="mx-sidebar">
          <nav class="nav" aria-label="Main navigation">
            @for (g of groups(); track $index) {
              <div class="group" [class.has-label]="!!g.label">
                @if (g.label) { <div class="group-head static"><span class="group-title">{{ g.label }}</span></div> }
                <ul class="items">
                  @for (item of g.items; track item.route) {
                    <li>
                      <a class="nav-link" [routerLink]="item.route" routerLinkActive="active" ariaCurrentWhenActive="page"
                         [routerLinkActiveOptions]="{ exact: !!item.exact }" [title]="compact() && !mobile() ? item.label : ''">
                        <mx-icon [name]="item.icon" [size]="20" />
                        <span class="label">{{ item.label }}</span>
                      </a>
                    </li>
                  }
                </ul>
              </div>
            }
          </nav>
          <div class="side-foot"><button type="button" class="hint-btn" (click)="commands.openHelp()"><kbd>?</kbd><span class="label">Shortcuts</span></button></div>
        </aside>

        <main class="content" id="mx-main" tabindex="-1">
          @if (auth.me()?.needsMfaSetup && !onAccount()) {
            <div class="mx-alert warning mb-4" role="alert">
              <mx-icon name="shield_lock" />
              <div class="mx-alert-body"><strong>Set up two-step sign-in to use the admin pages.</strong> Add an authenticator app or a passkey on My account.</div>
              <div class="mx-alert-actions"><a class="mx-btn sm" routerLink="/account" [queryParams]="{ setup: 1 }">Set up now</a></div>
            </div>
          }
          <router-outlet />
        </main>
      </div>
    </div>
    <app-command-palette />
  `,
  styles: [`
    :host {
      --_sb-w: 256px; --_sb-w-compact: 68px; --_hdr-h: 56px;
      --_tint: color-mix(in srgb, var(--sa-primary) 12%, transparent);
      --_active-text: var(--mx-primary-text, var(--sa-primary));
      --_focus: 0 0 0 2px var(--sa-surface, #fff), 0 0 0 4px var(--sa-primary);
      display: block;
    }
    .shell { height: 100vh; display: flex; flex-direction: column; background: var(--shell-bg, var(--sa-background)); color: var(--sa-text-secondary); }
    .header { height: var(--_hdr-h); flex-shrink: 0; display: flex; align-items: center; gap: 12px; padding: 0 16px; background: var(--sa-surface); border-bottom: 1px solid var(--sa-border); z-index: 30; }
    .brand { text-decoration: none !important; }
    .header-actions { flex: 1; min-width: 0; display: flex; align-items: center; gap: 8px; margin-left: 12px; }
    .header-end { display: flex; align-items: center; gap: 4px; margin-left: auto; }
    .search-pill { display: inline-flex; align-items: center; gap: 8px; height: 36px; width: 280px; margin-right: 8px; padding: 0 8px 0 12px; cursor: pointer;
      border: 1px solid var(--sa-border); border-radius: 8px; background: var(--sa-background); color: var(--sa-text-muted); font-size: .875rem; }
    .search-pill span { flex: 1; text-align: left; }
    .search-pill:hover { border-color: var(--mx-border-strong); color: var(--sa-text-secondary); }
    .search-icon { display: none; }
    .body { flex: 1; min-height: 0; display: flex; position: relative; }
    .sidebar { width: var(--_sb-w); flex-shrink: 0; display: flex; flex-direction: column; background: var(--sa-surface); border-right: 1px solid var(--sa-border); transition: width .2s ease; }
    .nav { display: block; flex: 1; overflow-y: auto; padding: 12px 10px; margin: 0; }
    .group + .group { margin-top: 8px; }
    .items { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 2px; }
    .nav-link { position: relative; display: flex; align-items: center; gap: 12px; height: 40px; padding: 0 10px; border-radius: 8px;
      text-decoration: none !important; color: var(--sa-text-secondary); font-size: .875rem; font-weight: 500; }
    .nav-link:hover { background: var(--shell-item-hover); color: var(--sa-text-primary); }
    .nav-link.active { background: var(--_tint); color: var(--_active-text); font-weight: 600; }
    .nav-link.active::before { content: ''; position: absolute; left: 0; top: 8px; bottom: 8px; width: 3px; border-radius: 0 3px 3px 0; background: var(--_active-text); }
    .label { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .side-foot { padding: 8px 10px 12px; border-top: 1px solid var(--sa-border); }
    .hint-btn { display: flex; align-items: center; gap: 10px; width: 100%; height: 32px; padding: 0 10px; border: 0; border-radius: 8px; background: transparent; color: var(--sa-text-muted); font-size: .8125rem; cursor: pointer; }
    .hint-btn:hover { background: var(--shell-item-hover); color: var(--sa-text-secondary); }
    .content { flex: 1; min-width: 0; overflow-y: auto; padding: 24px; display: flex; flex-direction: column; }
    .content > .mx-alert { flex-shrink: 0; }
    .content:focus { outline: none; }
    .shell.compact .sidebar { width: var(--_sb-w-compact); }
    .shell.compact .label { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; flex: none; }
    .shell.compact .nav-link, .shell.compact .hint-btn { justify-content: center; padding: 0; }
    .shell.compact .group-head { height: 1px; padding: 0; margin: 8px; background: var(--sa-border); font-size: 0; }
    .shell.compact .group-head * { display: none; }
    .shell.mobile .sidebar { position: fixed; top: var(--_hdr-h); bottom: 0; left: 0; width: min(280px, 85vw); z-index: 50; transform: translateX(-100%); transition: transform .2s ease; }
    .shell.mobile.drawer-open .sidebar { transform: none; box-shadow: var(--sa-card-shadow); }
    .shell.mobile .backdrop { position: fixed; inset: var(--_hdr-h) 0 0 0; background: rgba(0, 0, 0, .4); z-index: 40; }
    .shell.mobile .content { padding: 16px; }
    .shell.mobile .user-name, .shell.mobile .brand-name { display: none; }
    .shell.mobile .header { padding: 0 10px; gap: 6px; }
    .shell.mobile .search-pill { display: none; }
    .shell.mobile .search-icon { display: inline-flex; }
    @media (prefers-reduced-motion: reduce) { .sidebar { transition: none; } }
  `],
})
export class Shell implements OnInit {
  protected auth = inject(Auth);
  protected brand = inject(Branding);
  protected theme = inject(Theme);
  protected commands = inject(Commands);
  private router = inject(Router);
  private host = inject(ElementRef<HTMLElement>);
  private destroyRef = inject(DestroyRef);

  protected readonly mod = /Mac|iPhone|iPad/i.test(navigator.platform ?? '') ? '⌘' : 'Ctrl';
  protected compact = signal(false);
  protected mobile = signal(false);
  protected drawerOpen = signal(false);
  protected menuOpen = signal(false);
  protected onAccount = signal(false);

  protected displayName = computed(() => this.auth.me()?.fullName || this.auth.me()?.username || '');
  protected initial = computed(() => (this.displayName().charAt(0) || '?').toUpperCase());
  protected expanded = computed(() => (this.mobile() ? this.drawerOpen() : !this.compact()));
  protected toggleLabel = computed(() => this.mobile()
    ? (this.drawerOpen() ? 'Close menu' : 'Open menu')
    : (this.compact() ? 'Expand sidebar' : 'Collapse sidebar'));

  protected groups = computed<NavGroup[]>(() => {
    const mine: NavGroup = { label: 'Me', items: [{ label: 'My account', icon: 'manage_accounts', route: '/account' }] };
    if (!this.auth.isAdmin()) return [mine];
    return [
      { items: [{ label: 'Dashboard', icon: 'space_dashboard', route: '/', exact: true }] },
      { label: 'People', items: [
        { label: 'Users', icon: 'person', route: '/users' },
        { label: 'Groups', icon: 'group', route: '/groups' },
        { label: 'Access review', icon: 'fact_check', route: '/access-review' },
      ] },
      { label: 'Repositories', items: [
        { label: 'Repositories', icon: 'folder_data', route: '/repositories' },
        { label: 'Permissions', icon: 'shield_lock', route: '/permissions' },
        { label: 'Locks', icon: 'lock', route: '/locks' },
        { label: 'Activity', icon: 'history', route: '/activity' },
      ] },
      { label: 'Operations', items: [
        { label: 'Config backups', icon: 'backup', route: '/backups' },
        { label: 'Audit log', icon: 'receipt_long', route: '/audit' },
        { label: 'System', icon: 'settings', route: '/system' },
      ] },
      mine,
    ];
  });

  constructor() {
    this.router.events.pipe(filter((e) => e instanceof NavigationEnd), takeUntilDestroyed(this.destroyRef)).subscribe(() => {
      this.drawerOpen.set(false);
      this.menuOpen.set(false);
      this.onAccount.set(this.router.url.startsWith('/account'));
    });
    this.onAccount.set(this.router.url.startsWith('/account'));
    // Everything the palette can reach: pages (with their g-shortcut) and actions.
    effect(() => this.commands.setItems(this.buildCommands()));
    this.destroyRef.onDestroy(() => this.commands.setItems([]));
  }

  ngOnInit() {
    try { this.compact.set(localStorage.getItem(COLLAPSED_KEY) === '1'); } catch { /* storage blocked */ }
    const mq = matchMedia(MOBILE_QUERY);
    this.mobile.set(mq.matches);
    const handler = (e: MediaQueryListEvent) => { this.mobile.set(e.matches); if (!e.matches) this.drawerOpen.set(false); };
    mq.addEventListener('change', handler);
    this.destroyRef.onDestroy(() => mq.removeEventListener('change', handler));
  }

  private buildCommands(): CommandItem[] {
    const admin = this.auth.isAdmin();
    const hint = (route: string) => { const g = GO_KEYS.find((x) => x.route === route); return g ? `g ${g.key}` : undefined; };
    const pages: CommandItem[] = this.groups().flatMap((g) => g.items.map((i) => ({
      label: i.label, icon: i.icon, route: i.route, group: g.label ?? 'Overview', hint: hint(i.route), keywords: ['go', 'page'],
    })));
    const go = (route: string, q?: Record<string, string>) => () => this.router.navigate([route], { queryParams: q });
    const actions: CommandItem[] = [
      ...(admin ? [
        { label: 'Add user', icon: 'person_add', group: 'Action', keywords: ['new', 'create', 'invite', 'account'], run: go('/users', { new: '1' }) },
        { label: 'Import users from CSV', icon: 'upload_file', group: 'Action', keywords: ['bulk', 'csv'], run: go('/users', { import: '1' }) },
        { label: 'New group', icon: 'group_add', group: 'Action', keywords: ['create'], run: go('/groups', { new: '1' }) },
        { label: 'New repository', icon: 'create_new_folder', group: 'Action', keywords: ['create', 'repo'], run: go('/repositories', { new: '1' }) },
        { label: 'Add permissions for a path', icon: 'add_moderator', group: 'Action', keywords: ['grant', 'access', 'authz'], run: go('/permissions', { new: '1' }) },
        { label: 'Find inactive users', icon: 'person_off', group: 'Action', keywords: ['dormant', 'stale', 'offboard'], run: go('/access-review', { tab: 'inactive' }) },
        { label: 'Email settings', icon: 'mail', group: 'Settings', keywords: ['smtp', 'mail server', 'email', 'test email'], run: () => this.router.navigate(['/system'], { fragment: 'email' }) },
        { label: 'Back up config now', icon: 'backup', group: 'Action', keywords: ['backup', 'snapshot', 'passwd', 'authz', 'config'], run: go('/backups', { run: '1' }) },
      ] : []),
      { label: 'Change my password', icon: 'lock_reset', group: 'Action', keywords: ['password'], run: () => this.router.navigate(['/account'], { fragment: 'password' }) },
      { label: 'Set up two-step sign-in', icon: 'shield_lock', group: 'Action', keywords: ['mfa', '2fa', 'totp', 'passkey', 'authenticator'], run: go('/account', { setup: '1' }) },
      { label: this.theme.dark() ? 'Switch to light mode' : 'Switch to dark mode', icon: this.theme.dark() ? 'light_mode' : 'dark_mode', group: 'Theme', keywords: ['theme', 'dark', 'light'], run: () => this.theme.toggle() },
      { label: 'Follow the system theme', icon: 'contrast', group: 'Theme', keywords: ['theme', 'auto', 'system'], run: () => this.theme.set('system') },
      { label: 'Collapse / expand sidebar', icon: 'left_panel_close', group: 'View', hint: `${this.mod} B`, run: () => this.toggleSidebar() },
      { label: 'Keyboard shortcuts', icon: 'keyboard', group: 'Help', hint: '?', run: () => this.commands.openHelp() },
      { label: 'Sign out', icon: 'logout', group: 'Account', keywords: ['logout', 'log out'], run: () => this.logout() },
    ];
    return [...pages, ...actions];
  }

  protected toggleSidebar() {
    if (this.mobile()) { this.drawerOpen.update((v) => !v); return; }
    const next = !this.compact();
    this.compact.set(next);
    try { localStorage.setItem(COLLAPSED_KEY, next ? '1' : '0'); } catch { /* storage blocked */ }
  }

  /** Ctrl/Cmd+B toggles the sidebar (ignored while typing). */
  @HostListener('document:keydown', ['$event'])
  protected onKeydown(e: KeyboardEvent) {
    if (!(e.ctrlKey || e.metaKey) || e.altKey || e.shiftKey || e.key.toLowerCase() !== 'b' || isTypingTarget(e.target)) return;
    e.preventDefault();
    this.toggleSidebar();
  }

  /** Close the user menu on outside click. */
  @HostListener('document:mousedown', ['$event'])
  protected onDocMouseDown(e: MouseEvent) {
    if (!this.menuOpen()) return;
    const wrap = (this.host.nativeElement as HTMLElement).querySelector('.mx-menu-wrap');
    if (wrap && !wrap.contains(e.target as Node)) this.menuOpen.set(false);
  }

  async logout() {
    await this.auth.logout();
    this.router.navigate(['/login']);
  }
}
