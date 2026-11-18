import { DatePipe } from '@angular/common';
import { Component, OnInit, computed, inject, input, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Router, RouterLink } from '@angular/router';
import { Api } from '../core/api';
import { AccessMatrix, InactiveReport } from '../core/models';
import { Confirm, Toasts } from '../core/ui';
import { usePageActions } from '../ui/command';
import { AgoPipe, downloadCsv, remembered } from '../ui/helpers';
import { MxIcon } from '../ui/icon';

const TAB = remembered<'grid' | 'inactive'>('review.tab', 'grid');

/** Who can access what (computed exactly like SVN does), and accounts nobody seems to use any more. */
@Component({
  selector: 'app-access-review',
  host: { class: 'page-fill' },
  imports: [FormsModule, RouterLink, MxIcon, AgoPipe, DatePipe],
  template: `
    <div class="mx-page-header">
      <div><h1>Access review</h1><p>Effective access per person and repository, and accounts that look unused.</p></div>
      <div class="mx-actions">
        <button class="mx-btn secondary" (click)="tab() === 'grid' ? exportGrid() : exportInactive()"><mx-icon name="download" />Export</button>
      </div>
    </div>

    <div class="mx-tabs mb-4" role="tablist">
      <button class="mx-tab" role="tab" [class.active]="tab() === 'grid'" [attr.aria-selected]="tab() === 'grid'" (click)="setTab('grid')"><mx-icon name="grid_view" />Who can access what</button>
      <button class="mx-tab" role="tab" [class.active]="tab() === 'inactive'" [attr.aria-selected]="tab() === 'inactive'" (click)="setTab('inactive')"><mx-icon name="person_off" />Inactive accounts
        @if (inactive()?.users?.length) { <span class="mx-chip warning">{{ inactive()!.users.length }}</span> }</button>
    </div>

    @if (tab() === 'grid') {
      <div class="mx-toolbar">
        <label class="mx-search"><mx-icon name="search" [size]="18" />
          <input class="mx-input" data-page-search placeholder="Filter people or groups…" [ngModel]="search()" (ngModelChange)="search.set($event)" aria-label="Filter people" /><kbd>/</kbd></label>
        <div class="mx-field" style="flex-direction: row; align-items: center; gap: 6px">
          <label for="ar-path" class="small nowrap">Folder</label>
          <input id="ar-path" class="mx-input mono" style="width: 160px" [(ngModel)]="path" (keydown.enter)="loadGrid()" placeholder="/" />
          <button class="mx-btn sm secondary" (click)="loadGrid()">Check</button>
        </div>
        <label class="mx-check"><input type="checkbox" [(ngModel)]="onlyWithAccess" />Only people with access</label>
        <label class="mx-check"><input type="checkbox" [(ngModel)]="includeDisabled" (ngModelChange)="loadGrid()" />Include disabled</label>
      </div>
      <div class="small text-secondary mb-2">
        <span class="mx-chip access access-rw">RW</span> read/write · <span class="mx-chip access access-r">R</span> read · <span class="mx-chip access access-none">–</span> none ·
        <strong>*</strong> some sub-folders differ. Hover a cell to see which rule decided it.
      </div>
      <div class="mx-card flush fill">
        <div class="mx-table-wrap">
          <table class="mx-table compact grid">
            <thead><tr>
              <th class="sticky-col">Person</th>
              @for (r of visibleRepos(); track r) { <th class="repo-col" [title]="r"><a routerLink="/permissions" [queryParams]="{ repo: r }">{{ r }}</a></th> }
            </tr></thead>
            <tbody>
              @for (row of rows(); track row.username) {
                <tr [class.dim]="!row.isEnabled">
                  <td class="sticky-col"><a routerLink="/users" [queryParams]="{ q: row.username }">{{ row.username }}</a>
                    <div class="small mx-muted truncate" style="max-width: 220px">{{ row.groups.join(', ') }}</div></td>
                  @for (r of visibleRepos(); track r) {
                    <td class="cell">
                      <span class="mx-chip access" [class]="'mx-chip access ' + cls(row.repos[r].access)" [title]="'Decided by ' + row.repos[r].via">
                        {{ short(row.repos[r].access) }}@if (row.repos[r].varies) {*}</span>
                    </td>
                  }
                </tr>
              } @empty { <tr><td [attr.colspan]="visibleRepos().length + 1"><div class="mx-empty"><mx-icon name="person_search" /><h3>{{ loading() ? 'Working it out…' : 'Nobody matches' }}</h3></div></td></tr> }
            </tbody>
          </table>
        </div>
      </div>
    } @else {
      <div class="mx-toolbar">
        <label class="small" for="days">No commits and no sign-in for</label>
        <select id="days" class="mx-input" [(ngModel)]="days" (ngModelChange)="loadInactive()">
          <option [ngValue]="30">30 days</option><option [ngValue]="90">90 days</option><option [ngValue]="180">6 months</option><option [ngValue]="365">1 year</option>
        </select>
        <span class="grow"></span>
        <span class="small text-secondary">History scanned {{ inactive()?.lastScanUtc | ago: 'not yet' }}</span>
        <button class="mx-btn sm secondary" (click)="rescan()" [disabled]="busy()"><mx-icon name="refresh" />Scan now</button>
      </div>
      <div class="mx-card flush fill">
        <div class="mx-table-wrap">
          <table class="mx-table">
            <thead><tr><th style="width: 36px"><input type="checkbox" aria-label="Select all" [checked]="allPicked()" (change)="pickAll()" /></th>
              <th>Person</th><th>Last commit</th><th>Last sign-in here</th><th>Groups</th><th class="right"></th></tr></thead>
            <tbody>
              @for (u of inactive()?.users ?? []; track u.username) {
                <tr [class.selected]="picked().has(u.username)">
                  <td><input type="checkbox" [attr.aria-label]="'Select ' + u.username" [checked]="picked().has(u.username)" (change)="pick(u.username)" /></td>
                  <td><a routerLink="/users" [queryParams]="{ q: u.username }"><strong>{{ u.username }}</strong></a>
                    @if (u.isNew) { <span class="mx-chip info" style="margin-left: 6px" title="Created recently">new account</span> }
                    <div class="small text-secondary">{{ u.fullName }} {{ u.email }}</div></td>
                  <td class="small" [title]="u.lastCommitAt ? (u.lastCommitAt | date: 'medium') : ''">{{ u.lastCommitAt | ago: 'never' }}@if (u.lastRepo) { <span class="mx-muted"> in {{ u.lastRepo }}</span> }</td>
                  <td class="small">{{ u.lastLoginAt | ago: 'never' }}</td>
                  <td class="small">{{ u.groups.join(', ') || '—' }}</td>
                  <td class="right"><a class="mx-btn sm secondary" routerLink="/users" [queryParams]="{ q: u.username }">Review</a></td>
                </tr>
              } @empty { <tr><td colspan="6"><div class="mx-empty"><mx-icon name="celebration" /><h3>{{ loading() ? 'Loading…' : 'Everyone has been active' }}</h3></div></td></tr> }
            </tbody>
          </table>
        </div>
      </div>
      @if (picked().size) {
        <div class="mx-bulk"><strong>{{ picked().size }} selected</strong><span class="grow"></span>
          <button class="mx-btn sm danger" (click)="disablePicked()" [disabled]="busy()"><mx-icon name="person_off" />Disable</button>
          <button class="mx-btn sm ghost" (click)="clearPicked()">Clear</button></div>
      }
      <p class="small text-secondary mt-4">Commit history comes from <code>svn log</code>, read every hour. Disabling keeps the account and its history; it can be enabled again.</p>
    }
  `,
  styles: [`
    .grid .repo-col { text-align: center; max-width: 120px; overflow: hidden; text-overflow: ellipsis; }
    .grid .cell { text-align: center; padding: 4px 6px; }
    .grid .sticky-col { position: sticky; left: 0; z-index: 2; background: var(--sa-surface); min-width: 180px; border-right: 1px solid var(--sa-border); }
    .grid thead .sticky-col { z-index: 3; background: var(--mx-surface-2); }
  `],
})
export class AccessReviewPage implements OnInit {
  private api = inject(Api);
  private toasts = inject(Toasts);
  private confirm = inject(Confirm);
  private router = inject(Router);
  readonly repo = input<string>();
  readonly tabParam = input<string>(undefined, { alias: 'tab' });

  protected tab = signal(TAB.get());
  protected matrix = signal<AccessMatrix | null>(null);
  protected inactive = signal<InactiveReport | null>(null);
  protected loading = signal(false);
  protected busy = signal(false);
  protected search = signal('');
  protected picked = signal(new Set<string>());
  protected path = '/';
  protected includeDisabled = false;
  protected onlyWithAccessSig = signal(false);
  get onlyWithAccess() { return this.onlyWithAccessSig(); }
  set onlyWithAccess(v: boolean) { this.onlyWithAccessSig.set(v); }
  protected days = 180;
  private repoFocus = signal('');

  protected visibleRepos = computed(() => {
    const all = this.matrix()?.repos ?? [];
    return this.repoFocus() ? all.filter((r) => r.toLowerCase() === this.repoFocus().toLowerCase()) : all;
  });

  protected rows = computed(() => {
    const q = this.search().trim().toLowerCase().replace(/^@/, '');
    const repos = this.visibleRepos();
    return (this.matrix()?.rows ?? []).filter((r) =>
      (!q || r.username.toLowerCase().includes(q) || r.fullName.toLowerCase().includes(q) || r.groups.some((g) => g.toLowerCase().includes(q))) &&
      (!this.onlyWithAccessSig() || repos.some((x) => r.repos[x].access !== '')));
  });

  protected allPicked = computed(() => !!this.inactive()?.users.length && this.inactive()!.users.every((u) => this.picked().has(u.username)));

  constructor() {
    usePageActions({ refresh: () => (this.tab() === 'grid' ? this.loadGrid() : this.loadInactive()) });
  }

  async ngOnInit() {
    if (this.tabParam() === 'inactive' || this.tabParam() === 'grid') this.tab.set(this.tabParam() as 'grid' | 'inactive');
    if (this.repo()) { this.repoFocus.set(this.repo()!); this.tab.set('grid'); this.onlyWithAccessSig.set(true); }
    await Promise.all([this.loadGrid(), this.loadInactive()]);
  }

  setTab(t: 'grid' | 'inactive') {
    this.tab.set(t);
    TAB.set(t);
    if (this.repoFocus()) { this.repoFocus.set(''); this.router.navigate([], { queryParams: {}, replaceUrl: true }); }
  }

  async loadGrid() {
    this.loading.set(true);
    try { this.matrix.set(await this.api.accessMatrix(this.path || '/', this.includeDisabled)); } catch (e) { this.toasts.error(e); } finally { this.loading.set(false); }
  }

  async loadInactive() {
    try { this.inactive.set(await this.api.inactive(this.days)); this.picked.set(new Set()); } catch (e) { this.toasts.error(e); }
  }

  async rescan() {
    this.busy.set(true);
    try { await this.api.rescanActivity(); await this.loadInactive(); this.toasts.ok('Commit history scanned.'); } catch (e) { this.toasts.error(e); } finally { this.busy.set(false); }
  }

  cls(a: string) { return a === 'rw' ? 'access-rw' : a === 'r' ? 'access-r' : 'access-none'; }
  short(a: string) { return a === 'rw' ? 'RW' : a === 'r' ? 'R' : '–'; }

  pick(n: string) { this.picked.update((s) => { const x = new Set(s); if (x.has(n)) x.delete(n); else x.add(n); return x; }); }
  pickAll() { this.picked.set(this.allPicked() ? new Set() : new Set(this.inactive()?.users.map((u) => u.username))); }
  clearPicked() { this.picked.set(new Set()); }

  async disablePicked() {
    const names = [...this.picked()];
    if (!(await this.confirm.ask({ title: `Disable ${names.length} account(s)?`, body: names.join(', ') + '\n\nThey lose SVN access now. You can enable them again later.', confirmText: 'Disable', danger: true }))) return;
    this.busy.set(true);
    try { const r = await this.api.bulk(names, 'disable'); this.toasts.ok(`${r.done} account(s) disabled.`); await this.loadInactive(); } catch (e) { this.toasts.error(e); } finally { this.busy.set(false); }
  }

  exportGrid() {
    const repos = this.visibleRepos();
    downloadCsv(`svn-access-${new Date().toISOString().slice(0, 10)}.csv`, ['User', 'Enabled', 'Groups', ...repos],
      this.rows().map((r) => [r.username, r.isEnabled, r.groups.join('; '), ...repos.map((x) => this.short(r.repos[x].access) + (r.repos[x].varies ? '*' : ''))]));
  }

  exportInactive() {
    downloadCsv(`svn-inactive-${new Date().toISOString().slice(0, 10)}.csv`, ['User', 'Name', 'Email', 'Last commit', 'Last repo', 'Last sign-in', 'Groups'],
      (this.inactive()?.users ?? []).map((u) => [u.username, u.fullName, u.email, u.lastCommitAt, u.lastRepo, u.lastLoginAt, u.groups.join('; ')]));
  }
}
