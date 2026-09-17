import { DestroyRef, Directive, ElementRef, NgZone, inject } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { CdkDrag } from '@angular/cdk/drag-drop';

/** How long a finger must rest on a card's drag rail before the card can be moved. */
export const LONG_PRESS_DRAG_MS = 2000;

// CDK's default dragStartThreshold. A finger that travels this far (|dx| + |dy|) before the delay
// has elapsed makes CDK abandon the press, so the cue is abandoned at the same point — otherwise it
// would go on to say "ready" for a press CDK has already dropped.
const MOVE_TOLERANCE_PX = 5;

/**
 * Touch drags on a dashboard card wait for a long press on its rail. An immediate touch drag let a
 * thumb scrolling past the rail pick a card up and drop it on its neighbour, grouping the two by
 * accident. A mouse drag is never accidental, so it stays immediate.
 *
 * CDK does the gating (dragStartDelay); what CDK lacks is any sign of when the delay is up, so this
 * also marks the host `drag-arming` while the finger is held and `drag-armed` once a move will pick
 * the card up (styles.css). A move before then cancels the press, and the finger has to lift and
 * press again.
 */
@Directive({
  selector: '[appLongPressDrag]',
  standalone: true,
  host: {
    class: 'long-press-drag',
    '[style.--long-press-ms]': 'pressDuration',
  },
})
export class LongPressDragDirective {
  readonly pressDuration = `${LONG_PRESS_DRAG_MS}ms`;

  private host: HTMLElement = inject(ElementRef).nativeElement;
  private drag = inject(CdkDrag);
  private timer: ReturnType<typeof setTimeout> | undefined;
  private origin: { x: number; y: number } | null = null;

  constructor() {
    this.drag.dragStartDelay = { touch: LONG_PRESS_DRAG_MS, mouse: 0 };
    this.drag.ended.pipe(takeUntilDestroyed()).subscribe(() => this.reset());

    // Straight class toggles outside the zone: a touchmove per frame has no reason to run change
    // detection over the whole dashboard.
    const listeners: [string, EventListener][] = [
      ['touchstart', (e) => this.onTouchStart(e as TouchEvent)],
      ['touchmove', (e) => this.onTouchMove(e as TouchEvent)],
      ['touchend', () => this.reset()],
      ['touchcancel', () => this.reset()],
    ];
    inject(NgZone).runOutsideAngular(() => {
      for (const [type, fn] of listeners) {
        this.host.addEventListener(type, fn, { passive: true });
      }
    });
    inject(DestroyRef).onDestroy(() => {
      this.reset();
      for (const [type, fn] of listeners) this.host.removeEventListener(type, fn);
    });
  }

  private onTouchStart(event: TouchEvent) {
    // CDK only starts from a handle, and never for a second finger or a disabled drag.
    const onHandle = (event.target as Element).closest('.cdk-drag-handle') !== null;
    this.reset();
    if (event.touches.length !== 1 || !onHandle || this.drag.disabled) return;
    this.origin = { x: event.touches[0].clientX, y: event.touches[0].clientY };
    this.host.classList.add('drag-arming');
    this.timer = setTimeout(() => {
      this.host.classList.add('drag-armed');
      if ('vibrate' in navigator) navigator.vibrate(20);
    }, LONG_PRESS_DRAG_MS);
  }

  private onTouchMove(event: TouchEvent) {
    if (!this.origin || this.host.classList.contains('drag-armed')) return;
    const touch = event.touches[0];
    const travelled =
      Math.abs(touch.clientX - this.origin.x) + Math.abs(touch.clientY - this.origin.y);
    if (travelled >= MOVE_TOLERANCE_PX) this.reset();
  }

  private reset() {
    clearTimeout(this.timer);
    this.timer = undefined;
    this.origin = null;
    this.host.classList.remove('drag-arming', 'drag-armed');
  }
}
