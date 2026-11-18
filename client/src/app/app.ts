import { Component, inject } from '@angular/core';
import { RouterOutlet } from '@angular/router';
import { ConfirmHost, ToastHost } from './shared/overlays';
import { Theme } from './theme';

@Component({
  selector: 'app-root',
  imports: [RouterOutlet, ToastHost, ConfirmHost],
  template: `<router-outlet /><app-toasts /><app-confirm />`,
})
export class App {
  constructor() {
    inject(Theme); // apply the saved theme before any page renders (login included)
  }
}
