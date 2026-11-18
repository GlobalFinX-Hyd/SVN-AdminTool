import { DatePipe } from '@angular/common';
import { Component, ElementRef, HostListener, OnInit, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Api, AuditFilter } from '../core/api';
import { AuditPage as Page } from '../core/models';
import { Toasts } from '../core/ui';
import { usePageActions } from '../ui/command';
import { AgoPipe } from '../ui/helpers';
import { MxIcon } from '../ui/icon';

type Range = 'any' | 'today' | '7d' | '30d' | 'month' | 'custom';

@Component({
  selector: 'app-audit',
  host: { class: 'page-fill' },
  imports: [FormsModule, DatePipe, MxIcon, AgoPipe],
  template: `
    <div class="mx-page-header">
      <div><h1>Audit log</h1><p>Every change and sign-in: who, what, when and from where.</p></div>
      <div class="mx-actions">
        <div class="mx-menu-wrap">
          <button class="mx-btn secondary" aria-haspopup="menu" [attr.aria-expanded]="dlOpen()" (click)="dlOpen.set(!dlOpen())">
            <mx-icon name="download" />Download<mx-icon name="expand_more" [size]="18" /></button>
          @if (dlOpen()) {
            <div class="mx-menu" role="menu" style="min-width: 300px" (click)="dlOpen.set(false)">
              <a class="mx-menu-item" role="menuitem" [href]="api.auditExportUrl(filter())" download>
                <mx-icon name="filter_alt" /><span class="grow">What's shown<div class="small mx-muted">{{ filterSummary() }} · {{ page()?.total ?? 0 }} entries</div></span></a>
              <a class="mx-menu-item" role="menuitem" [href]="api.auditExportUrl()" download>
                <mx-icon name="receipt_long" /><span class="grow">Everything<div class="small mx-muted">The whole audit log</div></span></a>
              <div class="mx-menu-sep"></div>
              <div class="small mx-muted" style="padding: 4px 12px 8px">CSV file: opens in Excel. Times are shown in server time and UTC.</div>
            </div>
          }
        </div>
      </div>
    </div>

    <div class="mx-toolbar">
      <label class="mx-search"><mx-icon name="search" [size]="18" />
        <input class="mx-input" data-page-search placeholder="Search who, what, details…" [(ngModel)]="search" (keydown.enter)="go(1)" aria-label="Search" /><kbd>/</kbd></label>
      <select class="mx-input" [(ngModel)]="action" (ngModelChange)="go(1)" aria-label="Kind">
        <option value="">All kinds</option><option value="user.">Users</option><option value="group.">Groups</option><option value="access.">Permissions</option>
        <option value="repo.">Repositories</option><option value="lock.">Locks</option><option value="mfa.">Two-step sign-in</option><option value="auth.">Sign-ins</option>
        <option value="backup.">Config backups</option><option value="audit.">Audit downloads</option><option value="import.">Imports</option><option value="authz.">Authz overwrite</option>
      </select>
      <select class="mx-input" [ngModel]="range()" (ngModelChange)="setRange($event)" aria-label="When">
        <option value="any">Any time</option><option value="today">Today</option><option value="7d">Last 7 days</option>
        <option value="30d">Last 30 days</option><option value="month">This month</option><option value="custom">Choose dates…</option>
      </select>
      @if (range() === 'custom') {
        <input class="mx-input" type="date" [(ngModel)]="fromDate" (ngModelChange)="go(1)" aria-label="From date" />
        <span class="small text-secondary">to</span>
        <input class="mx-input" type="date" [(ngModel)]="toDate" (ngModelChange)="go(1)" aria-label="To date" />
      }
      <button class="mx-btn secondary" (click)="go(1)"><mx-icon name="search" />Search</button>
      @if (filtered()) { <button class="mx-btn ghost" (click)="clear()">Clear</button> }
    </div>

    <div class="mx-card flush fill">
      <div class="mx-table-wrap">
        <table class="mx-table compact">
          <thead><tr><th>When</th><th>Who</th><th>What</th><th>Target</th><th>Details</th><th>IP</th></tr></thead>
          <tbody>
            @for (e of page()?.items ?? []; track e.id) {
              <tr>
                <td class="small nowrap" [title]="e.at | date: 'medium'">{{ e.at | ago }}</td>
                <td>{{ e.actor }}</td>
                <td><code [class.text-danger]="e.action.includes('failed') || e.action.includes('delete') || e.action.includes('offboard')">{{ e.action }}</code></td>
                <td>{{ e.target }}</td>
                <td class="small pre-line" style="max-width: 460px">{{ e.details }}</td>
                <td class="small mx-muted">{{ e.ip }}</td>
              </tr>
            } @empty { <tr><td colspan="6"><div class="mx-empty"><mx-icon name="receipt_long" /><h3>No entries</h3></div></td></tr> }
          </tbody>
        </table>
      </div>
      @if (page(); as p) {
        <div class="mx-table-footer">
          <span class="grow">{{ p.total }} entries</span>
          <button class="mx-btn sm secondary" [disabled]="p.page <= 1" (click)="go(p.page - 1)"><mx-icon name="chevron_left" />Newer</button>
          <span>Page {{ p.page }} of {{ pages() }}</span>
          <button class="mx-btn sm secondary" [disabled]="p.page >= pages()" (click)="go(p.page + 1)">Older<mx-icon name="chevron_right" /></button>
        </div>
      }
    </div>
  `,
})
export class AuditPage implements OnInit {
  protected api = inject(Api);
  private toasts = inject(Toasts);
  private host = inject(ElementRef<HTMLElement>);
  protected page = signal<Page | null>(null);
  protected dlOpen = signal(false);
  protected range = signal<Range>('any');
  protected search = '';
  protected action = '';
  protected fromDate = '';
  protected toDate = '';
  /** The filters the shown page was loaded with (so "What's shown" downloads exactly that). */
  protected filter = signal<AuditFilter>({});
  protected pages = computed(() => { const p = this.page(); return p ? Math.max(1, Math.ceil(p.total / p.pageSize)) : 1; });
  protected filtered = computed(() => Object.values(this.filter()).some((v) => !!v));

  protected filterSummary = computed(() => {
    const f = this.filter();
    const parts: string[] = [];
    if (f.action) parts.push(this.kindLabel(f.action));
    if (f.search) parts.push(`"${f.search}"`);
    const r = this.range();
    if (r !== 'any') parts.push(r === 'custom' ? `${this.fromDate || '…'} to ${this.toDate || '…'}`
      : { today: 'today', '7d': 'last 7 days', '30d': 'last 30 days', month: 'this month' }[r]);
    return parts.length ? parts.join(', ') : 'No filters';
  });

  constructor() { usePageActions({ refresh: () => this.go(this.page()?.page ?? 1) }); }
  ngOnInit() { this.go(1); }

  setRange(r: Range) {
    this.range.set(r);
    if (r === 'custom' && !this.fromDate) {
      const d = new Date();
      this.toDate = iso(d);
      d.setDate(d.getDate() - 30);
      this.fromDate = iso(d);
    }
    this.go(1);
  }

  clear() {
    this.search = '';
    this.action = '';
    this.range.set('any');
    this.go(1);
  }

  async go(n: number) {
    const f: AuditFilter = { search: this.search.trim() || undefined, action: this.action || undefined, ...this.dates() };
    this.filter.set(f);
    try { this.page.set(await this.api.audit(f, n, 50)); } catch (e) { this.toasts.error(e); }
  }

  /** Start/end instants for the chosen range, in the browser's local days. "to" is exclusive. */
  private dates(): { from?: string; to?: string } {
    const startOf = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate());
    const today = startOf(new Date());
    const days = (d: Date, n: number) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
    switch (this.range()) {
      case 'today': return { from: today.toISOString() };
      case '7d': return { from: days(today, -6).toISOString() };
      case '30d': return { from: days(today, -29).toISOString() };
      case 'month': return { from: new Date(today.getFullYear(), today.getMonth(), 1).toISOString() };
      case 'custom': return {
        from: this.fromDate ? new Date(this.fromDate + 'T00:00').toISOString() : undefined,
        to: this.toDate ? days(new Date(this.toDate + 'T00:00'), 1).toISOString() : undefined,
      };
      default: return {};
    }
  }

  private kindLabel(a: string) {
    return ({ 'user.': 'users', 'group.': 'groups', 'access.': 'permissions', 'repo.': 'repositories', 'lock.': 'locks', 'mfa.': 'two-step sign-in',
      'auth.': 'sign-ins', 'backup.': 'config backups', 'audit.': 'audit downloads', 'import.': 'imports', 'authz.': 'authz overwrite' } as Record<string, string>)[a] ?? a;
  }

  @HostListener('document:mousedown', ['$event'])
  protected onDocMouseDown(e: MouseEvent) {
    if (!this.dlOpen()) return;
    const wrap = (this.host.nativeElement as HTMLElement).querySelector('.mx-menu-wrap');
    if (wrap && !wrap.contains(e.target as Node)) this.dlOpen.set(false);
  }
}

function iso(d: Date) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
