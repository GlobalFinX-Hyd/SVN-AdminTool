import { ChangeDetectionStrategy, Component, ViewEncapsulation, computed, input } from '@angular/core';

/**
 * Monochrome outlined line icon (Material Symbols Outlined).
 * The font is self-hosted from the material-symbols npm package (no CDN), loaded in angular.json.
 *
 * `<mx-icon name="group" />`  `<mx-icon name="delete" [size]="18" />`
 */
@Component({
  selector: 'mx-icon',
  changeDetection: ChangeDetectionStrategy.OnPush,
  encapsulation: ViewEncapsulation.None,
  host: { '[style.--mx-icon-size.px]': 'size()', 'aria-hidden': 'true' },
  template: `<span class="material-symbols-outlined" [style.font-variation-settings]="variation()">{{ name() }}</span>`,
  styles: [`
    mx-icon { display: inline-flex; align-items: center; justify-content: center; flex-shrink: 0; line-height: 1; color: inherit; }
    mx-icon > .material-symbols-outlined { font-size: var(--mx-icon-size, 20px); color: inherit; user-select: none; }
  `],
})
export class MxIcon {
  readonly name = input.required<string>();
  readonly size = input<number>(20);
  readonly weight = input<number>(300);
  readonly fill = input<boolean>(false);

  protected readonly variation = computed(
    () => `'FILL' ${this.fill() ? 1 : 0}, 'wght' ${this.weight()}, 'GRAD' 0, 'opsz' ${Math.min(48, Math.max(20, this.size()))}`,
  );
}
