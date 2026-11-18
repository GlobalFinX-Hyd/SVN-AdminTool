import { DatePipe } from '@angular/common';
import { Component, OnInit, computed, inject, input, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Router } from '@angular/router';
import { Api, errorMessage } from '../core/api';
import { Auth } from '../core/auth';
import { Group, ImportRow, User, UserAccess } from '../core/models';
import { Confirm, Toasts, accessLabel, generatePassword } from '../core/ui';
import { Modal } from '../shared/modal';
import { usePageActions } from '../ui/command';
import { AgoPipe, copyText, downloadCsv, remembered } from '../ui/helpers';
import { MxIcon } from '../ui/icon';
import { PasswordField } from '../ui/password-field';

type Filter = 'all' | 'enabled' | 'disabled' | 'admins' | 'no-mfa' | 'invited' | 'weak' | 'stale' | 'locked';

interface EditForm {
  isNew: boolean;
  username: string;
  fullName: string;
  email: string;
  notes: string;
  isEnabled: boolean;
  password: string;
  sendWelcome: boolean;
  groups: Set<string>;
  user?: User;
}

const FILTER = remembered<Filter>('users.filter', 'enabled');

@Component({
  selector: 'app-users',
  host: { class: 'page-fill' },
  imports: [FormsModule, Modal, MxIcon, PasswordField, AgoPipe, DatePipe],
  template: `
    <div class="mx-page-header">
      <div><h1>Users</h1><p>SVN accounts. Changes reach Apache's passwd and authz files straight away.</p></div>
      <div class="mx-actions">
        <button class="mx-btn secondary" (click)="exportCsv()"><mx-icon name="download" />Export</button>
        <button class="mx-btn secondary" (click)="openImport()"><mx-icon name="upload_file" />Import CSV</button>
        <button class="mx-btn primary" (click)="openNew()" title="Add user (n)"><mx-icon name="person_add" />Add user</button>
      </div>
    </div>

    <div class="mx-toolbar">
      <label class="mx-search">
        <mx-icon name="search" [size]="18" />
        <input class="mx-input" data-page-search placeholder="Search name, email, group…" [ngModel]="search()" (ngModelChange)="search.set($event)" aria-label="Search users" />
        <kbd>/</kbd>
      </label>
      <select class="mx-input" [ngModel]="filter()" (ngModelChange)="setFilter($event)" aria-label="Filter">
        <option value="enabled">Enabled</option>
        <option value="all">Everyone</option>
        <option value="disabled">Disabled / offboarded</option>
        <option value="admins">Admins</option>
        <option value="no-mfa">No two-step sign-in</option>
        <option value="invited">Invite not accepted</option>
        <option value="locked">Locked out</option>
        <option value="weak">Old password hash</option>
        <option value="stale">Old passwords</option>
      </select>
      <span class="small text-secondary">{{ filtered().length }} of {{ users().length }}</span>
    </div>

    <div class="mx-card flush fill">
      <div class="mx-table-wrap">
        <table class="mx-table">
          <thead><tr>
            <th style="width: 36px"><input type="checkbox" class="mx-check" aria-label="Select all shown" [checked]="allSelected()" (change)="toggleAll()" /></th>
            <th>User</th><th>Groups</th><th>Password</th><th>Last commit</th><th class="right">Actions</th>
          </tr></thead>
          <tbody>
            @for (u of filtered(); track u.username) {
              <tr [class.dim]="!u.isEnabled" [class.selected]="selected().has(u.username)">
                <td><input type="checkbox" [attr.aria-label]="'Select ' + u.username" [checked]="selected().has(u.username)" (change)="toggle(u.username)" /></td>
                <td>
                  <div class="mx-row nowrap" style="gap: 6px">
                    <a href="" (click)="$event.preventDefault(); openEdit(u)"><strong>{{ u.username }}</strong></a>
                    @if (u.isAdmin) { <span class="mx-chip info" title="Can sign in to SvnAdmin">admin</span> }
                    @if (!u.isEnabled) { <span class="mx-chip neutral">{{ u.offboardedAt ? 'offboarded' : 'disabled' }}</span> }
                    @if (u.lockedUntil) { <span class="mx-chip danger">locked</span> }
                    @if (u.invitePending) { <span class="mx-chip warning" title="Welcome email sent; password not set yet">invited</span> }
                    @if (u.hasMfa) { <span title="Two-step sign-in on"><mx-icon name="verified_user" [size]="16" class="text-success" /></span> }
                  </div>
                  <div class="small text-secondary">{{ u.fullName }}@if (u.fullName && u.email) { · }{{ u.email }}</div>
                </td>
                <td>@for (g of u.groups; track g) { <span class="mx-chip neutral" style="margin: 2px 4px 2px 0">{{ g }}</span> } @empty { <span class="small mx-muted">none</span> }</td>
                <td class="small nowrap">
                  @if (u.invitePending) { <span class="mx-muted">not set yet</span> }
                  @else { <span [class.text-warning]="u.passwordStale" [title]="u.passwordChangedAt ? (u.passwordChangedAt | date: 'medium') : ''">{{ u.passwordChangedAt | ago: 'age unknown' }}</span> }
                  @if (u.weakHash) { <div><span class="mx-chip warning" title="MD5/SHA1 hash. Any password change upgrades it to bcrypt.">old hash</span></div> }
                </td>
                <td class="small nowrap" [title]="u.lastCommitAt ? (u.lastCommitAt | date: 'medium') : ''">{{ u.lastCommitAt | ago: 'never' }}</td>
                <td class="right">
                  <div class="mx-row-actions" style="justify-content: flex-end">
                    <button class="mx-icon-btn" title="Edit" [attr.aria-label]="'Edit ' + u.username" (click)="openEdit(u)"><mx-icon name="edit" [size]="18" /></button>
                    <button class="mx-icon-btn" title="Reset password" aria-label="Reset password" (click)="openReset(u)"><mx-icon name="key" [size]="18" /></button>
                    <button class="mx-icon-btn" title="What can they access?" aria-label="Access" (click)="openAccess(u)"><mx-icon name="policy" [size]="18" /></button>
                  </div>
                </td>
              </tr>
            } @empty {
              <tr><td colspan="6"><div class="mx-empty"><mx-icon name="person_search" /><h3>{{ loading() ? 'Loading…' : 'No users match' }}</h3>
                @if (!loading()) { <p>Try another search or filter.</p> }</div></td></tr>
            }
          </tbody>
        </table>
      </div>
    </div>

    @if (selected().size) {
      <div class="mx-bulk" role="region" aria-label="Bulk actions">
        <strong>{{ selected().size }} selected</strong>
        <select class="mx-input sm" [(ngModel)]="bulkGroup" aria-label="Group">
          <option value="">Choose a group…</option>
          @for (g of groups(); track g.name) { <option [value]="g.name">{{ g.name }}</option> }
        </select>
        <button class="mx-btn sm secondary" [disabled]="!bulkGroup" (click)="bulk('add-group')">Add to group</button>
        <button class="mx-btn sm secondary" [disabled]="!bulkGroup" (click)="bulk('remove-group')">Remove from group</button>
        <span class="grow"></span>
        @if (auth.me()?.emailEnabled) { <button class="mx-btn sm secondary" (click)="bulk('send-reset')"><mx-icon name="mail" />Email reset links</button> }
        <button class="mx-btn sm secondary" (click)="bulk('enable')">Enable</button>
        <button class="mx-btn sm danger" (click)="bulk('disable')">Disable</button>
        <button class="mx-btn sm ghost" (click)="clearSelection()">Clear</button>
      </div>
    }

    <!-- add / edit -->
    @if (form(); as f) {
      <app-modal [title]="f.isNew ? 'Add user' : f.username" size="wide" (closed)="form.set(null)">
        <div class="mx-form cols-2">
          <div class="mx-field">
            <label for="f-user">Username</label>
            <input id="f-user" [(ngModel)]="f.username" [disabled]="!f.isNew" autocomplete="off" />
            @if (f.isNew) { <span class="mx-help">Letters, numbers, dot, underscore, hyphen. Can't be changed later.</span> }
          </div>
          <div class="mx-field"><label for="f-name">Full name</label><input id="f-name" [(ngModel)]="f.fullName" /></div>
          <div class="mx-field">
            <label for="f-email">Email</label><input id="f-email" type="email" [(ngModel)]="f.email" />
            <span class="mx-help">Needed for welcome and password-reset emails.</span>
          </div>
          @if (f.isNew) {
            <div class="mx-field">
              <span class="mx-label">First password</span>
              <div class="mx-segmented" role="group">
                <button type="button" [class.active]="f.sendWelcome" [disabled]="!auth.me()?.emailEnabled" (click)="f.sendWelcome = true"
                        [title]="auth.me()?.emailEnabled ? '' : 'Email is not set up'"><mx-icon name="mail" [size]="16" />Email a link</button>
                <button type="button" [class.active]="!f.sendWelcome" (click)="f.sendWelcome = false"><mx-icon name="password" [size]="16" />Set it now</button>
              </div>
              <span class="mx-help">{{ f.sendWelcome ? 'They choose their own password from a link (valid 72 hours).' : 'You give them the password yourself.' }}</span>
            </div>
            @if (!f.sendWelcome) { <div class="span-all"><app-password-field label="Password" [(value)]="f.password" [min]="minPw()" [username]="f.username" /></div> }
          } @else {
            <div class="mx-field">
              <span class="mx-label">Status</span>
              <label class="mx-check"><input type="checkbox" [(ngModel)]="f.isEnabled" [disabled]="f.username === me()" />Enabled (can use SVN)</label>
            </div>
          }
          <div class="mx-field span-all"><label for="f-notes">Notes</label><textarea id="f-notes" rows="2" [(ngModel)]="f.notes" placeholder="e.g. contractor until March"></textarea></div>
          <div class="mx-field span-all">
            <span class="mx-label">Groups</span>
            <div class="mx-checklist cols">
              @for (g of groups(); track g.name) {
                <label class="mx-check"><input type="checkbox" [checked]="f.groups.has(g.name)" (change)="toggleIn(f.groups, g.name)" />{{ g.name }}
                  @if (g.isAdminGroup) { <mx-icon name="star" [size]="14" class="text-warning" title="Admin group" /> }</label>
              } @empty { <span class="small mx-muted">No groups yet.</span> }
            </div>
          </div>
          @if (!f.isNew && f.user; as u) {
            <div class="span-all small text-secondary">
              Created {{ u.createdAt | ago }} · last signed in here {{ u.lastLoginAt | ago: 'never' }} · last commit {{ u.lastCommitAt | ago: 'never' }}
              · two-step sign-in {{ u.hasMfa ? 'on' : 'off' }}
            </div>
          }
        </div>
        <ng-container footer>
          @if (!f.isNew && f.user; as u) {
            <div class="mx-footer-start mx-row">
              <button class="mx-btn sm ghost" (click)="moreFor.set(moreFor() ? null : u)"><mx-icon name="more_horiz" />More</button>
              @if (moreFor()) {
                @if (auth.me()?.emailEnabled && u.email) { <button class="mx-btn sm secondary" (click)="sendWelcome(u)"><mx-icon name="forward_to_inbox" />Resend welcome</button> }
                @if (u.hasMfa && u.username !== me()) { <button class="mx-btn sm secondary" (click)="resetMfa(u)"><mx-icon name="phonelink_erase" />Reset 2-step</button> }
                @if (u.lockedUntil) { <button class="mx-btn sm secondary" (click)="unlock(u)"><mx-icon name="lock_open" />Unlock</button> }
                @if (u.username !== me() && u.isEnabled) { <button class="mx-btn sm secondary" (click)="openOffboard(u)"><mx-icon name="person_remove" />Offboard</button> }
                @if (u.username !== me()) { <button class="mx-btn sm danger" (click)="remove(u)"><mx-icon name="delete" />Delete</button> }
              }
            </div>
          }
          <button class="mx-btn secondary" (click)="form.set(null)">Cancel</button>
          <button class="mx-btn primary" [disabled]="busy()" (click)="save(f)">{{ f.isNew ? (f.sendWelcome ? 'Create and email' : 'Create user') : 'Save' }}</button>
        </ng-container>
      </app-modal>
    }

    <!-- reset password -->
    @if (resetFor(); as u) {
      <app-modal [title]="'Reset password for ' + u.username" (closed)="resetFor.set(null)">
        @if (auth.me()?.emailEnabled && u.email) {
          <div class="mx-segmented mb-4" role="group">
            <button type="button" [class.active]="resetMode() === 'email'" (click)="resetMode.set('email')"><mx-icon name="mail" [size]="16" />Email a link</button>
            <button type="button" [class.active]="resetMode() === 'set'" (click)="resetMode.set('set')"><mx-icon name="password" [size]="16" />Set it now</button>
          </div>
        }
        @if (resetMode() === 'email') {
          <p>We'll email <strong>{{ u.email }}</strong> a link to choose a new password. Their current password keeps working until they do.</p>
        } @else {
          <app-password-field label="New password" [(value)]="resetPw" [min]="minPw()" [username]="u.username" />
          <p class="small text-secondary mt-4">Works for SVN straight away. You'll see it once to pass on.</p>
        }
        <ng-container footer>
          <button class="mx-btn secondary" (click)="resetFor.set(null)">Cancel</button>
          <button class="mx-btn primary" [disabled]="busy() || (resetMode() === 'set' && !resetPw)" (click)="reset(u)">{{ resetMode() === 'email' ? 'Send link' : 'Reset password' }}</button>
        </ng-container>
      </app-modal>
    }

    @if (reveal(); as r) {
      <app-modal title="Password set" (closed)="reveal.set(null)">
        <p>Give this password to <strong>{{ r.username }}</strong> through a secure channel. It won't be shown again.</p>
        <div class="mx-row"><div class="mx-secret grow">{{ r.password }}</div>
          <button class="mx-btn secondary" (click)="copy(r.password)"><mx-icon name="content_copy" />Copy</button></div>
        <ng-container footer><button class="mx-btn primary" (click)="reveal.set(null)">Done</button></ng-container>
      </app-modal>
    }

    @if (accessFor(); as a) {
      <app-modal [title]="'What ' + a.user + ' can access'" size="wide" (closed)="accessFor.set(null)">
        <p class="small text-secondary">Every rule that applies to {{ a.user }}, directly or through groups. SVN uses the most specific folder; the Access review page shows the final result per repository.</p>
        <div class="mx-table-wrap"><table class="mx-table compact">
          <thead><tr><th>Repository</th><th>Folder</th><th>Via</th><th>Access</th></tr></thead>
          <tbody>
            @for (e of a.entries; track $index) {
              <tr><td>{{ e.repo ?? 'All repositories' }}</td><td><code>{{ e.path }}</code></td><td><code>{{ e.via }}</code></td>
                <td><span class="mx-chip" [class]="'mx-chip ' + (e.access === 'rw' ? 'success' : e.access === 'r' ? 'info' : 'danger')">{{ label(e.access) }}</span></td></tr>
            } @empty { <tr><td colspan="4" class="mx-muted">No rules apply. This user can't open any repository.</td></tr> }
          </tbody>
        </table></div>
        <ng-container footer><button class="mx-btn primary" (click)="accessFor.set(null)">Close</button></ng-container>
      </app-modal>
    }

    @if (offboardFor(); as u) {
      <app-modal [title]="'Offboard ' + u.username" (closed)="offboardFor.set(null)">
        <p>For someone who has left. This will:</p>
        <ul class="small">
          <li>disable the account (SVN access stops now; history and commits are kept),</li>
          <li>remove them from {{ u.groups.length ? u.groups.join(', ') : 'all groups' }} and any rules naming them,</li>
          <li>cancel any pending email links, and add a note with the reason.</li>
        </ul>
        <div class="mx-form">
          <div class="mx-field"><label for="ob-reason">Reason (optional)</label><input id="ob-reason" [(ngModel)]="obReason" placeholder="e.g. Left the company on 30 Nov" /></div>
          <label class="mx-check"><input type="checkbox" [(ngModel)]="obLocks" />Also break their file locks so others can edit those files</label>
        </div>
        <ng-container footer>
          <button class="mx-btn secondary" (click)="offboardFor.set(null)">Cancel</button>
          <button class="mx-btn danger" [disabled]="busy()" (click)="offboard(u)">Offboard</button>
        </ng-container>
      </app-modal>
    }

    @if (importOpen()) {
      <app-modal title="Import users from CSV" size="xl" (closed)="importOpen.set(false)">
        @if (!importDone()) {
          <p class="small text-secondary">Columns: <code>username, full name, email, groups</code>. Separate several groups with <code>;</code>. A header row is optional.</p>
          <div class="mx-form">
            <div class="mx-field">
              <label for="csv">CSV</label>
              <textarea id="csv" rows="7" class="mono" [(ngModel)]="csv" (ngModelChange)="preview.set(null)" placeholder="username,full name,email,groups&#10;jdoe,Jane Doe,jane@example.com,developers;qa"></textarea>
              <input type="file" accept=".csv,text/csv" (change)="loadFile($event)" aria-label="Choose a CSV file" />
            </div>
            <label class="mx-check"><input type="checkbox" [(ngModel)]="importWelcome" (ngModelChange)="preview.set(null)" [disabled]="!auth.me()?.emailEnabled" />
              Email each person a welcome link to set their own password @if (!auth.me()?.emailEnabled) { <span class="mx-muted">(email not set up)</span> }</label>
          </div>
        }
        @if (preview(); as rows) {
          <div class="mx-table-wrap mt-4"><table class="mx-table compact">
            <thead><tr><th>Line</th><th>Username</th><th>Name</th><th>Email</th><th>Groups</th><th>{{ importDone() ? 'Result' : 'Check' }}</th>@if (importDone() && !importWelcome) { <th>Password</th> }</tr></thead>
            <tbody>
              @for (r of rows; track r.line) {
                <tr><td>{{ r.line }}</td><td>{{ r.username }}</td><td>{{ r.fullName }}</td><td>{{ r.email }}</td><td>{{ r.groups.join(', ') }}</td>
                  <td><span class="mx-chip" [class]="'mx-chip ' + (r.status === 'ok' ? 'success' : 'danger')">{{ r.status === 'ok' ? (importDone() ? 'created' : 'ready') : r.status }}</span></td>
                  @if (importDone() && !importWelcome) { <td class="mono">{{ r.password }}</td> }</tr>
              }
            </tbody>
          </table></div>
        }
        <ng-container footer>
          @if (importDone()) {
            @if (!importWelcome) { <button class="mx-btn secondary mx-footer-start" (click)="downloadImport()"><mx-icon name="download" />Download passwords</button> }
            <button class="mx-btn primary" (click)="importOpen.set(false)">Done</button>
          } @else {
            <button class="mx-btn secondary" (click)="importOpen.set(false)">Cancel</button>
            <button class="mx-btn secondary" [disabled]="busy() || !csv.trim()" (click)="runImport(true)">Check</button>
            <button class="mx-btn primary" [disabled]="busy() || !canImport()" (click)="runImport(false)">Import {{ preview()?.length ?? '' }} users</button>
          }
        </ng-container>
      </app-modal>
    }
  `,
})
export class UsersPage implements OnInit {
  private api = inject(Api);
  protected auth = inject(Auth);
  private toasts = inject(Toasts);
  private confirm = inject(Confirm);
  private router = inject(Router);

  readonly q = input<string>();
  readonly new = input<string>();
  readonly import = input<string>();
  readonly filterParam = input<Filter>(undefined, { alias: 'filter' });

  protected users = signal<User[]>([]);
  protected groups = signal<Group[]>([]);
  protected loading = signal(false);
  protected busy = signal(false);
  protected search = signal('');
  protected filter = signal<Filter>(FILTER.get());
  protected selected = signal(new Set<string>());
  protected form = signal<EditForm | null>(null);
  protected moreFor = signal<User | null>(null);
  protected resetFor = signal<User | null>(null);
  protected resetMode = signal<'email' | 'set'>('set');
  protected reveal = signal<{ username: string; password: string } | null>(null);
  protected accessFor = signal<{ user: string; entries: UserAccess[] } | null>(null);
  protected offboardFor = signal<User | null>(null);
  protected importOpen = signal(false);
  protected importDone = signal(false);
  protected preview = signal<ImportRow[] | null>(null);
  protected resetPw = '';
  protected bulkGroup = '';
  protected obReason = '';
  protected obLocks = true;
  protected csv = '';
  protected importWelcome = false;

  protected me = computed(() => this.auth.me()?.username);
  protected minPw = computed(() => this.auth.me()?.minPasswordLength ?? 10);
  protected label = accessLabel;
  protected canImport = computed(() => !!this.preview()?.length && this.preview()!.every((r) => r.status === 'ok'));

  protected filtered = computed(() => {
    const q = this.search().trim().toLowerCase();
    const f = this.filter();
    return this.users().filter((u) => {
      switch (f) {
        case 'enabled': if (!u.isEnabled) return false; break;
        case 'disabled': if (u.isEnabled) return false; break;
        case 'admins': if (!u.isAdmin) return false; break;
        case 'no-mfa': if (u.hasMfa || !u.isEnabled) return false; break;
        case 'invited': if (!u.invitePending) return false; break;
        case 'locked': if (!u.lockedUntil) return false; break;
        case 'weak': if (!u.weakHash || !u.isEnabled) return false; break;
        case 'stale': if (!(u.passwordStale || (u.passwordAgeDays === null && !u.invitePending)) || !u.isEnabled) return false; break;
      }
      return !q || [u.username, u.fullName, u.email, ...u.groups].some((s) => s.toLowerCase().includes(q));
    });
  });

  protected allSelected = computed(() => this.filtered().length > 0 && this.filtered().every((u) => this.selected().has(u.username)));

  constructor() {
    usePageActions({ create: () => this.openNew(), refresh: () => this.load() });
  }

  async ngOnInit() {
    if (this.q()) { this.search.set(this.q()!); this.filter.set('all'); }
    if (this.filterParam()) this.filter.set(this.filterParam()!);
    await this.load();
    if (this.q()) {
      const exact = this.users().find((u) => u.username.toLowerCase() === this.q()!.toLowerCase());
      if (exact) this.openEdit(exact);
    }
    if (this.new()) this.openNew();
    if (this.import()) this.openImport();
    if (this.new() || this.import() || this.q()) this.router.navigate([], { queryParams: {}, replaceUrl: true });
  }

  async load() {
    this.loading.set(true);
    try {
      const [u, g] = await Promise.all([this.api.users(), this.api.groups()]);
      this.users.set(u);
      this.groups.set(g);
      const names = new Set(u.map((x) => x.username));
      this.selected.update((s) => new Set([...s].filter((n) => names.has(n))));
    } catch (e) { this.toasts.error(e); } finally { this.loading.set(false); }
  }

  setFilter(f: Filter) { this.filter.set(f); FILTER.set(f); }

  toggle(name: string) { this.selected.update((s) => { const n = new Set(s); if (n.has(name)) n.delete(name); else n.add(name); return n; }); }
  clearSelection() { this.selected.set(new Set()); }
  toggleAll() { this.selected.set(this.allSelected() ? new Set() : new Set(this.filtered().map((u) => u.username))); }
  toggleIn(set: Set<string>, v: string) { if (set.has(v)) set.delete(v); else set.add(v); }

  openNew() {
    this.moreFor.set(null);
    this.form.set({ isNew: true, username: '', fullName: '', email: '', notes: '', isEnabled: true, password: generatePassword(),
      sendWelcome: !!this.auth.me()?.emailEnabled, groups: new Set() });
  }

  openEdit(u: User) {
    this.moreFor.set(null);
    this.form.set({ isNew: false, username: u.username, fullName: u.fullName, email: u.email, notes: u.notes, isEnabled: u.isEnabled,
      password: '', sendWelcome: false, groups: new Set(u.groups), user: u });
  }

  async save(f: EditForm) {
    this.busy.set(true);
    try {
      const groups = [...f.groups];
      if (f.isNew) {
        await this.api.createUser({ username: f.username.trim(), fullName: f.fullName, email: f.email,
          password: f.sendWelcome ? null : f.password, groups, notes: f.notes, sendWelcome: f.sendWelcome });
        if (f.sendWelcome) this.toasts.ok(`${f.username} created. Welcome email sent to ${f.email}.`);
        else this.reveal.set({ username: f.username.trim(), password: f.password });
      } else {
        await this.api.updateUser(f.username, { fullName: f.fullName, email: f.email, notes: f.notes, isEnabled: f.isEnabled, groups });
        this.toasts.ok(`${f.username} saved.`);
      }
      this.form.set(null);
      await this.load();
    } catch (e) { this.toasts.error(e); } finally { this.busy.set(false); }
  }

  openReset(u: User) {
    this.resetPw = generatePassword();
    this.resetMode.set(this.auth.me()?.emailEnabled && u.email ? 'email' : 'set');
    this.resetFor.set(u);
  }

  async reset(u: User) {
    this.busy.set(true);
    try {
      if (this.resetMode() === 'email') {
        await this.api.sendReset(u.username);
        this.toasts.ok(`Reset link sent to ${u.email}.`);
      } else {
        await this.api.setPassword(u.username, this.resetPw);
        this.reveal.set({ username: u.username, password: this.resetPw });
      }
      this.resetFor.set(null);
      await this.load();
    } catch (e) { this.toasts.error(e); } finally { this.busy.set(false); }
  }

  async openAccess(u: User) {
    try { this.accessFor.set({ user: u.username, entries: await this.api.userAccess(u.username) }); } catch (e) { this.toasts.error(e); }
  }

  async sendWelcome(u: User) {
    try { await this.api.sendWelcome(u.username); this.toasts.ok(`Welcome email sent to ${u.email}.`); await this.load(); } catch (e) { this.toasts.error(e); }
  }

  async resetMfa(u: User) {
    const ok = await this.confirm.ask({ title: `Reset two-step sign-in for ${u.username}?`,
      body: 'Removes their authenticator app, passkeys and recovery codes (for a lost or replaced phone). If they are an admin, they must set it up again before using admin pages.',
      confirmText: 'Reset', danger: true });
    if (!ok) return;
    try { await this.api.resetMfa(u.username); this.toasts.ok('Two-step sign-in reset.'); this.form.set(null); await this.load(); } catch (e) { this.toasts.error(e); }
  }

  async unlock(u: User) {
    try { await this.api.unlockUser(u.username); this.toasts.ok(`${u.username} can sign in again.`); this.form.set(null); await this.load(); } catch (e) { this.toasts.error(e); }
  }

  openOffboard(u: User) { this.obReason = ''; this.obLocks = true; this.form.set(null); this.offboardFor.set(u); }

  async offboard(u: User) {
    this.busy.set(true);
    try {
      const r = await this.api.offboard(u.username, this.obReason, this.obLocks);
      this.toasts.ok(`${u.username} offboarded. Removed from ${r.groups.length} group(s)` +
        (r.removedRules ? `, ${r.removedRules} rule(s)` : '') + (r.brokenLocks ? `, broke ${r.brokenLocks} lock(s)` : '') + '.');
      this.offboardFor.set(null);
      await this.load();
    } catch (e) { this.toasts.error(e); } finally { this.busy.set(false); }
  }

  async remove(u: User) {
    const ok = await this.confirm.ask({
      title: `Delete ${u.username}?`,
      body: `${u.username} loses SVN access now and is removed from every group and rule. This can't be undone.\n\nFor someone who left, "Offboard" keeps the account (disabled) for the record.`,
      confirmText: 'Delete user', danger: true, typeToConfirm: u.username,
    });
    if (!ok) return;
    try {
      const r = await this.api.deleteUser(u.username);
      this.toasts.ok(`Deleted ${u.username}${r.removedRules ? ` and ${r.removedRules} rule(s)` : ''}.`);
      this.form.set(null);
      await this.load();
    } catch (e) { this.toasts.error(e); }
  }

  async bulk(action: string) {
    const names = [...this.selected()];
    const verb: Record<string, string> = { 'add-group': `add to @${this.bulkGroup}`, 'remove-group': `remove from @${this.bulkGroup}`,
      disable: 'disable', enable: 'enable', 'send-reset': 'email a password-reset link to' };
    if (action === 'disable' || action === 'send-reset') {
      const ok = await this.confirm.ask({ title: `${verb[action][0].toUpperCase() + verb[action].slice(1)} ${names.length} user(s)?`,
        body: names.join(', '), confirmText: action === 'disable' ? 'Disable' : 'Send', danger: action === 'disable' });
      if (!ok) return;
    }
    this.busy.set(true);
    try {
      const r = await this.api.bulk(names, action, this.bulkGroup || undefined);
      this.toasts.ok(`Done: ${r.done} changed.`);
      if (r.errors.length) this.toasts.show('warning', r.errors.join('\n'), 12000);
      if (action !== 'send-reset') this.selected.set(new Set());
      await this.load();
    } catch (e) { this.toasts.error(e); } finally { this.busy.set(false); }
  }

  exportCsv() {
    downloadCsv(`svn-users-${new Date().toISOString().slice(0, 10)}.csv`,
      ['Username', 'Full name', 'Email', 'Enabled', 'Admin', 'Two-step', 'Groups', 'Password changed', 'Last commit', 'Last sign-in', 'Notes'],
      this.filtered().map((u) => [u.username, u.fullName, u.email, u.isEnabled, u.isAdmin, u.hasMfa, u.groups.join('; '),
        u.passwordChangedAt, u.lastCommitAt, u.lastLoginAt, u.notes]));
  }

  openImport() {
    this.csv = '';
    this.importWelcome = !!this.auth.me()?.emailEnabled;
    this.preview.set(null);
    this.importDone.set(false);
    this.importOpen.set(true);
  }

  async loadFile(e: Event) {
    const file = (e.target as HTMLInputElement).files?.[0];
    if (!file) return;
    this.csv = await file.text();
    this.preview.set(null);
    await this.runImport(true);
  }

  async runImport(dryRun: boolean) {
    this.busy.set(true);
    try {
      const r = await this.api.importUsers(this.csv, this.importWelcome, dryRun);
      this.preview.set(r.rows);
      if (!dryRun && r.created) {
        this.importDone.set(true);
        this.toasts.ok(`${r.created} user(s) created.`);
        await this.load();
      }
    } catch (e) { this.toasts.error(errorMessage(e)); } finally { this.busy.set(false); }
  }

  downloadImport() {
    downloadCsv('imported-users-passwords.csv', ['Username', 'Password'], (this.preview() ?? []).map((r) => [r.username, r.password]));
  }

  async copy(text: string) { if (await copyText(text)) this.toasts.ok('Copied.'); }
}
