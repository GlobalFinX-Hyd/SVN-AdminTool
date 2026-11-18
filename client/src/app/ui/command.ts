import { DestroyRef, Injectable, inject, signal } from '@angular/core';

/** A palette entry: a page (route) or an action (run). */
export interface CommandItem {
  label: string;
  icon?: string;
  group?: string;
  keywords?: string[];
  route?: string;
  queryParams?: Record<string, string>;
  run?: () => void;
  /** Shown on the right, e.g. a shortcut hint "g u". */
  hint?: string;
}

/** Things the current page offers to the keyboard shortcuts ("n" = new, "r" = refresh, "/" = search). */
export interface PageActions {
  create?: () => void;
  refresh?: () => void;
}

/**
 * State for the command palette (Ctrl+K), the shortcuts help (?), and per-page shortcut targets.
 * Command registry for the palette, plus actions and page hooks.
 */
@Injectable({ providedIn: 'root' })
export class Commands {
  readonly items = signal<CommandItem[]>([]);
  readonly isOpen = signal(false);
  readonly helpOpen = signal(false);
  readonly page = signal<PageActions>({});

  setItems(items: CommandItem[]) {
    this.items.set(items);
    if (!items.length) { this.close(); this.closeHelp(); }
  }

  open() { this.helpOpen.set(false); this.isOpen.set(true); }
  close() { this.isOpen.set(false); }
  toggle() { if (this.isOpen()) this.close(); else this.open(); }
  openHelp() { this.isOpen.set(false); this.helpOpen.set(true); }
  closeHelp() { this.helpOpen.set(false); }
}

/** Call from a page component's constructor: registers its "n"/"r" targets until the page is left. */
export function usePageActions(actions: PageActions) {
  const commands = inject(Commands);
  commands.page.set(actions);
  inject(DestroyRef).onDestroy(() => { if (commands.page() === actions) commands.page.set({}); });
}
