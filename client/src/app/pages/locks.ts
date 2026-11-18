import { DatePipe } from '@angular/common';
import { Component, OnInit, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Api } from '../core/api';
import { SvnLock } from '../core/models';
import { Confirm, Toasts } from '../core/ui';
import { usePageActions } from '../ui/command';
import { AgoPipe, downloadCsv } from '../ui/helpers';
import { MxIcon } from '../ui/icon';

/** "Get lock" locks across all repositories, with break-lock for stale ones. */
@Component({
  selector: 'app-locks',
  host: { class: 'page-fill' },
  imports: [FormsModule, MxIcon, AgoPipe, DatePipe],
  template: `
    <div class="mx-page-header">
      <div><h1>Locks</h1><p>Files locked with TortoiseSVN "Get lock". Break a lock when its owner has left or forgot to release it.</p></div>
      <div class="mx-actions">
        <button class="mx-btn secondary" (click)="export()"><mx-icon name="download" />Export</button>
        <button class="mx-btn secondary" (click)="load()" title="Refresh (r)"><mx-icon name="refresh" />Refresh</button>
      </div>
    </div>

    <div class="mx-toolbar">
      <label class="mx-search"><mx-icon name="search" [size]="18" />
        <input class="mx-input" data-page-search placeholder="Filter by file, owner, repository…" [ngModel]="search()" (ngModelChange)="search.set($event)" aria-label="Filter locks" /><kbd>/</kbd></label>
      <select class="mx-input" [ngModel]="age()" (ngModelChange)="age.set(+$event)" aria-label="Age">
        <option [ngValue]="0">Any age</option><option [ngValue]="7">Older than a week</option><option [ngValue]="30">Older than a month</option>
      </select>
      <span class="small text-secondary">{{ filtered().length }} of {{ locks().length }}</span>
    </div>

    <div class="mx-card flush fill">
      <div class="mx-table-wrap">
        <table class="mx-table">
          <thead><tr><th style="width: 36px"><input type="checkbox" aria-label="Select all" [checked]="allPicked()" (change)="pickAll()" /></th>
            <th>File</th><th>Owner</th><th>Locked</th><th>Comment</th><th class="right"></th></tr></thead>
          <tbody>
            @for (l of filtered(); track l.repo + l.path) {
              <tr [class.selected]="picked().has(key(l))">
                <td><input type="checkbox" [attr.aria-label]="'Select ' + l.path" [checked]="picked().has(key(l))" (change)="pick(l)" /></td>
                <td><div class="small text-secondary">{{ l.repo }}</div><code>{{ l.path }}</code></td>
                <td>{{ l.owner }}</td>
                <td class="small nowrap" [title]="l.createdAt ? (l.createdAt | date: 'medium') : ''" [class.text-warning]="isOld(l)">{{ l.createdAt | ago }}</td>
                <td class="small pre-line" style="max-width: 320px">{{ l.comment || '—' }}</td>
                <td class="right"><button class="mx-btn sm secondary" (click)="breakLocks([l])"><mx-icon name="lock_open" />Break</button></td>
              </tr>
            } @empty { <tr><td colspan="6"><div class="mx-empty"><mx-icon name="lock_open" /><h3>{{ loading() ? 'Reading locks…' : 'No locks' }}</h3></div></td></tr> }
          </tbody>
        </table>
      </div>
    </div>
    @if (picked().size) {
      <div class="mx-bulk"><strong>{{ picked().size }} selected</strong><span class="grow"></span>
        <button class="mx-btn sm danger" (click)="breakPicked()"><mx-icon name="lock_open" />Break locks</button>
        <button class="mx-btn sm ghost" (click)="picked.set(emptySet())">Clear</button></div>
    }
  `,
})
export class LocksPage implements OnInit {
  private api = inject(Api);
  private toasts = inject(Toasts);
  private confirm = inject(Confirm);

  protected locks = signal<SvnLock[]>([]);
  protected loading = signal(false);
  protected search = signal('');
  protected age = signal(0);
  protected picked = signal(new Set<string>());

  protected filtered = computed(() => {
    const q = this.search().trim().toLowerCase();
    const cutoff = this.age() ? Date.now() - this.age() * 86400_000 : null;
    return this.locks().filter((l) =>
      (!q || [l.repo, l.path, l.owner, l.comment].some((s) => s.toLowerCase().includes(q))) &&
      (!cutoff || (l.createdAt && Date.parse(l.createdAt) < cutoff)));
  });
  protected allPicked = computed(() => this.filtered().length > 0 && this.filtered().every((l) => this.picked().has(this.key(l))));

  constructor() { usePageActions({ refresh: () => this.load() }); }

  ngOnInit() { this.load(); }

  async load() {
    this.loading.set(true);
    try { this.locks.set(await this.api.locks()); this.picked.set(new Set()); } catch (e) { this.toasts.error(e); } finally { this.loading.set(false); }
  }

  key(l: SvnLock) { return l.repo + '\u0000' + l.path; }
  emptySet() { return new Set<string>(); }
  isOld(l: SvnLock) { return !!l.createdAt && Date.now() - Date.parse(l.createdAt) > 7 * 86400_000; }
  pick(l: SvnLock) { this.picked.update((s) => { const x = new Set(s); const k = this.key(l); if (x.has(k)) x.delete(k); else x.add(k); return x; }); }
  pickAll() { this.picked.set(this.allPicked() ? new Set() : new Set(this.filtered().map((l) => this.key(l)))); }

  breakPicked() { this.breakLocks(this.locks().filter((l) => this.picked().has(this.key(l)))); }

  async breakLocks(list: SvnLock[]) {
    const ok = await this.confirm.ask({
      title: list.length === 1 ? `Break the lock on ${list[0].path.split('/').pop()}?` : `Break ${list.length} locks?`,
      body: list.map((l) => `${l.repo}:${l.path} (${l.owner})`).join('\n') +
        '\n\nThe owner keeps any uncommitted changes, but their next commit of a broken-lock file may need them to lock it again.',
      confirmText: 'Break', danger: true });
    if (!ok) return;
    try {
      const r = await this.api.breakLocks(list.map((l) => ({ repo: l.repo, path: l.path })));
      const broken = r.reduce((s, x) => s + x.broken, 0);
      this.toasts.ok(`${broken} lock(s) broken.`);
      const errs = r.filter((x) => x.error).map((x) => `${x.repo}: ${x.error}`);
      if (errs.length) this.toasts.show('danger', errs.join('\n'));
      await this.load();
    } catch (e) { this.toasts.error(e); }
  }

  export() {
    downloadCsv(`svn-locks-${new Date().toISOString().slice(0, 10)}.csv`, ['Repository', 'Path', 'Owner', 'Locked at', 'Comment'],
      this.filtered().map((l) => [l.repo, l.path, l.owner, l.createdAt, l.comment]));
  }
}
