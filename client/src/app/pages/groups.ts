import { Component, OnInit, computed, inject, input, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Router, RouterLink } from '@angular/router';
import { Api } from '../core/api';
import { Group, User } from '../core/models';
import { Confirm, Toasts } from '../core/ui';
import { Modal } from '../shared/modal';
import { usePageActions } from '../ui/command';
import { downloadCsv } from '../ui/helpers';
import { MxIcon } from '../ui/icon';

interface GroupForm {
  original: string | null;
  name: string;
  description: string;
  users: Set<string>;
  groups: Set<string>;
  userFilter: string;
}

@Component({
  selector: 'app-groups',
  host: { class: 'page-fill' },
  imports: [FormsModule, Modal, RouterLink, MxIcon],
  template: `
    <div class="mx-page-header">
      <div><h1>Groups</h1><p>The <code>[groups]</code> section of the authz file. Groups can include other groups.</p></div>
      <div class="mx-actions">
        <button class="mx-btn secondary" (click)="exportCsv()"><mx-icon name="download" />Export</button>
        <button class="mx-btn primary" (click)="openNew()" title="New group (n)"><mx-icon name="group_add" />New group</button>
      </div>
    </div>

    <div class="mx-toolbar">
      <label class="mx-search"><mx-icon name="search" [size]="18" />
        <input class="mx-input" data-page-search placeholder="Search groups or members…" [ngModel]="search()" (ngModelChange)="search.set($event)" aria-label="Search groups" /><kbd>/</kbd></label>
      <span class="small text-secondary">{{ filtered().length }} of {{ groups().length }}</span>
    </div>

    <div class="mx-card flush fill">
      <div class="mx-table-wrap">
        <table class="mx-table">
          <thead><tr><th>Group</th><th>Members</th><th class="num">People</th><th class="num">Rules</th><th class="right">Actions</th></tr></thead>
          <tbody>
            @for (g of filtered(); track g.name) {
              <tr>
                <td>
                  <a href="" (click)="$event.preventDefault(); openEdit(g)"><strong>{{ g.name }}</strong></a>
                  @if (g.isAdminGroup) { <span class="mx-chip info" style="margin-left: 6px">SvnAdmin admins</span> }
                  @if (g.description) { <div class="small text-secondary">{{ g.description }}</div> }
                  @if (g.memberOf.length) { <div class="small text-secondary">Inside @for (p of g.memberOf; track p) { <code>&#64;{{ p }}</code> }</div> }
                </td>
                <td style="max-width: 460px">
                  @for (n of g.groups; track n) { <span class="mx-chip info" style="margin: 2px 4px 2px 0">&#64;{{ n }}</span> }
                  @for (u of g.users.slice(0, 12); track u) { <span class="mx-chip neutral" style="margin: 2px 4px 2px 0">{{ u }}</span> }
                  @if (g.users.length > 12) { <span class="small mx-muted">+{{ g.users.length - 12 }} more</span> }
                  @if (!g.users.length && !g.groups.length) { <span class="small mx-muted">empty</span> }
                </td>
                <td class="num" title="Including nested groups">{{ g.effectiveUserCount }}</td>
                <td class="num"><a routerLink="/permissions" [queryParams]="{ q: '@' + g.name }">{{ g.ruleCount }}</a></td>
                <td class="right"><div class="mx-row-actions" style="justify-content: flex-end">
                  <button class="mx-icon-btn" title="Edit" [attr.aria-label]="'Edit ' + g.name" (click)="openEdit(g)"><mx-icon name="edit" [size]="18" /></button>
                  <button class="mx-icon-btn danger" title="Delete" aria-label="Delete" [disabled]="g.isAdminGroup" (click)="remove(g)"><mx-icon name="delete" [size]="18" /></button>
                </div></td>
              </tr>
            } @empty { <tr><td colspan="5"><div class="mx-empty"><mx-icon name="group_off" /><h3>{{ loading() ? 'Loading…' : 'No groups match' }}</h3></div></td></tr> }
          </tbody>
        </table>
      </div>
    </div>

    @if (form(); as f) {
      <app-modal [title]="f.original ? 'Group ' + f.original : 'New group'" size="wide" (closed)="form.set(null)">
        <div class="mx-form cols-2">
          <div class="mx-field">
            <label for="g-name">Name</label>
            <input id="g-name" [(ngModel)]="f.name" [disabled]="isAdminGroup(f.original)" />
            @if (f.original && f.name !== f.original) { <span class="mx-help text-warning">Renaming updates every permission that uses this group.</span> }
          </div>
          <div class="mx-field"><label for="g-desc">Description</label><input id="g-desc" [(ngModel)]="f.description" /></div>
          <div class="mx-field">
            <div class="mx-row"><span class="mx-label grow">People ({{ f.users.size }})</span>
              <input class="mx-input sm" style="width: 160px" placeholder="Filter…" [(ngModel)]="f.userFilter" aria-label="Filter people" /></div>
            <div class="mx-checklist">
              @for (u of usersMatching(f.userFilter); track u.username) {
                <label class="mx-check"><input type="checkbox" [checked]="f.users.has(u.username)" (change)="toggle(f.users, u.username)" />
                  {{ u.username }} <span class="small mx-muted">{{ u.fullName }}</span> @if (!u.isEnabled) { <span class="mx-chip neutral">disabled</span> }</label>
              }
            </div>
          </div>
          <div class="mx-field">
            <span class="mx-label">Include groups ({{ f.groups.size }})</span>
            <div class="mx-checklist">
              @for (g of groups(); track g.name) {
                @if (g.name !== f.original) {
                  <label class="mx-check"><input type="checkbox" [checked]="f.groups.has(g.name)" (change)="toggle(f.groups, g.name)" />&#64;{{ g.name }}</label>
                }
              }
            </div>
            <span class="mx-help">Everyone in an included group is also in this one.</span>
          </div>
        </div>
        <ng-container footer>
          <button class="mx-btn secondary" (click)="form.set(null)">Cancel</button>
          <button class="mx-btn primary" [disabled]="busy() || !f.name.trim()" (click)="save(f)">{{ f.original ? 'Save' : 'Create group' }}</button>
        </ng-container>
      </app-modal>
    }
  `,
})
export class GroupsPage implements OnInit {
  private api = inject(Api);
  private toasts = inject(Toasts);
  private confirm = inject(Confirm);
  private router = inject(Router);
  readonly q = input<string>();
  readonly new = input<string>();

  protected groups = signal<Group[]>([]);
  protected users = signal<User[]>([]);
  protected loading = signal(false);
  protected busy = signal(false);
  protected form = signal<GroupForm | null>(null);
  protected search = signal('');

  protected filtered = computed(() => {
    const q = this.search().trim().toLowerCase().replace(/^@/, '');
    if (!q) return this.groups();
    return this.groups().filter((g) => [g.name, g.description, ...g.users, ...g.groups].some((s) => s.toLowerCase().includes(q)));
  });

  constructor() {
    usePageActions({ create: () => this.openNew(), refresh: () => this.load() });
  }

  async ngOnInit() {
    if (this.q()) this.search.set(this.q()!);
    await this.load();
    const exact = this.q() && this.groups().find((g) => g.name.toLowerCase() === this.q()!.toLowerCase());
    if (exact) this.openEdit(exact);
    if (this.new()) this.openNew();
    if (this.q() || this.new()) this.router.navigate([], { queryParams: {}, replaceUrl: true });
  }

  async load() {
    this.loading.set(true);
    try {
      const [g, u] = await Promise.all([this.api.groups(), this.api.users()]);
      this.groups.set(g);
      this.users.set(u);
    } catch (e) { this.toasts.error(e); } finally { this.loading.set(false); }
  }

  usersMatching(filter: string) {
    const q = filter.trim().toLowerCase();
    const list = q ? this.users().filter((u) => u.username.toLowerCase().includes(q) || u.fullName.toLowerCase().includes(q)) : this.users();
    return list;
  }

  isAdminGroup(name: string | null) { return !!name && !!this.groups().find((g) => g.name === name)?.isAdminGroup; }
  toggle(set: Set<string>, v: string) { if (set.has(v)) set.delete(v); else set.add(v); }

  openNew() { this.form.set({ original: null, name: '', description: '', users: new Set(), groups: new Set(), userFilter: '' }); }
  openEdit(g: Group) { this.form.set({ original: g.name, name: g.name, description: g.description, users: new Set(g.users), groups: new Set(g.groups), userFilter: '' }); }

  async save(f: GroupForm) {
    this.busy.set(true);
    const body = { name: f.name.trim(), description: f.description, users: [...f.users], groups: [...f.groups] };
    try {
      if (f.original) await this.api.updateGroup(f.original, body); else await this.api.createGroup(body);
      this.toasts.ok(`Group ${body.name} saved.`);
      this.form.set(null);
      await this.load();
    } catch (e) { this.toasts.error(e); } finally { this.busy.set(false); }
  }

  async remove(g: Group) {
    const ok = await this.confirm.ask({
      title: `Delete group ${g.name}?`,
      body: `${g.effectiveUserCount} people lose any access they had through this group.` +
        (g.ruleCount ? `\n${g.ruleCount} rule(s) using @${g.name} are deleted too.` : '') +
        (g.memberOf.length ? `\nIt's removed from ${g.memberOf.map((p) => '@' + p).join(', ')}.` : ''),
      confirmText: 'Delete group', danger: true, typeToConfirm: g.ruleCount ? g.name : undefined,
    });
    if (!ok) return;
    try {
      const r = await this.api.deleteGroup(g.name);
      this.toasts.ok(`Deleted ${g.name}${r.removedRules ? ` and ${r.removedRules} rule(s)` : ''}.`);
      await this.load();
    } catch (e) { this.toasts.error(e); }
  }

  exportCsv() {
    downloadCsv(`svn-groups-${new Date().toISOString().slice(0, 10)}.csv`, ['Group', 'Description', 'Users', 'Included groups', 'People (incl. nested)', 'Rules'],
      this.filtered().map((g) => [g.name, g.description, g.users.join('; '), g.groups.join('; '), g.effectiveUserCount, g.ruleCount]));
  }
}
