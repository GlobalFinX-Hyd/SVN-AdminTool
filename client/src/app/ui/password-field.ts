import { Component, computed, input, model, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { generatePassword } from '../core/ui';
import { copyText } from './helpers';
import { MxIcon } from './icon';

let nextId = 0;

/** Password input with show/hide, generate, copy, and a live strength/rules hint. */
@Component({
  selector: 'app-password-field',
  imports: [FormsModule, MxIcon],
  template: `
    <div class="mx-field">
      <label [for]="id">{{ label() }}</label>
      <div class="pw-wrap">
        <input [id]="id" [type]="show() ? 'text' : 'password'" class="mx-input pw-input" [ngModel]="value()" (ngModelChange)="value.set($event)"
               [attr.autocomplete]="autocomplete()" spellcheck="false" />
        <button type="button" class="mx-icon-btn" (click)="show.set(!show())" [attr.aria-label]="show() ? 'Hide password' : 'Show password'" [title]="show() ? 'Hide' : 'Show'">
          <mx-icon [name]="show() ? 'visibility_off' : 'visibility'" [size]="18" /></button>
        @if (generator()) {
          <button type="button" class="mx-icon-btn" (click)="generate()" aria-label="Generate a strong password" title="Generate"><mx-icon name="casino" [size]="18" /></button>
          <button type="button" class="mx-icon-btn" (click)="copy()" aria-label="Copy password" title="Copy" [disabled]="!value()"><mx-icon [name]="copied() ? 'check' : 'content_copy'" [size]="18" /></button>
        }
      </div>
      @if (value()) {
        <div class="meter" aria-hidden="true"><span [style.width.%]="strength() * 25" [class]="'s' + strength()"></span></div>
        <small [class]="problem() ? 'mx-error' : 'mx-help'">{{ problem() || strengthLabel() }}</small>
      } @else {
        <small class="mx-help">At least {{ min() }} characters. A long passphrase is easiest to remember.</small>
      }
    </div>
  `,
  styles: [`
    .pw-wrap { display: flex; align-items: center; gap: 2px; }
    .pw-input { flex: 1; min-width: 0; font-family: 'Cascadia Mono', Consolas, monospace; }
    .meter { height: 4px; border-radius: 2px; background: var(--mx-surface-2); overflow: hidden; }
    .meter span { display: block; height: 100%; transition: width .2s ease; }
    .s0, .s1 { background: var(--sa-danger); } .s2 { background: var(--sa-warning); } .s3, .s4 { background: var(--sa-success); }
  `],
})
export class PasswordField {
  readonly label = input('Password');
  readonly value = model('');
  readonly min = input(10);
  readonly username = input('');
  readonly generator = input(true);
  readonly autocomplete = input('new-password');
  protected readonly id = 'pw-' + nextId++;
  protected show = signal(false);
  protected copied = signal(false);

  protected problem = computed(() => {
    const v = this.value();
    if (v.length < this.min()) return `${this.min() - v.length} more character(s) needed.`;
    if (this.username() && v.toLowerCase().includes(this.username().toLowerCase())) return "Don't include your username.";
    if (v.includes(':')) return "':' can't be used in SVN passwords.";
    return '';
  });

  protected strength = computed(() => {
    const v = this.value();
    let s = 0;
    if (v.length >= this.min()) s++;
    if (v.length >= 14) s++;
    if (/[a-z]/.test(v) && /[A-Z]/.test(v)) s++;
    if (/\d/.test(v) && /[^A-Za-z0-9]/.test(v)) s++;
    return this.problem() ? Math.min(s, 1) : s;
  });

  protected strengthLabel = computed(() => ['Too weak', 'Weak', 'OK', 'Strong', 'Very strong'][this.strength()]);

  generate() {
    this.value.set(generatePassword());
    this.show.set(true);
  }

  async copy() {
    if (await copyText(this.value())) { this.copied.set(true); setTimeout(() => this.copied.set(false), 1500); }
  }
}
