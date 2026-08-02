import { Component, inject } from '@angular/core';
import { MAT_DIALOG_DATA, MatDialogRef } from '@angular/material/dialog';
import { MatRadioModule } from '@angular/material/radio';
import { SHARED_MATERIAL } from 'src/app/shared-ui';
import { InstancePhase, PhaseTimerMode } from 'src/app/services/blueprints.service';
import { PHASE_UNITS, formatDuration } from './phase-timer.util';

// Changing phase (F10.12). Moving between phases never rewrites an automation — it only changes
// what `@phase.x` references resolve to — so the consequential part of the act is the *timer*:
// whether the phase being entered counts from zero, from the time it banked on an earlier visit,
// or from somewhere the user picks.
//
// That is why this is a dialog rather than a straight click. Before banks existed, rolling a phase
// back silently restarted it, which is the bug this whole feature answers; making the choice
// explicit is the fix, so the dialog is shown for every move, including onto the phase already
// running (where it means "restart" or "reposition").

export interface PhaseChangeDialogData {
  phase: InstancePhase;
  /** True when this is the phase the setup is already in — Resume then has no earlier visit. */
  isCurrent: boolean;
  /** False for the last phase: nothing follows it, so it can never auto-advance away. */
  hasNextPhase: boolean;
}

export interface PhaseChangeResult {
  timer: PhaseTimerMode;
  elapsed_seconds: number;
}

@Component({
  selector: 'app-phase-change-dialog',
  imports: [SHARED_MATERIAL, MatRadioModule],
  template: `
    <div class="sheet-handle"></div>
    <h2 mat-dialog-title>{{ data.isCurrent ? 'Restart' : 'Move to' }} “{{ data.phase.name }}”</h2>
    <mat-dialog-content>
      @if (canResume()) {
        <p class="lead">This setup spent {{ banked() }} in {{ data.phase.name }} before.</p>
      } @else if (data.isCurrent) {
        <p class="lead">It has been in {{ data.phase.name }} for {{ elapsedNow() }}.</p>
      }

      <mat-radio-group class="modes" [(ngModel)]="mode" (ngModelChange)="onModeChange()">
        <mat-radio-button value="reset">
          <span class="mode-label">Start fresh</span>
          <span class="mode-hint">counts from 0</span>
        </mat-radio-button>

        @if (canResume()) {
          <mat-radio-button value="resume">
            <span class="mode-label">Resume</span>
            <span class="mode-hint"
              >{{ banked() }} in{{ remainingHint(data.phase.accrued_seconds) }}</span
            >
          </mat-radio-button>
        }

        <mat-radio-button value="at">
          <span class="mode-label">Start at</span>
          <span class="mode-hint">{{ remainingHint(atSeconds()) || 'a point you choose' }}</span>
        </mat-radio-button>
      </mat-radio-group>

      <div class="at-row" [class.disabled]="mode !== 'at'">
        <mat-form-field appearance="outline" class="at-value">
          <input
            matInput
            type="number"
            min="0"
            [(ngModel)]="atValue"
            [disabled]="mode !== 'at'"
            (focus)="mode = 'at'"
          />
        </mat-form-field>
        <mat-form-field appearance="outline" class="at-unit">
          <mat-select [(ngModel)]="atUnit" [disabled]="mode !== 'at'">
            @for (unit of units; track unit.key) {
              <mat-option [value]="unit.key">{{ unit.label }}</mat-option>
            }
          </mat-select>
        </mat-form-field>
      </div>

      <!-- A property of the chosen value, not of the mode: a large "Start at" earns the same
           warning as a Resume that overshoots. -->
      @if (willAdvanceImmediately()) {
        <p class="warn-row">
          <mat-icon>schedule</mat-icon>
          <span>
            {{ data.phase.name }} advances automatically after {{ limit() }}. That is past it, so it
            will advance again straight away.
          </span>
        </p>
      }
    </mat-dialog-content>
    <mat-dialog-actions align="end">
      <button mat-button mat-dialog-close>Cancel</button>
      <button mat-flat-button color="primary" (click)="apply()">
        {{ data.isCurrent ? 'Restart' : 'Move' }}
      </button>
    </mat-dialog-actions>
  `,
  styles: [
    `
      .sheet-handle {
        width: 36px;
        height: 4px;
        background: var(--border-strong, #ccc);
        border-radius: 2px;
        margin: 12px auto 0;
      }
      .lead {
        margin: 0 0 12px;
        font-size: 14px;
        color: var(--text-muted);
        line-height: 1.5;
      }
      .modes {
        display: flex;
        flex-direction: column;
        gap: 2px;
      }
      .mode-label {
        font-weight: 600;
        font-size: 14px;
      }
      .mode-hint {
        display: block;
        font-size: 12px;
        color: var(--text-dim);
      }
      .at-row {
        display: flex;
        gap: 8px;
        align-items: center;
        margin: 8px 0 0 32px;
        transition: opacity 0.15s ease;
      }
      .at-row.disabled {
        opacity: 0.5;
      }
      .at-value {
        width: 90px;
      }
      .at-unit {
        width: 130px;
      }
      .warn-row {
        display: flex;
        gap: 8px;
        align-items: flex-start;
        margin: 4px 0 0;
        font-size: 12px;
        line-height: 1.45;
        color: var(--text-muted);
      }
      .warn-row mat-icon {
        flex: none;
        font-size: 18px;
        width: 18px;
        height: 18px;
        color: var(--warn, #e0a030);
      }
    `,
  ],
})
export class PhaseChangeDialogComponent {
  data: PhaseChangeDialogData = inject(MAT_DIALOG_DATA);
  private dialogRef = inject(MatDialogRef<PhaseChangeDialogComponent>);

  readonly units = PHASE_UNITS;
  mode: PhaseTimerMode;
  atValue = 0;
  atUnit = 'days';

  constructor() {
    // Resume is the useful default exactly when there is something to resume — that is the
    // rollback case this feature exists for. Otherwise starting fresh is one Enter press.
    this.mode = this.canResume() ? 'resume' : 'reset';
  }

  /** Nothing to resume on the phase already running, nor on one never visited. */
  canResume(): boolean {
    return !this.data.isCurrent && this.data.phase.accrued_seconds > 0;
  }

  banked(): string {
    return formatDuration(this.data.phase.accrued_seconds);
  }

  elapsedNow(): string {
    return formatDuration(this.data.phase.elapsed_seconds);
  }

  limit(): string {
    return formatDuration(this.data.phase.duration_seconds ?? 0);
  }

  atSeconds(): number {
    const unit = PHASE_UNITS.find((u) => u.key === this.atUnit);
    const value = Number(this.atValue);
    if (!unit || !Number.isFinite(value) || value < 0) return 0;
    return Math.floor(value * unit.seconds);
  }

  /** Seconds the chosen mode would put on the clock. */
  private chosenSeconds(): number {
    if (this.mode === 'resume') return this.data.phase.accrued_seconds;
    if (this.mode === 'at') return this.atSeconds();
    return 0;
  }

  /** "· 10d 20h left" for a limited phase, empty for one with no limit. */
  remainingHint(seconds: number): string {
    const limit = this.data.phase.duration_seconds;
    if (limit === null) return seconds > 0 ? ` · ${formatDuration(seconds)} in` : '';
    const left = limit - seconds;
    return left > 0 ? ` · ${formatDuration(left)} left` : ' · already past the end';
  }

  willAdvanceImmediately(): boolean {
    const limit = this.data.phase.duration_seconds;
    if (limit === null || !this.data.phase.auto_advance || !this.data.hasNextPhase) return false;
    return this.chosenSeconds() >= limit;
  }

  /** Typing into the value box selects "Start at"; switching away leaves the text alone. */
  onModeChange(): void {
    if (this.mode === 'at' && this.atValue === 0 && this.data.phase.accrued_seconds > 0) {
      // Seed the box with the bank so the user edits a real number rather than starting from 0.
      this.atValue = Math.max(1, Math.round(this.data.phase.accrued_seconds / 86400));
      this.atUnit = 'days';
    }
  }

  apply(): void {
    this.dialogRef.close({
      timer: this.mode,
      elapsed_seconds: this.mode === 'at' ? this.atSeconds() : 0,
    } satisfies PhaseChangeResult);
  }
}
