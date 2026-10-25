import { Component, computed, input } from '@angular/core';
import { MatIconModule } from '@angular/material/icon';
import {
  SCOPE_ICONS,
  ladderName,
  type ScopeStanding,
} from '../../services/retention-tiers.service';

// The "who decides" strip (F18.20): all six scopes in resolution order, the answering one filled.
// It is what makes "the whole list wins from the most specific scope" readable without a sentence
// explaining it — and why removing a list falls back where it does.

@Component({
  selector: 'app-scope-ladder',
  standalone: true,
  imports: [MatIconModule],
  template: `
    <ol
      class="ladder"
      [class.vertical]="vertical()"
      aria-label="Which list decides, most specific first"
    >
      @for (s of steps(); track s.scope) {
        <li class="step" [class.answer]="s.state === 'answering'" [class.na]="s.state === 'n/a'">
          <span class="step-name"
            ><mat-icon>{{ s.icon }}</mat-icon
            >{{ s.name }}</span
          >
          <span class="step-state">{{ s.status }}</span>
        </li>
      }
    </ol>
  `,
  styles: [
    `
      .ladder {
        display: flex;
        gap: 4px;
        margin: 0;
        padding: 0;
        list-style: none;
      }
      .step {
        flex: 1 1 0;
        min-width: 0;
        display: flex;
        flex-direction: column;
        gap: 3px;
        padding: 8px 10px;
        border-radius: 10px;
        border: 1px solid var(--card-divider);
        background: var(--card-bg);
      }
      .step-name {
        display: flex;
        align-items: center;
        gap: 4px;
        font-size: 12px;
        font-weight: 600;
        color: var(--text);
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      }
      .step-name mat-icon {
        flex: 0 0 auto;
        width: 15px;
        height: 15px;
        font-size: 15px;
      }
      .step-state {
        font-size: 11px;
        color: var(--text-muted);
      }
      .step.answer {
        background: var(--primary);
        border-color: var(--primary);
      }
      .step.answer .step-name,
      .step.answer .step-state {
        color: #fff;
      }
      .step.na {
        background: transparent;
        border-style: dashed;
      }
      .vertical {
        flex-direction: column;
        gap: 2px;
      }
      .vertical .step {
        flex-direction: row;
        align-items: center;
        justify-content: space-between;
        min-height: 36px;
        padding: 0 12px;
      }
      @media (max-width: 760px) {
        .ladder:not(.vertical) {
          flex-direction: column;
          gap: 2px;
        }
        .ladder:not(.vertical) .step {
          flex-direction: row;
          align-items: center;
          justify-content: space-between;
          padding: 6px 12px;
        }
      }
    `,
  ],
})
export class ScopeLadderComponent {
  scopes = input.required<ScopeStanding[]>();
  vertical = input<boolean>(false);

  steps = computed(() =>
    this.scopes().map((s) => ({
      scope: s.scope,
      state: s.state,
      icon: SCOPE_ICONS[s.scope],
      name: ladderName(s.scope),
      status: statusOf(s),
    })),
  );
}

function statusOf(s: ScopeStanding): string {
  switch (s.state) {
    case 'answering':
      return 'Decides';
    case 'has-list':
      return 'Has a list · not reached';
    case 'empty':
      return 'No list';
    case 'n/a':
      return s.scope === 'blueprint' ? 'Not in a setup' : 'No template covers it';
  }
}
