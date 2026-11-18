import { DatePipe } from '@angular/common';
import { Component, OnInit, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Api } from '../core/api';
import { LogEntry } from '../core/models';
import { Toasts } from '../core/ui';
import { usePageActions } from '../ui/command';
import { AgoPipe, downloadCsv } from '../ui/helpers';
import { MxIcon } from '../ui/icon';

@Component({
  selector: 'app-activity',
  host: { class: 'page-fill' },
  imports: [FormsModule, DatePipe, MxIcon, AgoPipe],
  template: `
    <div class="mx-page-header">
      <div><h1>Activity</h1><p>Recent commits across every repository.</p></div>
      <div class="mx-actions">
        <button class="mx-btn secondary" (click)="export()"><mx-icon name="download" />Export</button>
        <button class="mx-btn secondary" (click)="load()" [disabled]="loading()" title="Refresh (r)"><mx-icon name="refresh" />Refresh</button>
      </div>
    </div>

    <div class="mx-toolbar">
      <label class="mx-search"><mx-icon name="search" [size]="18" />
        <input class="mx-input" data-page-search placeholder="Filter repository, author, message…" [ngModel]="text()" (ngModelChange)="text.set($event)" aria-label="Filter" /><kbd>/</kbd></label>
      <select class="mx-input" [(ngModel)]="limit" (ngModelChange)="load()" aria-label="How many">
        <option [ngValue]="50">Last 50</option><option [ngValue]="100">Last 100</option><option [ngValue]="300">Last 300</option>
      </select>
      @if (author()) { <button class="mx-chip info" style="border: 0; cursor: pointer" (click)="author.set(''); load()">{{ author() }} <mx-icon name="close" [size]="14" /></button> }
    </div>

    @if (byAuthor().length > 1) {
      <div class="mx-row mb-4">
        @for (a of byAuthor(); track a.name) {
          <button class="mx-btn sm secondary" (click)="author.set(a.name); load()">{{ a.name }} <span class="mx-chip neutral">{{ a.count }}</span></button>
        }
      </div>
    }

    <div class="mx-card flush fill">
      <div class="mx-table-wrap">
        <table class="mx-table">
          <thead><tr><th>When</th><th>Repository</th><th>Rev</th><th>Author</th><th>Message</th></tr></thead>
          <tbody>
            @for (e of filtered(); track e.repo + e.revision) {
              <tr>
                <td class="small nowrap" [title]="e.date | date: 'medium'">{{ e.date | ago }}</td>
                <td>{{ e.repo }}</td><td><code>r{{ e.revision }}</code></td><td>{{ e.author }}</td>
                <td><div class="clamp-2">{{ e.message || '(no message)' }}</div>
                  @if (e.paths.length) { <details class="small"><summary class="text-secondary">{{ e.paths.length }} path(s)</summary>
                    @for (p of e.paths.slice(0, 50); track p.path) { <div><code>{{ p.action }}</code> {{ p.path }}</div> }</details> }</td>
              </tr>
            } @empty { <tr><td colspan="5"><div class="mx-empty"><mx-icon name="history" /><h3>{{ loading() ? 'Reading logs…' : 'No commits found' }}</h3></div></td></tr> }
          </tbody>
        </table>
      </div>
    </div>
  `,
})
export class ActivityPage implements OnInit {
  private api = inject(Api);
  private toasts = inject(Toasts);
  protected entries = signal<LogEntry[]>([]);
  protected loading = signal(false);
  protected author = signal('');
  protected text = signal('');
  protected limit = 50;

  protected filtered = computed(() => {
    const q = this.text().trim().toLowerCase();
    return q ? this.entries().filter((e) => [e.repo, e.author, e.message].some((s) => s.toLowerCase().includes(q))) : this.entries();
  });
  protected byAuthor = computed(() => {
    const m = new Map<string, number>();
    for (const e of this.entries()) m.set(e.author || '(none)', (m.get(e.author || '(none)') ?? 0) + 1);
    return [...m].map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count).slice(0, 12);
  });

  constructor() { usePageActions({ refresh: () => this.load() }); }
  ngOnInit() { this.load(); }

  async load() {
    this.loading.set(true);
    try { this.entries.set(await this.api.activity(this.limit, this.author() || undefined)); } catch (e) { this.toasts.error(e); } finally { this.loading.set(false); }
  }

  export() {
    downloadCsv(`svn-activity-${new Date().toISOString().slice(0, 10)}.csv`, ['Date', 'Repository', 'Revision', 'Author', 'Message', 'Paths'],
      this.filtered().map((e) => [e.date, e.repo, e.revision, e.author, e.message, e.paths.length]));
  }
}
