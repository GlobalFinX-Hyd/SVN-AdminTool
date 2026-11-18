import { Component, OnInit, computed, inject, input, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Router, RouterLink } from '@angular/router';
import { Api } from '../core/api';
import { Group, PrincipalType, Repo, Rule, Section, TreeEntry, User } from '../core/models';
import { Confirm, Toasts, accessLabel, principalLabel } from '../core/ui';
import { Modal } from '../shared/modal';
import { usePageActions } from '../ui/command';
import { MxIcon } from '../ui/icon';

interface SectionForm { isNew: boolean; repo: string; path: string; originalPath: string | null; rules: Rule[]; }
interface Browser { repo: string; path: string; entries: TreeEntry[] | null; }

@Component({
  selector: 'app-permissions',
  host: { class: 'page-fill' },
  imports: [FormsModule, Modal, MxIcon, RouterLink],
  template: `
    <div class="mx-page-header">
      <div><h1>Permissions</h1><p>Each card is one <code>[repo:/path]</code> section of the authz file.</p></div>
      <div class="mx-actions">
        <a class="mx-btn secondary" routerLink="/access-review" [queryParams]="repoFilter() ? { repo: repoFilter() } : {}"><mx-icon name="fact_check" />Who can access what</a>
        <button class="mx-btn primary" (click)="openNew()" title="Add path (n)"><mx-icon name="add_moderator" />Add path</button>
      </div>
    </div>

    <div class="mx-toolbar">
      <select class="mx-input" [ngModel]="repoFilter()" (ngModelChange)="setRepo($event)" aria-label="Repository">
        <option value="">All repositories</option>
        @for (r of activeRepos(); track r.name) { <option [value]="r.name">{{ r.name }}</option> }
      </select>
      <label class="mx-search"><mx-icon name="search" [size]="18" />
        <input class="mx-input" data-page-search placeholder="Filter by user, &#64;group or folder…" [ngModel]="query()" (ngModelChange)="query.set($event)" aria-label="Filter rules" /><kbd>/</kbd></label>
    </div>

    <div class="mx-alert info mb-4">
      <mx-icon name="lightbulb" />
      <div class="mx-alert-body">SVN uses the <strong>most specific folder</strong> with a rule for someone, and a repository's own rules beat "all repositories" rules on the same folder.
        Inside one card, people get <strong>everything any matching rule gives</strong>. "No access" on a sub-folder hides it.</div>
    </div>

    <div class="mx-stack fill-scroll">
      @for (s of visible(); track key(s)) {
        <section class="mx-card flush">
          <div class="mx-card-head">
            <h2><mx-icon [name]="s.repo ? 'folder' : 'public'" [size]="20" />{{ s.repo ?? 'All repositories' }} <code>{{ s.path }}</code></h2>
            <button class="mx-btn sm secondary" (click)="openEdit(s)"><mx-icon name="edit" />Edit</button>
            <button class="mx-icon-btn danger" title="Remove all rules for this folder" aria-label="Delete section" (click)="remove(s)"><mx-icon name="delete" [size]="18" /></button>
          </div>
          <ul class="mx-list">
            @for (r of s.rules; track $index) {
              <li class="mx-row" style="padding: 8px 16px; flex-wrap: nowrap">
                <mx-icon [name]="icon(r.principalType)" [size]="18" class="text-secondary" />
                <span class="grow">{{ plabel(r.principalType, r.principalName) }}</span>
                <span class="mx-chip access" [class]="'mx-chip access ' + (r.access === 'rw' ? 'access-rw' : r.access === 'r' ? 'access-r' : 'access-deny')">{{ alabel(r.access) }}</span>
              </li>
            }
          </ul>
        </section>
      } @empty {
        <div class="mx-card"><div class="mx-empty"><mx-icon name="shield" /><h3>{{ loading() ? 'Loading…' : 'No rules match' }}</h3><p>Use "Add path" to grant access.</p></div></div>
      }
    </div>

    @if (form(); as f) {
      <app-modal [title]="f.isNew ? 'Add permissions for a folder' : 'Edit permissions'" size="wide" (closed)="form.set(null)">
        <div class="mx-form cols-2">
          <div class="mx-field">
            <label for="s-repo">Repository</label>
            <select id="s-repo" [(ngModel)]="f.repo" [disabled]="!f.isNew">
              <option value="">All repositories</option>
              @for (r of activeRepos(); track r.name) { <option [value]="r.name">{{ r.name }}</option> }
            </select>
          </div>
          <div class="mx-field">
            <label for="s-path">Folder</label>
            <div class="mx-row" style="flex-wrap: nowrap">
              <input id="s-path" class="mx-input grow mono" [(ngModel)]="f.path" placeholder="/" />
              <button type="button" class="mx-btn secondary" [disabled]="!f.repo" (click)="browse(f.repo, f.path || '/')" [title]="f.repo ? 'Pick a folder' : 'Choose a repository first'"><mx-icon name="folder_open" />Browse</button>
            </div>
          </div>
        </div>

        @if (browser(); as b) {
          <div class="mx-card flush mt-4">
            <div class="mx-card-head" style="padding: 6px 12px">
              <button class="mx-icon-btn" [disabled]="b.path === '/'" (click)="browse(b.repo, parent(b.path))" aria-label="Up one folder"><mx-icon name="arrow_upward" [size]="18" /></button>
              <code class="grow truncate">{{ b.repo }}:{{ b.path }}</code>
              <button class="mx-btn sm primary" (click)="f.path = b.path; browser.set(null)">Use this folder</button>
              <button class="mx-btn sm ghost" (click)="browser.set(null)">Close</button>
            </div>
            <ul class="mx-list" style="max-height: 200px; overflow-y: auto">
              @if (!b.entries) { <li class="mx-muted small">Loading…</li> }
              @for (e of dirs(b); track e.name) {
                <li style="padding: 0"><button class="mx-menu-item" (click)="browse(b.repo, join(b.path, e.name))"><mx-icon name="folder" [size]="18" />{{ e.name }}</button></li>
              } @empty { @if (b.entries) { <li class="mx-muted small">No sub-folders.</li> } }
            </ul>
          </div>
        }

        <h3 class="mt-4" style="font-size: .9rem">Rules</h3>
        <div class="mx-table-wrap"><table class="mx-table compact">
          <thead><tr><th style="width: 30%">Who</th><th>Name</th><th style="width: 22%">Access</th><th></th></tr></thead>
          <tbody>
            @for (r of f.rules; track $index) {
              <tr>
                <td><select class="mx-input sm" style="width: 100%" [(ngModel)]="r.principalType" (ngModelChange)="r.principalName = defaultName($event)" aria-label="Who">
                  <option value="group">Group</option><option value="user">User</option><option value="authenticated">Any signed-in user</option>
                  <option value="all">Everyone (*)</option><option value="anonymous">Anonymous</option></select></td>
                <td>
                  @if (r.principalType === 'group') {
                    <select class="mx-input sm" style="width: 100%" [(ngModel)]="r.principalName" aria-label="Group">@for (g of groups(); track g.name) { <option [value]="g.name">&#64;{{ g.name }}</option> }</select>
                  } @else if (r.principalType === 'user') {
                    <select class="mx-input sm" style="width: 100%" [(ngModel)]="r.principalName" aria-label="User">@for (u of users(); track u.username) { <option [value]="u.username">{{ u.username }}{{ u.fullName ? ' (' + u.fullName + ')' : '' }}</option> }</select>
                  } @else { <span class="mx-muted">—</span> }
                </td>
                <td><select class="mx-input sm" style="width: 100%" [(ngModel)]="r.access" aria-label="Access"><option value="rw">Read/write</option><option value="r">Read</option><option value="">No access</option></select></td>
                <td class="right"><button class="mx-icon-btn danger" (click)="f.rules.splice($index, 1)" aria-label="Remove rule"><mx-icon name="close" [size]="18" /></button></td>
              </tr>
            }
          </tbody>
        </table></div>
        <div class="mt-4"><button class="mx-btn sm secondary" (click)="addRule(f)"><mx-icon name="add" />Add rule</button></div>
        @if (!f.rules.length) { <p class="small text-warning mt-4">Saving with no rules removes this folder's section.</p> }
        <ng-container footer>
          <button class="mx-btn secondary" (click)="form.set(null)">Cancel</button>
          <button class="mx-btn primary" [disabled]="busy()" (click)="save(f)">Save</button>
        </ng-container>
      </app-modal>
    }
  `,
})
export class PermissionsPage implements OnInit {
  private api = inject(Api);
  private toasts = inject(Toasts);
  private confirm = inject(Confirm);
  private router = inject(Router);
  readonly repo = input<string>();
  readonly q = input<string>();
  readonly new = input<string>();

  protected sections = signal<Section[]>([]);
  protected repos = signal<Repo[]>([]);
  protected groups = signal<Group[]>([]);
  protected users = signal<User[]>([]);
  protected loading = signal(false);
  protected busy = signal(false);
  protected form = signal<SectionForm | null>(null);
  protected browser = signal<Browser | null>(null);
  protected repoFilter = signal('');
  protected query = signal('');
  protected plabel = principalLabel;
  protected alabel = accessLabel;

  protected activeRepos = computed(() => this.repos().filter((r) => !r.isArchived));
  protected visible = computed(() => {
    const q = this.query().trim().toLowerCase();
    if (!q) return this.sections();
    return this.sections().filter((s) => s.path.toLowerCase().includes(q) ||
      s.rules.some((r) => principalLabel(r.principalType, r.principalName).toLowerCase().includes(q)));
  });

  constructor() {
    usePageActions({ create: () => this.openNew(), refresh: () => this.load() });
  }

  async ngOnInit() {
    this.repoFilter.set(this.repo() ?? '');
    this.query.set(this.q() ?? '');
    await Promise.all([this.loadLookups(), this.load()]);
    if (this.new()) { this.openNew(); this.router.navigate([], { queryParams: { new: null }, queryParamsHandling: 'merge', replaceUrl: true }); }
  }

  key(s: Section) { return (s.repo ?? '*') + ':' + s.path; }
  icon(t: PrincipalType) { return t === 'group' ? 'group' : t === 'user' ? 'person' : t === 'anonymous' ? 'visibility_off' : 'public'; }
  dirs(b: Browser) { return (b.entries ?? []).filter((e) => e.kind === 'dir'); }

  setRepo(name: string) {
    this.repoFilter.set(name);
    this.router.navigate([], { queryParams: { repo: name || null }, queryParamsHandling: 'merge', replaceUrl: true });
    this.load();
  }

  async loadLookups() {
    try {
      const [r, g, u] = await Promise.all([this.api.repos(), this.api.groups(), this.api.users()]);
      this.repos.set(r); this.groups.set(g); this.users.set(u.filter((x) => x.isEnabled));
    } catch (e) { this.toasts.error(e); }
  }

  async load() {
    this.loading.set(true);
    try { this.sections.set(await this.api.sections(this.repoFilter() || null)); } catch (e) { this.toasts.error(e); } finally { this.loading.set(false); }
  }

  defaultName(type: PrincipalType) {
    return type === 'group' ? this.groups()[0]?.name ?? '' : type === 'user' ? this.users()[0]?.username ?? '' : '';
  }

  openNew() {
    this.browser.set(null);
    const f: SectionForm = { isNew: true, repo: this.repoFilter(), path: '/', originalPath: null, rules: [] };
    this.addRule(f);
    this.form.set(f);
  }

  openEdit(s: Section) {
    this.browser.set(null);
    this.form.set({ isNew: false, repo: s.repo ?? '', path: s.path, originalPath: s.path, rules: s.rules.map((r) => ({ ...r })) });
  }

  addRule(f: SectionForm) { f.rules.push({ principalType: 'group', principalName: this.defaultName('group'), access: 'r' }); }
  parent(p: string) { const i = p.lastIndexOf('/'); return i <= 0 ? '/' : p.slice(0, i); }
  join(p: string, name: string) { return (p === '/' ? '' : p) + '/' + name; }

  async browse(repo: string, path: string) {
    path = '/' + path.replace(/^\/+|\/+$/g, '');
    this.browser.set({ repo, path, entries: null });
    try { this.browser.set({ repo, path, entries: await this.api.tree(repo, path) }); }
    catch (e) { this.toasts.error(e); this.browser.set(null); }
  }

  async save(f: SectionForm) {
    const norm = '/' + (f.path || '/').trim().replace(/\\/g, '/').replace(/^\/+|\/+$/g, '').replace(/\/{2,}/g, '/');
    if (f.isNew && this.sections().some((s) => (s.repo ?? '') === f.repo && s.path === norm)) {
      this.toasts.show('warning', 'That folder already has rules. Edit its card instead.');
      return;
    }
    this.busy.set(true);
    try {
      await this.api.saveSection({ repo: f.repo || null, path: f.path || '/', originalPath: f.originalPath, rules: f.rules });
      this.toasts.ok('Permissions saved. SVN uses them straight away.');
      this.form.set(null);
      await this.load();
    } catch (e) { this.toasts.error(e); } finally { this.busy.set(false); }
  }

  async remove(s: Section) {
    const ok = await this.confirm.ask({ title: 'Remove these permissions?',
      body: `All ${s.rules.length} rule(s) for ${s.repo ?? 'all repositories'} ${s.path} are removed. Access then comes from the parent folder's rules.`,
      confirmText: 'Remove', danger: true });
    if (!ok) return;
    try { await this.api.deleteSection(s.repo, s.path); this.toasts.ok('Removed.'); await this.load(); } catch (e) { this.toasts.error(e); }
  }
}
