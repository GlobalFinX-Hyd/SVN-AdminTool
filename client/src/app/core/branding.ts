import { Injectable, inject, signal } from '@angular/core';
import { Title } from '@angular/platform-browser';
import { RouterStateSnapshot, TitleStrategy } from '@angular/router';

/**
 * Product name and logo, set by the server (Svn:ProductName, Svn:LogoFile) so each
 * organisation can brand its own install. Loaded once before the app starts.
 */
@Injectable({ providedIn: 'root' })
export class Branding {
  readonly productName = signal('SVN Admin');
  /** Served by the API: the configured logo file, or the built-in logo.png. */
  readonly logoUrl = 'api/public/logo';

  async load(): Promise<void> {
    try {
      const res = await fetch('api/public/branding', { credentials: 'same-origin' });
      if (res.ok) {
        const b = (await res.json()) as { productName?: string };
        if (b.productName?.trim()) this.productName.set(b.productName.trim());
      }
    } catch {
      /* keep the default name */
    }
    document.title = this.productName();
  }
}

/** Page titles read "Users · <product name>". */
@Injectable({ providedIn: 'root' })
export class BrandTitleStrategy extends TitleStrategy {
  private readonly title = inject(Title);
  private readonly brand = inject(Branding);

  override updateTitle(snapshot: RouterStateSnapshot): void {
    const page = this.buildTitle(snapshot);
    this.title.setTitle(page ? `${page} · ${this.brand.productName()}` : this.brand.productName());
  }
}
