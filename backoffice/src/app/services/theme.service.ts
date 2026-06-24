import { Injectable, effect, signal } from '@angular/core';

type Theme = 'light' | 'dark';

@Injectable({ providedIn: 'root' })
export class ThemeService {
  private readonly STORAGE_KEY = 'lattice-theme';

  theme = signal<Theme>(this.resolveInitial());

  constructor() {
    effect(() => {
      const t = this.theme();
      document.body.classList.toggle('dark-theme', t === 'dark');
      localStorage.setItem(this.STORAGE_KEY, t);
    });
  }

  toggle() {
    this.theme.update(t => (t === 'dark' ? 'light' : 'dark'));
  }

  private resolveInitial(): Theme {
    const stored = localStorage.getItem(this.STORAGE_KEY) as Theme | null;
    if (stored === 'dark' || stored === 'light') return stored;
    return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  }
}
