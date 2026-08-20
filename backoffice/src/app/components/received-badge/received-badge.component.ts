import { Component, DestroyRef, computed, inject, input, signal } from '@angular/core';
import { CommonModule } from '@angular/common';

// How old a confirmation may get before the badge says so. Matches RECONCILE_WINDOW_MS's default
// (30 min): past that, the platform itself considers the value due for a re-read, so the UI should
// stop presenting it as current.
const STALE_AFTER_MS = 30 * 60 * 1000;

@Component({
  selector: 'app-received-badge',
  standalone: true,
  imports: [CommonModule],
  template: `
    @if (receivedAt() || confirmedAt()) {
      <span
        class="received-badge"
        [class.overlay]="variant() === 'overlay'"
        [class.stale]="isStale()"
        [title]="tooltip()"
      >
        <span class="material-symbols-outlined received-badge-icon">
          {{ isStale() ? 'help' : 'schedule' }}
        </span>
        {{ label() }}
      </span>
    }
  `,
  styles: [
    `
      .received-badge {
        display: inline-flex;
        align-items: center;
        gap: 3px;
        font-size: 10px;
        font-family: monospace;
        line-height: 1.6;
        color: var(--text-muted);
        background: var(--surface-alt);
        border: 1px solid var(--border);
        padding: 2px 7px;
        border-radius: var(--radius-chip);
      }
      .received-badge-icon {
        font-size: 12px;
        line-height: 1;
      }
      /* Overlay variant: sits on top of camera images, needs its own contrast
       regardless of theme since the backdrop is arbitrary photo content. */
      .received-badge.overlay {
        color: #fff;
        background: rgba(0, 0, 0, 0.55);
        border-color: rgba(255, 255, 255, 0.15);
        backdrop-filter: blur(4px);
        -webkit-backdrop-filter: blur(4px);
      }
      /* Unconfirmed for longer than the platform's own reconcile window. Deliberately muted
       rather than alarming: the value is probably right, we just cannot say so. */
      .received-badge.stale {
        color: var(--warn, #b26a00);
        border-style: dashed;
      }
    `,
  ],
})
export class ReceivedBadgeComponent {
  /** Wall-clock ms when THIS tab saw the state arrive. Undefined after a reload. */
  receivedAt = input<number | undefined>();
  /**
   * The server's record of when the state was last confirmed by the device (ISO string). Outlives
   * the tab, so it is what a freshly-loaded page has to go on.
   */
  lastConfirmedAt = input<string | null | undefined>();
  variant = input<'inline' | 'overlay'>('inline');

  // A relative label has to age on its own. Without a ticking signal the computeds below would
  // read Date.now() once and then never re-evaluate — the badge would sit at "2m ago" until some
  // unrelated input happened to change, which is worse than showing nothing.
  private readonly now = signal(Date.now());

  constructor() {
    const tick = setInterval(() => this.now.set(Date.now()), 30_000);
    inject(DestroyRef).onDestroy(() => clearInterval(tick));
  }

  // Prefer whichever is more recent. They usually agree; they diverge after a reload (only the
  // server's survives) and during a live session on a reconcile that confirmed no change.
  protected confirmedAt = computed<number | null>(() => {
    const server = this.lastConfirmedAt() ? Date.parse(this.lastConfirmedAt()!) : NaN;
    const local = this.receivedAt();
    const candidates = [Number.isNaN(server) ? null : server, local ?? null].filter(
      (v): v is number => v !== null,
    );
    return candidates.length ? Math.max(...candidates) : null;
  });

  protected isStale = computed(() => {
    const at = this.confirmedAt();
    return at !== null && this.now() - at > STALE_AFTER_MS;
  });

  protected label = computed(() => {
    const at = this.confirmedAt();
    if (at === null) return '';
    const ageMs = this.now() - at;
    // Under a minute the clock time is the more useful fact; past that, "how long ago" is what
    // the reader actually wants, and it is the only form that reads correctly across a reload.
    if (ageMs < 60_000) return new Date(at).toLocaleTimeString(undefined, { hour12: false });
    const mins = Math.floor(ageMs / 60_000);
    if (mins < 60) return `${mins}m ago`;
    const hours = Math.floor(mins / 60);
    if (hours < 24) return `${hours}h ago`;
    return `${Math.floor(hours / 24)}d ago`;
  });

  protected tooltip = computed(() => {
    const at = this.confirmedAt();
    if (at === null) return '';
    const when = new Date(at).toLocaleString();
    return this.isStale()
      ? `Last confirmed by the device at ${when} — it may have changed since`
      : `Confirmed by the device at ${when}`;
  });
}
