import { DatePipe } from '@angular/common';
import { Component, OnInit, inject, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import { Api } from '../core/api';
import { Auth } from '../core/auth';
import { Dashboard } from '../core/models';
import { Toasts, formatBytes } from '../core/ui';
import { usePageActions } from '../ui/command';
import { AgoPipe } from '../ui/helpers';
import { MxIcon } from '../ui/icon';

@Component({
  selector: 'app-dashboard',
  imports: [RouterLink, DatePipe, MxIcon, AgoPipe],
  template: `
    <div class="mx-page-header">
      <div><h1>{{ greeting() }}, {{ (auth.me()?.fullName || auth.me()?.username || '').split(' ')[0] }}</h1><p>Your SVN server at a glance.</p></div>
      <div class="mx-actions"><button class="mx-btn secondary" (click)="load()" [disabled]="loading()" title="Refresh (r)"><mx-icon name="refresh" />Refresh</button></div>
    </div>

    @if (d(); as d) {
      <div class="mx-stack">
        @if (d.files.authz.changedOutsideTool || d.files.passwd.changedOutsideTool) {
          <div class="mx-alert warning" role="alert"><mx-icon name="warning" />
            <div class="mx-alert-body"><strong>The authz file was edited outside SvnAdmin.</strong> Changes are paused until you review it.</div>
            <div class="mx-alert-actions"><a class="mx-btn sm" routerLink="/system">Review</a></div></div>
        }
        @if (!d.backups.settings.enabled) {
          <div class="mx-alert warning"><mx-icon name="backup" />
            <div class="mx-alert-body">Daily config backups are off. The passwd, authz and SvnAdmin database aren't being snapshotted.</div>
            <div class="mx-alert-actions"><a class="mx-btn sm ghost" routerLink="/backups">Turn on</a></div></div>
        }

        <div class="mx-stats">
          <a class="mx-stat" routerLink="/users"><mx-icon name="person" /><div class="mx-stat-value">{{ d.users.enabled }}</div>
            <div class="mx-stat-label">Active users · {{ d.users.total - d.users.enabled }} disabled</div></a>
          <a class="mx-stat" routerLink="/repositories"><mx-icon name="folder_data" /><div class="mx-stat-value">{{ d.repos.active }}</div>
            <div class="mx-stat-label">Repositories · {{ bytes(d.repos.totalBytes) }}</div></a>
          <a class="mx-stat" routerLink="/groups"><mx-icon name="group" /><div class="mx-stat-value">{{ d.groups }}</div>
            <div class="mx-stat-label">Groups · {{ d.rules }} rules</div></a>
          <a class="mx-stat" routerLink="/backups"><mx-icon name="backup" />
            @if (d.backups.lastRun; as r) {
              <div class="mx-stat-value" [class.text-danger]="r.status === 'failed'">{{ r.status === 'ok' ? 'OK' : r.status === 'failed' ? 'Failed' : 'Running' }}</div>
              <div class="mx-stat-label">Last config backup {{ r.startedAt | ago }}</div>
            } @else { <div class="mx-stat-value mx-muted">—</div><div class="mx-stat-label">No config backups yet</div> }
          </a>
        </div>

        @if (attention(d); as items) {
          @if (items.length) {
            <section class="mx-card flush">
              <div class="mx-card-head"><h2><mx-icon name="checklist" />Needs attention</h2></div>
              <ul class="mx-list">
                @for (i of items; track i.text) {
                  <li class="mx-row" style="flex-wrap: nowrap"><mx-icon [name]="i.icon" [class]="i.cls" /><span class="grow">{{ i.text }}</span>
                    <a class="mx-btn sm ghost" [routerLink]="i.link" [queryParams]="i.params ?? {}">{{ i.action }}</a></li>
                }
              </ul>
            </section>
          }
        }

        <div class="mx-cols two">
          <section class="mx-card flush">
            <div class="mx-card-head"><h2><mx-icon name="history" />Latest commits</h2><a routerLink="/activity" class="small">All activity</a></div>
            <ul class="mx-list">
              @for (r of d.repos.recent; track r.name) {
                <li><div class="mx-row"><strong>{{ r.name }}</strong><span class="grow"></span>
                  <span class="small text-secondary" [title]="r.lastCommitAt | date: 'medium'">r{{ r.revision }} · {{ r.lastCommitAt | ago }}</span></div>
                  <div class="small text-secondary truncate">{{ r.lastAuthor }}: {{ r.lastMessage }}</div></li>
              } @empty { <li class="mx-muted">No commits yet.</li> }
            </ul>
          </section>
          <section class="mx-card flush">
            <div class="mx-card-head"><h2><mx-icon name="receipt_long" />Recent admin changes</h2><a routerLink="/audit" class="small">Audit log</a></div>
            <ul class="mx-list">
              @for (a of d.recentAudit; track a.id) {
                <li><div class="mx-row"><code>{{ a.action }}</code><span class="grow"></span><span class="small text-secondary" [title]="a.at | date: 'medium'">{{ a.at | ago }}</span></div>
                  <div class="small"><strong>{{ a.actor }}</strong> · {{ a.target }}</div></li>
              } @empty { <li class="mx-muted">No changes yet.</li> }
            </ul>
          </section>
        </div>
        <p class="small mx-muted">Tip: press <kbd>Ctrl</kbd> <kbd>K</kbd> to search anything, or <kbd>?</kbd> for all shortcuts.</p>
      </div>
    } @else if (loading()) {
      <div class="mx-stats">@for (i of [1, 2, 3, 4]; track i) { <div class="mx-stat"><span class="mx-skeleton" style="width: 40%; height: 24px"></span><span class="mx-skeleton" style="width: 70%; margin-top: 8px"></span></div> }</div>
    }
  `,
  styles: [`a.mx-stat { text-decoration: none !important; } a.mx-stat:hover { border-color: var(--mx-border-strong); }`],
})
export class DashboardPage implements OnInit {
  private api = inject(Api);
  protected auth = inject(Auth);
  private toasts = inject(Toasts);
  protected d = signal<Dashboard | null>(null);
  protected loading = signal(false);
  protected bytes = formatBytes;

  constructor() { usePageActions({ refresh: () => this.load() }); }

  ngOnInit() { this.load(); }

  async load() {
    this.loading.set(true);
    try { this.d.set(await this.api.dashboard()); } catch (e) { this.toasts.error(e); } finally { this.loading.set(false); }
  }

  greeting() { const h = new Date().getHours(); return h < 12 ? 'Good morning' : h < 18 ? 'Good afternoon' : 'Good evening'; }

  attention(d: Dashboard) {
    const items: { icon: string; cls: string; text: string; link: string; params?: Record<string, string>; action: string }[] = [];
    if (d.backups.failedLast24h) items.push({ icon: 'error', cls: 'text-danger', text: `${d.backups.failedLast24h} config backup(s) failed in the last 24 hours.`, link: '/backups', action: 'View' });
    if (d.repos.missing) items.push({ icon: 'help', cls: 'text-warning', text: `${d.repos.missing} repositor${d.repos.missing === 1 ? 'y is' : 'ies are'} missing on disk.`, link: '/repositories', action: 'View' });
    if (d.users.weakHashes) items.push({ icon: 'gpp_maybe', cls: 'text-warning', text: `${d.users.weakHashes} user(s) still have an old MD5/SHA1 password hash. Any password change upgrades it.`, link: '/users', params: { filter: 'weak' }, action: 'View' });
    if (d.users.stalePasswords) items.push({ icon: 'event_busy', cls: 'text-secondary', text: `${d.users.stalePasswords} user(s) haven't changed their password in a long time (or it's unknown).`, link: '/users', params: { filter: 'stale' }, action: 'View' });
    items.push({ icon: 'person_off', cls: 'text-secondary', text: 'Check for accounts nobody has used in months.', link: '/access-review', params: { tab: 'inactive' }, action: 'Review' });
    return items;
  }
}
