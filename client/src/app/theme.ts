import { Injectable, computed, signal } from '@angular/core';

export type ThemeMode = 'light' | 'dark' | 'system';

/**
 * Light / dark / follow-the-system theme: toggles `.dark-theme` on <body>
 * (the design tokens switch on that class). The choice is remembered per browser in localStorage['theme'].
 */
@Injectable({ providedIn: 'root' })
export class Theme {
  readonly mode = signal<ThemeMode>('system');
  private readonly systemDark = signal(false);
  readonly dark = computed(() => this.mode() === 'dark' || (this.mode() === 'system' && this.systemDark()));

  constructor() {
    const mq = matchMedia('(prefers-color-scheme: dark)');
    this.systemDark.set(mq.matches);
    mq.addEventListener('change', (e) => { this.systemDark.set(e.matches); this.apply(); });
    let saved: string | null = null;
    try { saved = localStorage.getItem('theme'); } catch { /* storage blocked */ }
    if (saved === 'light' || saved === 'dark' || saved === 'system') this.mode.set(saved);
    this.apply();
  }

  set(mode: ThemeMode) {
    this.mode.set(mode);
    try { localStorage.setItem('theme', mode); } catch { /* storage blocked */ }
    this.apply();
  }

  /** Header button: flip between light and dark (leaves "system" once used). */
  toggle() { this.set(this.dark() ? 'light' : 'dark'); }

  private apply() {
    const dark = this.dark();
    document.body.classList.toggle('dark-theme', dark);
    document.body.classList.toggle('light-theme', !dark);
    document.documentElement.style.colorScheme = dark ? 'dark' : 'light';
  }
}
