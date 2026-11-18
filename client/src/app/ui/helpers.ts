import { Pipe, PipeTransform } from '@angular/core';

/** "3 days ago" / "in 5 minutes". Pair with [title]="x | date: 'medium'" for the exact time. */
@Pipe({ name: 'ago' })
export class AgoPipe implements PipeTransform {
  transform(value: string | Date | null | undefined, empty = '—'): string {
    if (!value) return empty;
    const t = typeof value === 'string' ? Date.parse(value) : value.getTime();
    if (isNaN(t)) return empty;
    const s = Math.round((Date.now() - t) / 1000);
    const abs = Math.abs(s);
    const fmt = (n: number, unit: string) => {
      const v = Math.round(n);
      return s >= 0 ? `${v} ${unit}${v === 1 ? '' : 's'} ago` : `in ${v} ${unit}${v === 1 ? '' : 's'}`;
    };
    if (abs < 45) return s >= 0 ? 'just now' : 'in a moment';
    if (abs < 3600) return fmt(abs / 60, 'minute');
    if (abs < 86400) return fmt(abs / 3600, 'hour');
    if (abs < 86400 * 30) return fmt(abs / 86400, 'day');
    if (abs < 86400 * 365) return fmt(abs / (86400 * 30), 'month');
    return fmt(abs / (86400 * 365), 'year');
  }
}

/** Downloads rows as a CSV file (Excel-friendly: BOM, quoted, formula-safe). */
export function downloadCsv(filename: string, header: string[], rows: (string | number | boolean | null | undefined)[][]) {
  const cell = (v: unknown) => {
    let s = v === null || v === undefined ? '' : String(v);
    if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
    return '"' + s.replace(/"/g, '""') + '"';
  };
  const text = [header, ...rows].map((r) => r.map(cell).join(',')).join('\r\n');
  const blob = new Blob(['﻿' + text], { type: 'text/csv;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

/** Remembers a small per-page preference (filter, tab) in localStorage. */
export function remembered<T>(key: string, fallback: T): { get: () => T; set: (v: T) => void } {
  const k = 'svnadmin.' + key;
  return {
    get: () => {
      try { const v = localStorage.getItem(k); return v === null ? fallback : (JSON.parse(v) as T); } catch { return fallback; }
    },
    set: (v: T) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* storage blocked */ } },
  };
}

/** Copies text, returning whether it worked. */
export async function copyText(text: string): Promise<boolean> {
  try { await navigator.clipboard.writeText(text); return true; } catch { return false; }
}
