import { DatePipe } from '@angular/common';
import { Component, OnInit, computed, inject, input, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Router, RouterLink } from '@angular/router';
import { Api } from '../core/api';
import { Group, LogEntry, Repo, Rule } from '../core/models';
import { Confirm, Toasts, formatBytes } from '../core/ui';
import { Modal } from '../shared/modal';
import { usePageActions } from '../ui/command';
import { AgoPipe, copyText, downloadCsv, remembered } from '../ui/helpers';
import { MxIcon } from '../ui/icon';

interface CreateForm { name: string; description: string; createLayout: boolean; grants: Rule[]; }
const SHOW_ARCHIVED = remembered('repos.archived', false);

@Component({
  selector: 'app-repositories',
  host: { class: 'page-fill' },
  imports: [FormsModule, Modal, DatePipe, RouterLink, MxIcon, AgoPipe],
  template: `
    <div class="mx-page-header">
      <div><h1>Repositories</h1><p>Everything under SVNParentPath. Archiving moves a repository aside; nothing is ever deleted.</p></div>
      <div class="mx-actions">
        <button class="mx-btn secondary" (click)="exportCsv()"><mx-icon name="download" />Export</button>
        <button class="mx-btn primary" (click)="openCreate()" title="New repository (n)"><mx-icon name="create_new_folder" />New repository</button>
      </div>
    </div>

    <div class="mx-toolbar">
      <label class="mx-search"><mx-icon name="search" [size]="18" />
        <input class="mx-input" data-page-search placeholder="Search repositories…" [ngModel]="search()" (ngModelChange)="search.set($event)" aria-label="Search repositories" /><kbd>/</kbd></label>
      <label class="mx-check"><input type="checkbox" [ngModel]="showArchived()" (ngModelChange)="setArchived($event)" />Show archived</label>
      <span class="small text-secondary">{{ filtered().length }} shown · {{ bytes(totalSize()) }}</span>
    </div>

    <div class="mx-card flush fill">
      <div class="mx-table-wrap">
        <table class="mx-table">
          <thead><tr><th>Repository</th><th>Last commit</th><th class="num">Size</th><th class="right">Actions</th></tr></thead>
          <tbody>
            @for (r of filtered(); track r.name) {
              <tr [class.dim]="r.isArchived">
                <td>
                  <div class="mx-row" style="gap: 6px"><strong>{{ r.name }}</strong>
                    @if (r.isArchived) { <span class="mx-chip neutral">archived {{ r.archivedAt | ago }}</span> }
                    @if (r.missingOnDisk) { <span class="mx-chip warning" title="SvnAdmin has a record but the folder is gone">missing on disk</span> }</div>
                  @if (r.description) { <div class="small text-secondary">{{ r.description }}</div> }
                  @if (r.url && !r.isArchived) {
                    <div class="mx-row small" style="gap: 4px"><code class="truncate" style="max-width: 420px">{{ r.url }}</code>
                      <button class="mx-icon-btn" style="width: 26px; height: 26px" title="Copy checkout URL" aria-label="Copy checkout URL" (click)="copy(r.url)"><mx-icon name="content_copy" [size]="16" /></button></div>
                  }
                </td>
                <td class="small" style="max-width: 380px">
                  @if (r.lastCommitAt) {
                    <div><strong>r{{ r.revision }}</strong> by {{ r.lastAuthor }} · <span [title]="r.lastCommitAt | date: 'medium'">{{ r.lastCommitAt | ago }}</span></div>
                    <div class="text-secondary truncate">{{ r.lastMessage }}</div>
                  } @else if (!r.isArchived && !r.missingOnDisk) { <span class="mx-muted">No commits yet</span> }
                </td>
                <td class="num small nowrap">{{ bytes(r.sizeBytes) }}</td>
                <td class="right"><div class="mx-row-actions" style="justify-content: flex-end">
                  @if (!r.isArchived) {
                    <button class="mx-icon-btn" title="History" aria-label="History" (click)="openLog(r)" [disabled]="r.missingOnDisk"><mx-icon name="history" [size]="18" /></button>
                    <a class="mx-icon-btn" title="Permissions" aria-label="Permissions" routerLink="/permissions" [queryParams]="{ repo: r.name }"><mx-icon name="shield_lock" [size]="18" /></a>
                    <a class="mx-icon-btn" title="Who can access it" aria-label="Who can access it" routerLink="/access-review" [queryParams]="{ repo: r.name }"><mx-icon name="fact_check" [size]="18" /></a>
                    <button class="mx-icon-btn" title="Edit description" aria-label="Edit description" (click)="editDesc(r)"><mx-icon name="edit" [size]="18" /></button>
                    <button class="mx-icon-btn danger" title="Archive" aria-label="Archive" (click)="archive(r)" [disabled]="r.missingOnDisk"><mx-icon name="archive" [size]="18" /></button>
                  } @else {
                    <button class="mx-btn sm secondary" (click)="restore(r)"><mx-icon name="unarchive" />Restore</button>
                  }
                </div></td>
              </tr>
            } @empty { <tr><td colspan="4"><div class="mx-empty"><mx-icon name="folder_off" /><h3>{{ loading() ? 'Reading repositories…' : 'No repositories match' }}</h3></div></td></tr> }
          </tbody>
        </table>
      </div>
    </div>

    @if (createForm(); as f) {
      <app-modal title="New repository" size="wide" (closed)="createForm.set(null)">
        <div class="mx-form cols-2">
          <div class="mx-field">
            <label for="r-name">Name</label><input id="r-name" [(ngModel)]="f.name" autocomplete="off" />
            @if (baseUrl()) { <span class="mx-help">Checkout URL: {{ baseUrl() }}/{{ f.name || 'name' }}</span> }
          </div>
          <div class="mx-field"><label for="r-desc">Description</label><input id="r-desc" [(ngModel)]="f.description" /></div>
          <label class="mx-check span-all"><input type="checkbox" [(ngModel)]="f.createLayout" />Create <code>trunk</code>, <code>branches</code> and <code>tags</code> folders</label>
          <div class="mx-field span-all">
            <span class="mx-label">Who can use it</span>
            @for (g of f.grants; track $index) {
              <div class="mx-row" style="flex-wrap: nowrap">
                <select class="mx-input grow" [(ngModel)]="g.principalName" aria-label="Group">
                  @for (gr of groups(); track gr.name) { <option [value]="gr.name">&#64;{{ gr.name }}</option> }
                </select>
                <select class="mx-input" style="width: 150px" [(ngModel)]="g.access" aria-label="Access"><option value="rw">Read/write</option><option value="r">Read only</option></select>
                <button class="mx-icon-btn danger" (click)="f.grants.splice($index, 1)" aria-label="Remove"><mx-icon name="close" /></button>
              </div>
            }
            <div><button class="mx-btn sm secondary" (click)="addGrant(f)" [disabled]="!groups().length"><mx-icon name="add" />Add group</button></div>
            <span class="mx-help">Admins (&#64;{{ adminGroupHint() }}) and any all-repository rules already apply. Fine-tune folders on the Permissions page.</span>
          </div>
        </div>
        <ng-container footer>
          <button class="mx-btn secondary" (click)="createForm.set(null)">Cancel</button>
          <button class="mx-btn primary" [disabled]="busy() || !f.name.trim()" (click)="create(f)">@if (busy()) { <span class="spinner"></span> } Create repository</button>
        </ng-container>
      </app-modal>
    }

    @if (descFor(); as r) {
      <app-modal [title]="'Description of ' + r.name" (closed)="descFor.set(null)">
        <div class="mx-field"><label for="desc">Description</label><input id="desc" [(ngModel)]="descText" (keydown.enter)="saveDesc(r)" /></div>
        <ng-container footer><button class="mx-btn secondary" (click)="descFor.set(null)">Cancel</button><button class="mx-btn primary" (click)="saveDesc(r)">Save</button></ng-container>
      </app-modal>
    }

    @if (logFor(); as l) {
      <app-modal [title]="'History of ' + l.repo" size="xl" (closed)="logFor.set(null)">
        @if (!l.entries) { <div class="mx-empty"><span class="spinner"></span></div> }
        @else {
          <ul class="mx-list" style="border: 1px solid var(--sa-border); border-radius: var(--mx-radius)">
            @for (e of l.entries; track e.revision) {
              <li>
                <div class="mx-row"><strong>r{{ e.revision }}</strong><span>{{ e.author }}</span><span class="grow"></span><span class="small text-secondary" [title]="e.date | date: 'medium'">{{ e.date | ago }}</span></div>
                <div class="pre-line">{{ e.message || '(no message)' }}</div>
                @if (e.paths.length) {
                  <details class="small"><summary class="text-secondary">{{ e.paths.length }} changed path(s)</summary>
                    @for (p of e.paths; track p.path) { <div><code>{{ p.action }}</code> {{ p.path }}</div> }</details>
                }
              </li>
            } @empty { <li class="mx-muted">No commits.</li> }
          </ul>
        }
        <ng-container footer><button class="mx-btn primary" (click)="logFor.set(null)">Close</button></ng-container>
      </app-modal>
    }
  `,
})
export class RepositoriesPage implements OnInit {
  private api = inject(Api);
  private toasts = inject(Toasts);
  private confirm = inject(Confirm);
  private router = inject(Router);
  readonly q = input<string>();
  readonly new = input<string>();

  protected repos = signal<Repo[]>([]);
  protected groups = signal<Group[]>([]);
  protected loading = signal(false);
  protected busy = signal(false);
  protected createForm = signal<CreateForm | null>(null);
  protected descFor = signal<Repo | null>(null);
  protected logFor = signal<{ repo: string; entries: LogEntry[] | null } | null>(null);
  protected search = signal('');
  protected showArchived = signal(SHOW_ARCHIVED.get());
  protected descText = '';
  protected bytes = formatBytes;

  protected baseUrl = computed(() => this.repos().find((r) => r.url)?.url.replace(/\/[^/]*$/, '') ?? '');
  protected adminGroupHint = computed(() => this.groups().find((g) => g.isAdminGroup)?.name ?? 'admins');
  protected filtered = computed(() => {
    const q = this.search().trim().toLowerCase();
    return this.repos().filter((r) => (this.showArchived() || !r.isArchived) && (!q || r.name.toLowerCase().includes(q) || r.description.toLowerCase().includes(q)));
  });
  protected totalSize = computed(() => this.filtered().reduce((s, r) => s + (r.sizeBytes ?? 0), 0));

  constructor() {
    usePageActions({ create: () => this.openCreate(), refresh: () => this.load() });
  }

  async ngOnInit() {
    if (this.q()) { this.search.set(this.q()!); if (!this.showArchived()) this.showArchived.set(true); }
    await this.load();
    if (this.new()) this.openCreate();
    if (this.q() || this.new()) this.router.navigate([], { queryParams: {}, replaceUrl: true });
  }

  async load() {
    this.loading.set(true);
    try {
      const [r, g] = await Promise.all([this.api.repos(), this.api.groups()]);
      this.repos.set(r);
      this.groups.set(g);
    } catch (e) { this.toasts.error(e); } finally { this.loading.set(false); }
  }

  setArchived(v: boolean) { this.showArchived.set(v); SHOW_ARCHIVED.set(v); }

  openCreate() {
    const dev = this.groups().find((g) => /dev/i.test(g.name));
    this.createForm.set({ name: '', description: '', createLayout: true, grants: dev ? [{ principalType: 'group', principalName: dev.name, access: 'rw' }] : [] });
  }

  addGrant(f: CreateForm) {
    const used = new Set(f.grants.map((g) => g.principalName));
    const next = this.groups().find((g) => !used.has(g.name)) ?? this.groups()[0];
    f.grants.push({ principalType: 'group', principalName: next.name, access: 'r' });
  }

  async create(f: CreateForm) {
    this.busy.set(true);
    try {
      const r = await this.api.createRepo({ name: f.name.trim(), description: f.description, createLayout: f.createLayout, grants: f.grants });
      this.toasts.ok(`Repository ${r.name} created.${r.url ? '\n' + r.url : ''}`);
      this.createForm.set(null);
      await this.load();
    } catch (e) { this.toasts.error(e); } finally { this.busy.set(false); }
  }

  editDesc(r: Repo) { this.descText = r.description; this.descFor.set(r); }

  async saveDesc(r: Repo) {
    try { await this.api.updateRepo(r.name, this.descText); this.descFor.set(null); await this.load(); } catch (e) { this.toasts.error(e); }
  }

  async openLog(r: Repo) {
    this.logFor.set({ repo: r.name, entries: null });
    try { this.logFor.set({ repo: r.name, entries: await this.api.repoLog(r.name, 100) }); }
    catch (e) { this.toasts.error(e); this.logFor.set(null); }
  }

  async archive(r: Repo) {
    const ok = await this.confirm.ask({ title: `Archive ${r.name}?`,
      body: 'The folder moves to the archive folder, so nobody can check out or commit. Nothing is deleted: restore it here any time, with its permissions.',
      confirmText: 'Archive', danger: true, typeToConfirm: r.name });
    if (!ok) return;
    try { await this.api.archiveRepo(r.name); this.toasts.ok(`${r.name} archived.`); await this.load(); } catch (e) { this.toasts.error(e); }
  }

  async restore(r: Repo) {
    try { await this.api.restoreRepo(r.name); this.toasts.ok(`${r.name} restored.`); await this.load(); } catch (e) { this.toasts.error(e); }
  }

  async copy(text: string) { if (await copyText(text)) this.toasts.ok('Checkout URL copied.'); }

  exportCsv() {
    downloadCsv(`svn-repositories-${new Date().toISOString().slice(0, 10)}.csv`,
      ['Repository', 'Description', 'Archived', 'URL', 'Revision', 'Last author', 'Last commit', 'Size (bytes)'],
      this.filtered().map((r) => [r.name, r.description, r.isArchived, r.url, r.revision, r.lastAuthor, r.lastCommitAt, r.sizeBytes]));
  }
}
