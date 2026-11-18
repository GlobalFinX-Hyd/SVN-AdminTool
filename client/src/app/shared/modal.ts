import { Component, ElementRef, HostListener, OnDestroy, OnInit, inject, input, output } from '@angular/core';
import { MxIcon } from '../ui/icon';

/**
 * Modal (.mx-modal > .mx-modal-dialog > header / body / footer). Render it with @if to open.
 * Esc or a click on the backdrop closes it; focus moves into the dialog and back when it closes.
 */
@Component({
  selector: 'app-modal',
  imports: [MxIcon],
  template: `
    <div class="mx-modal" (mousedown.self)="closed.emit()">
      <div class="mx-modal-dialog" [class.wide]="size() === 'wide'" [style.max-width]="size() === 'xl' ? '1100px' : null"
           role="dialog" aria-modal="true" [attr.aria-label]="title()" tabindex="-1">
        <div class="mx-modal-header">
          <h2>{{ title() }}</h2>
          <button type="button" class="mx-icon-btn" aria-label="Close" (click)="closed.emit()"><mx-icon name="close" /></button>
        </div>
        <div class="mx-modal-body"><ng-content /></div>
        <div class="mx-modal-footer"><ng-content select="[footer]" /></div>
      </div>
    </div>
  `,
})
export class Modal implements OnInit, OnDestroy {
  readonly title = input.required<string>();
  readonly size = input<'normal' | 'wide' | 'xl'>('normal');
  readonly closed = output<void>();

  private el = inject(ElementRef<HTMLElement>);
  private previous: HTMLElement | null = null;

  ngOnInit() {
    this.previous = document.activeElement as HTMLElement | null;
    setTimeout(() => {
      const root = this.el.nativeElement as HTMLElement;
      const first = root.querySelector<HTMLElement>('.mx-modal-body input:not([disabled]):not([readonly]), .mx-modal-body select, .mx-modal-body textarea');
      (first ?? root.querySelector<HTMLElement>('.mx-modal-dialog'))?.focus();
    });
  }

  ngOnDestroy() {
    if (this.previous && document.contains(this.previous)) setTimeout(() => this.previous?.focus());
  }

  @HostListener('document:keydown.escape', ['$event']) onEsc(e: Event) {
    e.stopPropagation();
    this.closed.emit();
  }
}
