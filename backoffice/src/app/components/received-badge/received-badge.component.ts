import { Component, input } from '@angular/core';
import { CommonModule } from '@angular/common';

@Component({
  selector: 'app-received-badge',
  standalone: true,
  imports: [CommonModule],
  template: `
    @if (receivedAt()) {
      <span class="received-badge" [class.overlay]="variant() === 'overlay'">
        <span class="material-symbols-outlined received-badge-icon">schedule</span>
        {{ receivedAt() | date:'HH:mm:ss' }}
      </span>
    }
  `,
  styles: [`
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
      background: rgba(0,0,0,0.55);
      border-color: rgba(255,255,255,0.15);
      backdrop-filter: blur(4px);
      -webkit-backdrop-filter: blur(4px);
    }
  `],
})
export class ReceivedBadgeComponent {
  receivedAt = input<number | undefined>();
  variant = input<'inline' | 'overlay'>('inline');
}
