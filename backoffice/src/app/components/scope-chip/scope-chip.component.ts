import { Component, input } from '@angular/core';
import { MatIconModule } from '@angular/material/icon';
import { SCOPE_ICONS, type TierScope } from '../../services/retention-tiers.service';

// "Decided by" (F18.20): which scope a list came from, one colour per scope, the same on the device
// page, a setup page and the blueprint builder — so a colour means the same thing wherever it is seen.

@Component({
  selector: 'app-scope-chip',
  standalone: true,
  imports: [MatIconModule],
  template: `<span class="chip" [class]="'s-' + scope()" [title]="text()"
    ><mat-icon>{{ icons[scope()] }}</mat-icon
    ><span class="chip-text">{{ text() }}</span></span
  >`,
  styles: [
    `
      :host {
        display: inline-flex;
        max-width: 100%;
        min-width: 0;
      }
      .chip {
        display: inline-flex;
        align-items: center;
        gap: 4px;
        max-width: 100%;
        padding: 2px 9px 2px 6px;
        border-radius: 999px;
        border: 1px solid transparent;
        font-size: 11.5px;
        font-weight: 600;
        white-space: nowrap;
      }
      .chip-text {
        overflow: hidden;
        text-overflow: ellipsis;
      }
      .chip mat-icon {
        flex: 0 0 14px;
        width: 14px;
        height: 14px;
        font-size: 14px;
      }
      .s-action {
        background: var(--primary);
        color: #fff;
      }
      .s-device {
        color: var(--stage-digest);
        background: color-mix(in srgb, var(--stage-digest) 12%, transparent);
        border-color: color-mix(in srgb, var(--stage-digest) 35%, transparent);
      }
      .s-blueprint {
        color: var(--stage-vlm);
        background: color-mix(in srgb, var(--stage-vlm) 10%, transparent);
        border-color: color-mix(in srgb, var(--stage-vlm) 30%, transparent);
      }
      .s-sealed {
        color: var(--stage-exec);
        background: color-mix(in srgb, var(--stage-exec) 10%, transparent);
        border-color: color-mix(in srgb, var(--stage-exec) 32%, transparent);
      }
      .s-user {
        color: var(--text);
        background: color-mix(in srgb, var(--text-muted) 12%, transparent);
        border-color: color-mix(in srgb, var(--text-muted) 30%, transparent);
      }
      .s-platform {
        color: var(--text-muted);
        border: 1px dashed var(--border-strong);
      }
    `,
  ],
})
export class ScopeChipComponent {
  scope = input.required<TierScope>();
  text = input.required<string>();
  readonly icons = SCOPE_ICONS;
}
