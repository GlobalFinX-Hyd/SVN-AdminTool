import { ChangeDetectionStrategy, Component, ElementRef, HostListener, computed, effect, inject, signal, viewChild } from '@angular/core';
import { Router } from '@angular/router';
import { Api } from '../core/api';
import { Auth } from '../core/auth';
import { MxIcon } from './icon';
import { CommandItem, Commands } from './command';

const MAX_PAGES = 10;
const MAX_RECORDS = 8;
const SEQUENCE_MS = 1200;
const RECORD_CACHE_MS = 60_000;

/** "g then <key>" jumps. Kept here so the help dialog and the palette hints agree. */
export const GO_KEYS: { key: string; route: string; label: string; admin: boolean }[] = [
  { key: 'd', route: '/', label: 'Dashboard', admin: true },
  { key: 'u', route: '/users', label: 'Users', admin: true },
  { key: 'g', route: '/groups', label: 'Groups', admin: true },
  { key: 'r', route: '/repositories', label: 'Repositories', admin: true },
  { key: 'p', route: '/permissions', label: 'Permissions', admin: true },
  { key: 'v', route: '/access-review', label: 'Access review', admin: true },
  { key: 'l', route: '/locks', label: 'Locks', admin: true },
  { key: 'c', route: '/activity', label: 'Activity (commits)', admin: true },
  { key: 'b', route: '/backups', label: 'Config backups', admin: true },
  { key: 'a', route: '/audit', label: 'Audit log', admin: true },
  { key: 's', route: '/system', label: 'System', admin: true },
  { key: 'm', route: '/account', label: 'My account', admin: false },
];

interface RecordHit extends CommandItem { kind: 'user' | 'group' | 'repo'; }

/** Lower score = better; -1 = no match. Substring on label/group/keywords, else subsequence on label. */
function score(item: CommandItem, tokens: string[]): number {
  const label = item.label.toLowerCase();
  const hay = `${label} ${[item.group ?? '', ...(item.keywords ?? [])].join(' ').toLowerCase()}`;
  if (tokens.every((t) => hay.includes(t))) {
    const joined = tokens.join(' ');
    if (label.startsWith(joined)) return 0;
    if (label.includes(joined)) return 1;
    return tokens.every((t) => label.includes(t)) ? 2 : 3;
  }
  const compact = tokens.join('');
  let i = 0;
  for (const ch of label) if (ch === compact[i]) i++;
  return i === compact.length ? 4 : -1;
}

export function isTypingTarget(el: EventTarget | null): boolean {
  const e = el as HTMLElement | null;
  if (!e || !e.tagName) return false;
  return e.tagName === 'INPUT' || e.tagName === 'TEXTAREA' || e.tagName === 'SELECT' || e.isContentEditable;
}

/**
 * Global search + keyboard shortcuts.
 * Ctrl/Cmd+K: search pages, actions and records (users, groups, repositories).
 * ?: shortcut help. g then a letter: go to a page. /: focus the page's search box. n: new. r: refresh.
 */
@Component({
  selector: 'app-command-palette',
  imports: [MxIcon],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (cmd.isOpen()) {
      <div class="mcp-backdrop" (mousedown)="cmd.close()">
        <div class="mcp-dialog" role="dialog" aria-modal="true" aria-label="Search" (mousedown)="$event.stopPropagation()">
          <div class="mcp-search">
            <mx-icon class="mcp-search-icon" name="search" [size]="20" />
            <input #searchInput class="mcp-input" type="text" autocomplete="off" spellcheck="false"
                   [placeholder]="auth.isAdmin() ? 'Search pages, users, groups, repositories…' : 'Search…'" aria-label="Search"
                   role="combobox" aria-autocomplete="list" aria-expanded="true" aria-controls="cp-list"
                   [attr.aria-activedescendant]="total() ? 'cp-opt-' + active() : null"
                   [value]="query()" (input)="onQuery($any($event.target).value)" (keydown)="onKeydown($event)" />
            <kbd>Esc</kbd>
          </div>
          <ul class="mcp-list" id="cp-list" role="listbox" aria-label="Results">
            @if (pages().length && records().length) { <li class="mcp-heading" role="presentation">Pages and actions</li> }
            @for (item of pages(); track $index) {
              <li class="mcp-option" role="option" [id]="'cp-opt-' + $index" [class.active]="$index === active()"
                  [attr.aria-selected]="$index === active()" (mousemove)="active.set($index)" (click)="go(item)">
                <mx-icon class="mcp-opt-icon" [name]="item.icon || 'chevron_right'" [size]="20" />
                <span class="mcp-opt-label">{{ item.label }}</span>
                @if (item.hint) { <span class="mcp-opt-hint">@for (k of item.hint.split(' '); track $index) {<kbd>{{ k }}</kbd>}</span> }
                @else if (item.group) { <span class="mcp-opt-group">{{ item.group }}</span> }
              </li>
            }
            @if (records().length) { <li class="mcp-heading" role="presentation">Records</li> }
            @for (rec of records(); track rec.kind + rec.label; let i = $index) {
              <li class="mcp-option" role="option" [id]="'cp-opt-' + (pages().length + i)" [class.active]="pages().length + i === active()"
                  [attr.aria-selected]="pages().length + i === active()" (mousemove)="active.set(pages().length + i)" (click)="go(rec)">
                <mx-icon class="mcp-opt-icon" [name]="rec.icon!" [size]="20" />
                <span class="mcp-opt-label">{{ rec.label }}</span>
                <span class="mcp-opt-group">{{ rec.group }}</span>
              </li>
            }
            @if (!total()) { <li class="mcp-empty" role="presentation">{{ loading() ? 'Searching…' : 'No results' }}</li> }
          </ul>
          <div class="mcp-foot"><span><kbd>↑</kbd><kbd>↓</kbd> move</span><span><kbd>Enter</kbd> open</span><span><kbd>?</kbd> shortcuts</span></div>
        </div>
      </div>
    }

    @if (cmd.helpOpen()) {
      <div class="mcp-backdrop" (mousedown)="cmd.closeHelp()">
        <div #helpDialog class="mcp-dialog mcp-help" role="dialog" aria-modal="true" aria-labelledby="cp-help-title" tabindex="-1"
             (mousedown)="$event.stopPropagation()">
          <h2 id="cp-help-title" class="mcp-help-title">Keyboard shortcuts</h2>
          <dl class="mcp-shortcuts">
            <div><dt><kbd>{{ mod }}</kbd> + <kbd>K</kbd></dt><dd>Search pages, people, groups, repositories</dd></div>
            <div><dt><kbd>{{ mod }}</kbd> + <kbd>B</kbd></dt><dd>Collapse / expand the sidebar</dd></div>
            <div><dt><kbd>/</kbd></dt><dd>Search on this page</dd></div>
            <div><dt><kbd>n</kbd></dt><dd>New (user, group, repository… on that page)</dd></div>
            <div><dt><kbd>r</kbd></dt><dd>Refresh this page</dd></div>
            <div><dt><kbd>?</kbd></dt><dd>Show this help</dd></div>
            <div><dt><kbd>Esc</kbd></dt><dd>Close a dialog</dd></div>
          </dl>
          <h3 class="mcp-help-sub">Go to (press <kbd>g</kbd>, then…)</h3>
          <dl class="mcp-shortcuts cols">
            @for (g of goKeys(); track g.key) { <div><dt><kbd>g</kbd> <kbd>{{ g.key }}</kbd></dt><dd>{{ g.label }}</dd></div> }
          </dl>
          <button type="button" class="mx-btn secondary sm" (click)="cmd.closeHelp()">Close</button>
        </div>
      </div>
    }
  `,
  styles: [`
    :host { display: contents; }
    .mcp-backdrop { position: fixed; inset: 0; z-index: 10000; background: rgba(15, 23, 42, .45); display: flex; align-items: flex-start; justify-content: center; padding: 12vh 16px 16px; }
    .mcp-dialog { width: 100%; max-width: 600px; max-height: 70vh; display: flex; flex-direction: column; overflow: hidden;
      background: var(--sa-surface); color: var(--sa-text-primary); border: 1px solid var(--sa-border); border-radius: 12px;
      box-shadow: 0 20px 50px rgba(0, 0, 0, .3); outline: none; }
    .mcp-search { display: flex; align-items: center; gap: 10px; padding: 12px 16px; border-bottom: 1px solid var(--sa-border); }
    .mcp-search-icon { color: var(--sa-text-secondary); }
    .mcp-input { flex: 1; min-width: 0; border: 0; outline: 0; background: transparent; font: inherit; font-size: 16px; color: var(--sa-text-primary); }
    .mcp-input::placeholder { color: var(--sa-text-muted); }
    .mcp-list { list-style: none; margin: 0; padding: 6px; overflow-y: auto; }
    .mcp-option { display: flex; align-items: center; gap: 12px; padding: 9px 12px; border-radius: 8px; cursor: pointer; }
    .mcp-option.active { background: var(--sa-primary); color: var(--mx-on-primary); }
    .mcp-option.active .mcp-opt-icon, .mcp-option.active .mcp-opt-group { color: var(--mx-on-primary); opacity: .85; }
    .mcp-opt-icon { color: var(--sa-text-secondary); }
    .mcp-opt-label { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .mcp-opt-group { flex: none; font-size: 12px; color: var(--sa-text-secondary); max-width: 45%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .mcp-opt-hint { display: inline-flex; gap: 3px; }
    .mcp-heading { padding: 8px 12px 4px; font-size: 11px; font-weight: 600; letter-spacing: .04em; text-transform: uppercase; color: var(--sa-text-muted); }
    .mcp-empty { padding: 20px; text-align: center; color: var(--sa-text-secondary); }
    .mcp-foot { display: flex; gap: 16px; padding: 8px 16px; border-top: 1px solid var(--sa-border); font-size: 12px; color: var(--sa-text-muted); }
    .mcp-foot kbd { margin-right: 3px; }
    .mcp-help { max-width: 560px; padding: 20px 24px; overflow-y: auto; }
    .mcp-help-title { margin: 0 0 12px; font-size: 18px; font-weight: 600; }
    .mcp-help-sub { margin: 16px 0 6px; font-size: .875rem; font-weight: 600; color: var(--sa-text-secondary); }
    .mcp-shortcuts { margin: 0 0 12px; }
    .mcp-shortcuts > div { display: flex; justify-content: space-between; gap: 16px; padding: 7px 0; border-bottom: 1px solid var(--sa-border); }
    .mcp-shortcuts.cols { display: grid; grid-template-columns: 1fr 1fr; column-gap: 24px; }
    .mcp-shortcuts dt { margin: 0; white-space: nowrap; }
    .mcp-shortcuts dd { margin: 0; color: var(--sa-text-secondary); text-align: right; }
  `],
})
export class CommandPalette {
  protected readonly cmd = inject(Commands);
  protected readonly auth = inject(Auth);
  private readonly api = inject(Api);
  private readonly router = inject(Router);
  protected readonly mod = /Mac|iPhone|iPad/i.test(navigator.platform ?? '') ? '⌘' : 'Ctrl';

  protected readonly query = signal('');
  protected readonly active = signal(0);
  protected readonly loading = signal(false);
  private readonly allRecords = signal<RecordHit[]>([]);
  private loadedAt = 0;
  private pendingG = 0;
  private previousFocus: HTMLElement | null = null;

  private readonly input = viewChild<ElementRef<HTMLInputElement>>('searchInput');
  private readonly helpDialog = viewChild<ElementRef<HTMLElement>>('helpDialog');

  protected readonly goKeys = computed(() => GO_KEYS.filter((g) => !g.admin || this.auth.isAdmin()));

  protected readonly pages = computed(() => {
    const tokens = this.tokens();
    const items = this.cmd.items();
    if (!tokens.length) return items.slice(0, MAX_PAGES);
    return items.map((item, idx) => ({ item, idx, s: score(item, tokens) }))
      .filter((r) => r.s >= 0).sort((a, b) => a.s - b.s || a.idx - b.idx).slice(0, MAX_PAGES).map((r) => r.item);
  });

  protected readonly records = computed(() => {
    const tokens = this.tokens();
    if (!tokens.length || !this.auth.isAdmin()) return [];
    return this.allRecords().map((item, idx) => ({ item, idx, s: score(item, tokens) }))
      .filter((r) => r.s >= 0 && r.s < 4).sort((a, b) => a.s - b.s || a.idx - b.idx).slice(0, MAX_RECORDS).map((r) => r.item);
  });

  protected readonly total = computed(() => this.pages().length + this.records().length);
  private readonly tokens = computed(() => this.query().toLowerCase().split(/\s+/).filter(Boolean));

  constructor() {
    effect(() => {
      if (this.cmd.isOpen()) {
        this.remember();
        this.query.set('');
        this.active.set(0);
        this.loadRecords();
        setTimeout(() => this.input()?.nativeElement.focus());
      } else this.restore();
    });
    effect(() => {
      if (this.cmd.helpOpen()) { this.remember(); setTimeout(() => this.helpDialog()?.nativeElement.focus()); }
      else this.restore();
    });
    effect(() => { const n = this.total(); if (this.active() >= n) this.active.set(Math.max(0, n - 1)); });
  }

  /** Users, groups and repositories, fetched when the palette opens (cached for a minute). */
  private async loadRecords() {
    if (!this.auth.isAdmin() || Date.now() - this.loadedAt < RECORD_CACHE_MS) return;
    this.loading.set(true);
    try {
      const [users, groups, repos] = await Promise.all([this.api.users(), this.api.groups(), this.api.repos()]);
      this.allRecords.set([
        ...users.map((u): RecordHit => ({ kind: 'user', label: u.username, icon: u.isEnabled ? 'person' : 'person_off',
          group: [u.fullName, u.email].filter(Boolean).join(' · ') || 'User', keywords: [u.fullName, u.email, ...u.groups],
          route: '/users', queryParams: { q: u.username } })),
        ...groups.map((g): RecordHit => ({ kind: 'group', label: '@' + g.name, icon: 'group', group: g.description || `${g.effectiveUserCount} users`,
          keywords: [g.name, g.description], route: '/groups', queryParams: { q: g.name } })),
        ...repos.map((r): RecordHit => ({ kind: 'repo', label: r.name, icon: r.isArchived ? 'inventory_2' : 'folder_data',
          group: r.description || (r.isArchived ? 'Archived repository' : 'Repository'), keywords: [r.description],
          route: '/repositories', queryParams: { q: r.name } })),
      ]);
      this.loadedAt = Date.now();
    } catch { /* palette still works for pages */ } finally { this.loading.set(false); }
  }

  @HostListener('document:keydown', ['$event'])
  protected onDocumentKeydown(e: KeyboardEvent) {
    if (!this.cmd.items().length) return; // signed out
    const key = e.key.toLowerCase();

    if ((e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey && key === 'k') { e.preventDefault(); this.cmd.toggle(); return; }
    if (e.key === 'Escape') {
      if (this.cmd.isOpen()) { e.preventDefault(); this.cmd.close(); }
      else if (this.cmd.helpOpen()) { e.preventDefault(); this.cmd.closeHelp(); }
      return;
    }
    if (this.cmd.isOpen() || this.cmd.helpOpen()) return;
    if (e.ctrlKey || e.metaKey || e.altKey || isTypingTarget(e.target) || document.querySelector('.mx-modal, .mx-confirm-backdrop')) {
      this.pendingG = 0;
      return;
    }

    if (this.pendingG && Date.now() - this.pendingG < SEQUENCE_MS) {
      this.pendingG = 0;
      const target = this.goKeys().find((g) => g.key === key);
      if (target) { e.preventDefault(); this.router.navigateByUrl(target.route); }
      return;
    }
    switch (e.key) {
      case '?': e.preventDefault(); this.cmd.openHelp(); return;
      case 'g': this.pendingG = Date.now(); return;
      case '/': {
        const box = document.querySelector<HTMLInputElement>('[data-page-search]');
        if (box) { e.preventDefault(); box.focus(); box.select(); }
        return;
      }
      case 'n': { const f = this.cmd.page().create; if (f) { e.preventDefault(); f(); } return; }
      case 'r': { const f = this.cmd.page().refresh; if (f) { e.preventDefault(); f(); } return; }
    }
  }

  protected onQuery(v: string) { this.query.set(v); this.active.set(0); }

  protected onKeydown(e: KeyboardEvent) {
    const n = this.total();
    if (e.key === 'ArrowDown') { e.preventDefault(); if (n) this.active.set((this.active() + 1) % n); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); if (n) this.active.set((this.active() - 1 + n) % n); }
    else if (e.key === 'Enter') {
      e.preventDefault();
      const i = this.active();
      const item = i < this.pages().length ? this.pages()[i] : this.records()[i - this.pages().length];
      if (item) this.go(item);
    } else if (e.key === 'Tab') e.preventDefault();
  }

  protected go(item: CommandItem) {
    this.previousFocus = null;
    this.cmd.close();
    if (item.run) item.run();
    else if (item.route) this.router.navigate([item.route], { queryParams: item.queryParams });
  }

  private remember() {
    const el = document.activeElement as HTMLElement | null;
    if (el && el !== document.body && !this.previousFocus) this.previousFocus = el;
  }

  private restore() {
    if (this.cmd.isOpen() || this.cmd.helpOpen()) return;
    const el = this.previousFocus;
    this.previousFocus = null;
    if (el && document.contains(el)) setTimeout(() => el.focus());
  }
}
