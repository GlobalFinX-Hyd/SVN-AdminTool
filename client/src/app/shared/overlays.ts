import { Component, effect, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Confirm, Toasts } from '../core/ui';
import { MxIcon } from '../ui/icon';

/** Bottom-right toasts (surface card with a coloured left edge). */
@Component({
  selector: 'app-toasts',
  imports: [MxIcon],
  template: `
    <div class="mx-toaster" role="status" aria-live="polite">
      @for (t of toasts.items(); track t.id) {
        <div class="mx-toast" [class]="'mx-toast ' + t.kind" [attr.role]="t.kind === 'danger' ? 'alert' : null">
          <mx-icon [name]="t.kind === 'success' ? 'check_circle' : t.kind === 'danger' ? 'error' : t.kind === 'warning' ? 'warning' : 'info'" [size]="20" />
          <span class="text">{{ t.text }}</span>
          <button type="button" class="close" aria-label="Dismiss" (click)="toasts.dismiss(t.id)"><mx-icon name="close" [size]="18" /></button>
        </div>
      }
    </div>
  `,
  styles: [`
    .mx-toaster { position: fixed; right: 20px; bottom: 20px; z-index: 2000; display: flex; flex-direction: column; gap: 8px; max-width: min(420px, calc(100vw - 40px)); }
    .mx-toast { display: flex; align-items: center; gap: 10px; padding: 10px 12px 10px 14px; border-radius: 10px;
                background: var(--sa-surface); color: var(--sa-text-primary); border: 1px solid var(--sa-border);
                border-left: 4px solid var(--sa-primary); box-shadow: 0 6px 24px rgba(0,0,0,.14); font-size: .9rem;
                animation: mx-toast-in .18s ease-out; }
    .mx-toast.success { border-left-color: #16a34a; } .mx-toast.success mx-icon:first-child { color: #16a34a; }
    .mx-toast.danger  { border-left-color: #dc2626; } .mx-toast.danger mx-icon:first-child  { color: #dc2626; }
    .mx-toast.warning { border-left-color: #d97706; } .mx-toast.warning mx-icon:first-child { color: #d97706; }
    .mx-toast .text { flex: 1; line-height: 1.35; white-space: pre-line; }
    .mx-toast .close { background: none; border: 0; padding: 2px; cursor: pointer; color: var(--sa-text-muted); display: inline-flex; }
    @keyframes mx-toast-in { from { opacity: 0; transform: translateY(6px); } to { opacity: 1; transform: none; } }
  `],
})
export class ToastHost {
  protected toasts = inject(Toasts);
}

/** Yes/no dialog, optionally requiring the admin to type a name. */
@Component({
  selector: 'app-confirm',
  imports: [FormsModule],
  template: `
    @if (confirm.current(); as c) {
      <div class="mx-confirm-backdrop" (mousedown.self)="answer(false)" (keydown.escape)="answer(false)">
        <div class="mx-confirm" role="alertdialog" aria-modal="true" [attr.aria-label]="c.title">
          <div class="mx-confirm-title">{{ c.title }}</div>
          <div class="mx-confirm-text">{{ c.body }}</div>
          @if (c.typeToConfirm) {
            <div class="mx-field mt-4">
              <label for="confirm-type">Type <strong>{{ c.typeToConfirm }}</strong> to confirm</label>
              <input id="confirm-type" [ngModel]="typed()" (ngModelChange)="typed.set($event)" autocomplete="off" (keydown.enter)="typed() === c.typeToConfirm && answer(true)" />
            </div>
          }
          <div class="mx-confirm-actions">
            <button class="mx-btn secondary" (click)="answer(false)">Cancel</button>
            <button class="mx-btn" [class.danger]="c.danger" [class.primary]="!c.danger" id="confirm-ok"
              [disabled]="!!c.typeToConfirm && typed() !== c.typeToConfirm" (click)="answer(true)">{{ c.confirmText }}</button>
          </div>
        </div>
      </div>
    }
  `,
})
export class ConfirmHost {
  protected confirm = inject(Confirm);
  protected typed = signal('');

  constructor() {
    // Focus the input (or the confirm button) when a dialog opens.
    effect(() => {
      if (this.confirm.current())
        setTimeout(() => (document.getElementById('confirm-type') ?? document.getElementById('confirm-ok'))?.focus());
    });
  }

  answer(ok: boolean) {
    this.typed.set('');
    this.confirm.answer(ok);
  }
}
