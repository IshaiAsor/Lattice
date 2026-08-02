import { Component, inject } from '@angular/core';
import { MAT_DIALOG_DATA, MatDialogRef } from '@angular/material/dialog';
import { MatRadioModule } from '@angular/material/radio';
import { SHARED_MATERIAL } from 'src/app/shared-ui';
import { InstancePhase, PhaseTimerMode } from 'src/app/services/blueprints.service';
import { PHASE_UNITS, formatDuration } from './phase-timer.util';

// Starting a setup (F10.13). Deriving one binds the devices; it says nothing about when the
// process those devices watch actually began — a board connected today may be watching something
// that started a fortnight ago. So starting asks the two questions only the user can answer:
// **which phase** the process is in, and **how far into it** it already is.
//
// The same dialog serves resuming a stopped setup, where both answers default to where it was
// parked, so carrying on is one press.

export interface StartSetupDialogData {
  phases: InstancePhase[];
  /** The phase to preselect — where it was parked, else the first. */
  defaultPhaseKey: string | null;
  /** True when resuming rather than starting for the first time; only changes the wording. */
  resuming: boolean;
}

export interface StartSetupResult {
  phase_key: string;
  timer: PhaseTimerMode;
  elapsed_seconds: number;
}

@Component({
  selector: 'app-start-setup-dialog',
  imports: [SHARED_MATERIAL, MatRadioModule],
  template: `
    <div class="sheet-handle"></div>
    <h2 mat-dialog-title>{{ data.resuming ? 'Start again' : 'Start this setup' }}</h2>
    <mat-dialog-content>
      <p class="lead">
        @if (data.resuming) {
          Pick up where it left off, or somewhere else in the lifecycle.
        } @else {
          Nothing in this setup runs until it starts. Say where in its lifecycle things already are
          — connecting the devices doesn’t tell us when the process itself began.
        }
      </p>

      <mat-form-field appearance="outline" class="phase-pick">
        <mat-label>Phase</mat-label>
        <mat-select [(ngModel)]="phaseKey" (ngModelChange)="onPhaseChange()">
          @for (phase of data.phases; track phase.key) {
            <mat-option [value]="phase.key">
              {{ phase.name }}
              @if (phase.duration_seconds !== null) {
                <span class="opt-hint">· {{ durationOf(phase) }}</span>
              }
            </mat-option>
          }
        </mat-select>
      </mat-form-field>

      <span class="how-far">How far into {{ selected()?.name }}?</span>

      <mat-radio-group class="modes" [(ngModel)]="mode">
        <mat-radio-button value="reset">
          <span class="mode-label">Just starting</span>
          <span class="mode-hint">counts from 0</span>
        </mat-radio-button>

        @if (canResume()) {
          <mat-radio-button value="resume">
            <span class="mode-label">Carry on</span>
            <span class="mode-hint">{{ banked() }} already counted</span>
          </mat-radio-button>
        }

        <mat-radio-button value="at">
          <span class="mode-label">Already underway</span>
          <span class="mode-hint">{{ remainingHint() || 'started a while ago' }}</span>
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
        <span class="at-suffix">in already</span>
      </div>

      @if (willAdvanceImmediately()) {
        <p class="warn-row">
          <mat-icon>schedule</mat-icon>
          <span>
            {{ selected()?.name }} advances automatically after {{ limit() }}. That is past it, so
            it will move on straight away.
          </span>
        </p>
      }
    </mat-dialog-content>
    <mat-dialog-actions align="end">
      <button mat-button mat-dialog-close>Cancel</button>
      <button mat-flat-button color="primary" (click)="apply()" [disabled]="!phaseKey">
        Start
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
        margin: 0 0 14px;
        font-size: 14px;
        color: var(--text-muted);
        line-height: 1.5;
      }
      .phase-pick {
        width: 100%;
      }
      .opt-hint {
        color: var(--text-dim);
        font-size: 12px;
      }
      .how-far {
        display: block;
        margin: 4px 0 6px;
        font-size: 13px;
        font-weight: 600;
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
        width: 120px;
      }
      .at-suffix {
        font-size: 12px;
        color: var(--text-dim);
        padding-bottom: 18px;
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
export class StartSetupDialogComponent {
  data: StartSetupDialogData = inject(MAT_DIALOG_DATA);
  private dialogRef = inject(MatDialogRef<StartSetupDialogComponent>);

  readonly units = PHASE_UNITS;
  phaseKey: string;
  mode: PhaseTimerMode;
  atValue = 0;
  atUnit = 'days';

  constructor() {
    this.phaseKey = this.data.defaultPhaseKey ?? this.data.phases[0]?.key ?? '';
    // Carrying on is the obvious default when the setup was parked mid-phase.
    this.mode = this.canResume() ? 'resume' : 'reset';
  }

  selected(): InstancePhase | undefined {
    return this.data.phases.find((p) => p.key === this.phaseKey);
  }

  canResume(): boolean {
    return (this.selected()?.accrued_seconds ?? 0) > 0;
  }

  banked(): string {
    return formatDuration(this.selected()?.accrued_seconds ?? 0);
  }

  limit(): string {
    return formatDuration(this.selected()?.duration_seconds ?? 0);
  }

  durationOf(phase: InstancePhase): string {
    return formatDuration(phase.duration_seconds ?? 0);
  }

  /** Switching phase invalidates a "carry on" that belonged to the previous one. */
  onPhaseChange(): void {
    if (this.mode === 'resume' && !this.canResume()) this.mode = 'reset';
  }

  atSeconds(): number {
    const unit = PHASE_UNITS.find((u) => u.key === this.atUnit);
    const value = Number(this.atValue);
    if (!unit || !Number.isFinite(value) || value < 0) return 0;
    return Math.floor(value * unit.seconds);
  }

  private chosenSeconds(): number {
    if (this.mode === 'resume') return this.selected()?.accrued_seconds ?? 0;
    if (this.mode === 'at') return this.atSeconds();
    return 0;
  }

  remainingHint(): string {
    const limit = this.selected()?.duration_seconds ?? null;
    const seconds = this.atSeconds();
    if (seconds <= 0) return '';
    if (limit === null) return `${formatDuration(seconds)} in`;
    const left = limit - seconds;
    return left > 0
      ? `${formatDuration(seconds)} in · ${formatDuration(left)} left`
      : 'past the end';
  }

  willAdvanceImmediately(): boolean {
    const phase = this.selected();
    if (!phase || phase.duration_seconds === null || !phase.auto_advance) return false;
    const hasNext = this.data.phases.some((p) => p.ordinal > phase.ordinal);
    return hasNext && this.chosenSeconds() >= phase.duration_seconds;
  }

  apply(): void {
    this.dialogRef.close({
      phase_key: this.phaseKey,
      timer: this.mode,
      elapsed_seconds: this.mode === 'at' ? this.atSeconds() : 0,
    } satisfies StartSetupResult);
  }
}
