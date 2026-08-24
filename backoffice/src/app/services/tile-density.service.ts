import { Injectable, effect, signal } from '@angular/core';

// Tile density (F21.1 + the Display picker).
//
// F21.1's whole point is that tile geometry stops being six hard-coded @media blocks and becomes
// one set of custom properties on the grid. Once that is true, a density picker is not a new
// feature — it is writing different values to those same properties. This service is that write.
//
// The breakpoints still apply underneath: the picker sets a *preference*, and the CSS media
// queries clamp it, so a phone never renders a 330px tile it cannot fit.

export type Density = 'compact' | 'standard' | 'detailed' | 'list';

export interface DensitySpec {
  key: Density;
  label: string;
  description: string;
  /** Tile box in px. `list` uses full-width rows, so its width is not a tile width. */
  width: number;
  height: number;
  gap: number;
  /** Full-width rows rather than a fixed tile box — `--tile-w` becomes 100%. */
  fullWidth?: boolean;
}

export const DENSITIES: DensitySpec[] = [
  {
    key: 'compact',
    label: 'Compact',
    description: 'Name and state only',
    width: 168,
    height: 104,
    gap: 12,
  },
  {
    key: 'standard',
    label: 'Standard',
    description: 'Adds a 7-day sparkline',
    width: 216,
    // 150 was the sketch; measurement says a two-line name, two read-outs AND a sparkline do not
    // fit in it — the body came to 62px usable against 100px of content. The number follows the
    // content rather than the content being clipped to the number.
    height: 164,
    gap: 12,
  },
  {
    key: 'detailed',
    label: 'Detailed',
    description: 'Adds a chart and the last command',
    width: 330,
    height: 248,
    gap: 12,
  },
  {
    key: 'list',
    label: 'List',
    description: 'One row per action, everything inline',
    width: 0,
    height: 56,
    gap: 6,
    fullWidth: true,
  },
];

/** What a tile renders at each density, independent of its size. */
export interface TileFields {
  sparkline: boolean;
  chart: boolean;
  lastCommand: boolean;
  deviceName: boolean;
}

/**
 * What a density shows by default, before the user's own field toggles.
 *
 * Module-level rather than a method because owners that pin a card to a fixed shape need the same
 * answer without going through the service — the service holds the *dashboard's* preference, and
 * a group sheet or a setup tile is not the dashboard.
 */
export function defaultFieldsFor(d: Density): TileFields {
  switch (d) {
    case 'compact':
      return { sparkline: false, chart: false, lastCommand: false, deviceName: false };
    case 'detailed':
      return { sparkline: false, chart: true, lastCommand: true, deviceName: true };
    case 'list':
      return { sparkline: true, chart: false, lastCommand: true, deviceName: true };
    default:
      return { sparkline: true, chart: false, lastCommand: false, deviceName: true };
  }
}

@Injectable({ providedIn: 'root' })
export class TileDensityService {
  private readonly DENSITY_KEY = 'lattice-tile-density';
  private readonly FIELDS_KEY = 'lattice-tile-fields';

  density = signal<Density>(this.restoreDensity());
  fields = signal<TileFields>(this.restoreFields());

  constructor() {
    effect(() => {
      const d = this.density();
      const spec = DENSITIES.find((s) => s.key === d) ?? DENSITIES[1]!;
      const root = document.documentElement;
      // The tokens F21.1 introduces. Set on :root so the dashboard grid, the drag placeholder and
      // every tile derive from one source instead of restating px in six media blocks.
      // `list` is the one density whose width is not a pixel box: a 0px tile would render nothing
      // at all, which is exactly how it failed before.
      root.style.setProperty('--tile-w', spec.fullWidth ? '100%' : `${spec.width}px`);
      root.style.setProperty('--tile-h', `${spec.height}px`);
      root.style.setProperty('--tile-gap', `${spec.gap}px`);
      root.dataset['density'] = d;
      safeWrite(this.DENSITY_KEY, d);
    });

    effect(() => safeWrite(this.FIELDS_KEY, JSON.stringify(this.fields())));
  }

  setDensity(d: Density): void {
    this.density.set(d);
  }

  toggleField(key: keyof TileFields): void {
    this.fields.update((f) => ({ ...f, [key]: !f[key] }));
  }

  /** What this density shows by default, before the user's own field toggles. */
  private defaultsFor(d: Density): TileFields {
    return defaultFieldsFor(d);
  }

  /** Apply a density's defaults, discarding per-field overrides — what picking a size means. */
  applyDensity(d: Density): void {
    this.density.set(d);
    this.fields.set(this.defaultsFor(d));
  }

  private restoreDensity(): Density {
    const raw = safeRead(this.DENSITY_KEY);
    return DENSITIES.some((s) => s.key === raw) ? (raw as Density) : 'standard';
  }

  private restoreFields(): TileFields {
    const raw = safeRead(this.FIELDS_KEY);
    if (raw) {
      try {
        const parsed = JSON.parse(raw) as Partial<TileFields>;
        return { ...this.defaultsFor(this.restoreDensity()), ...parsed };
      } catch {
        // Corrupt JSON in localStorage is not worth a broken dashboard.
      }
    }
    return this.defaultsFor(this.restoreDensity());
  }
}

// localStorage throws outright in some contexts (private windows with site data blocked), so every
// access is guarded — a dashboard must render whether or not the preference survives.
function safeRead(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function safeWrite(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* ignore */
  }
}
