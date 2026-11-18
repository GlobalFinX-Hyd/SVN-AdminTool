import { Injectable, signal } from '@angular/core';
import { errorMessage } from './api';

export interface Toast {
  id: number;
  kind: 'success' | 'danger' | 'warning' | 'info';
  text: string;
}

@Injectable({ providedIn: 'root' })
export class Toasts {
  readonly items = signal<Toast[]>([]);
  private next = 1;

  show(kind: Toast['kind'], text: string, ms = kind === 'danger' ? 9000 : 4000) {
    const id = this.next++;
    this.items.update((l) => [...l, { id, kind, text }]);
    setTimeout(() => this.dismiss(id), ms);
  }
  ok(text: string) { this.show('success', text); }
  error(err: unknown) { this.show('danger', errorMessage(err)); }
  dismiss(id: number) { this.items.update((l) => l.filter((t) => t.id !== id)); }
}

export interface ConfirmRequest {
  title: string;
  body: string;
  confirmText: string;
  danger: boolean;
  /** When set, the admin must type this exact text to enable the button. */
  typeToConfirm?: string;
  resolve: (ok: boolean) => void;
}

@Injectable({ providedIn: 'root' })
export class Confirm {
  readonly current = signal<ConfirmRequest | null>(null);

  ask(opts: { title: string; body: string; confirmText?: string; danger?: boolean; typeToConfirm?: string }): Promise<boolean> {
    return new Promise((resolve) =>
      this.current.set({ confirmText: 'Confirm', danger: false, ...opts, resolve }),
    );
  }

  answer(ok: boolean) {
    this.current()?.resolve(ok);
    this.current.set(null);
  }
}

/** Strong random password that avoids look-alike characters. */
export function generatePassword(length = 16): string {
  const sets = ['ABCDEFGHJKLMNPQRSTUVWXYZ', 'abcdefghijkmnopqrstuvwxyz', '23456789', '!#%+=?@^_-'];
  const all = sets.join('');
  const pick = (s: string) => s[crypto.getRandomValues(new Uint32Array(1))[0] % s.length];
  const chars = sets.map(pick);
  while (chars.length < length) chars.push(pick(all));
  for (let i = chars.length - 1; i > 0; i--) {
    const j = crypto.getRandomValues(new Uint32Array(1))[0] % (i + 1);
    [chars[i], chars[j]] = [chars[j], chars[i]];
  }
  return chars.join('');
}

export function formatBytes(n: number | null | undefined): string {
  if (n === null || n === undefined) return '—';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return `${v.toFixed(v < 10 && i > 0 ? 1 : 0)} ${units[i]}`;
}

export function accessLabel(a: string): string {
  return a === 'rw' ? 'Read/write' : a === 'r' ? 'Read' : 'No access';
}

export function principalLabel(type: string, name: string): string {
  switch (type) {
    case 'all': return 'Everyone (*)';
    case 'authenticated': return 'Any signed-in user';
    case 'anonymous': return 'Anonymous';
    case 'group': return '@' + name;
    default: return name;
  }
}
