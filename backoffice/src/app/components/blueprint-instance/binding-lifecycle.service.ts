import { inject, Injectable } from '@angular/core';
import { MatDialog } from '@angular/material/dialog';
import { Observable, of, switchMap } from 'rxjs';
import {
  BindingView,
  BlueprintsService,
  ProfileOption,
} from 'src/app/services/blueprints.service';
import { ConfirmDialogComponent } from '../admin-device-config/confirm-dialog.component';
import { StartSetupDialogComponent, StartSetupResult } from './start-setup-dialog.component';
import { PhaseChangeDialogComponent, PhaseChangeResult } from './phase-change-dialog.component';
import {
  ResetBindingDialogComponent,
  ResetBindingResult,
} from './reset-binding-dialog.component';

// Start / stop / reset / change-phase for ONE bound device (F11.4) — the exact counterpart of
// SetupLifecycleService, one level down.
//
// It reuses the same two dialogs rather than growing its own: what the user is deciding is
// identical (which phase, and how far into it), and two near-copies would eventually word the same
// question differently. That is also why BindingView.phases carries the same shape the setup's
// phases do.
//
// Each method resolves to the updated binding, or **null** when the user backed out, so callers can
// treat "cancelled" and "failed" differently.

@Injectable({ providedIn: 'root' })
export class BindingLifecycleService {
  private blueprints = inject(BlueprintsService);
  private dialog = inject(MatDialog);

  start(binding: BindingView): Observable<BindingView | null> {
    if (binding.phases.length === 0) return this.blueprints.startBinding(binding.binding_id);
    return this.dialog
      .open(StartSetupDialogComponent, {
        panelClass: ['glass-dialog', 'compact-dialog'],
        data: {
          phases: binding.phases,
          defaultPhaseKey:
            binding.phases.find((p) => p.is_current)?.key ?? binding.phases[0]!.key,
          resuming: binding.lifecycle_state === 'stopped',
        },
      })
      .afterClosed()
      .pipe(
        switchMap((result: StartSetupResult | undefined) =>
          result
            ? this.blueprints.startBinding(
                binding.binding_id,
                result.phase_key,
                result.timer,
                result.elapsed_seconds,
              )
            : of(null),
        ),
      );
  }

  /**
   * Pause one device. Only the automations that belong to *it* are held — the rest of the setup
   * carries on — which is the whole difference from pausing the setup, and so is what it says.
   *
   * Takes only what it needs rather than a whole BindingView: the setups list holds a device's
   * track, not its params, and fetching the full view just to name it in a confirm would be a read
   * spent on nothing. A BindingView still satisfies it, so the detail page is unchanged.
   */
  stop(binding: { binding_id: number; label: string }): Observable<BindingView | null> {
    return this.dialog
      .open(ConfirmDialogComponent, {
        panelClass: ['glass-dialog', 'compact-dialog'],
        data: {
          title: `Pause “${binding.label}”`,
          message:
            'Only the automations that belong to this device are held, including any marked as ' +
            'emergencies. The rest of the setup keeps running. Its time in the current phase is ' +
            'kept, so continuing carries on from here.',
          confirmLabel: 'Pause',
        },
      })
      .afterClosed()
      .pipe(switchMap((ok) => (ok ? this.blueprints.stopBinding(binding.binding_id) : of(null))));
  }

  /** Back to not started — and optionally onto a different schedule. */
  reset(binding: BindingView, profiles: ProfileOption[]): Observable<BindingView | null> {
    return this.dialog
      .open(ResetBindingDialogComponent, {
        panelClass: ['glass-dialog', 'compact-dialog'],
        data: {
          label: binding.label,
          currentProfileKey: binding.profile_key,
          profiles,
        },
      })
      .afterClosed()
      .pipe(
        switchMap((result: ResetBindingResult | undefined) =>
          result
            ? this.blueprints.resetBinding(binding.binding_id, result.profile_key)
            : of(null),
        ),
      );
  }

  /** Move this device to another phase of its own profile. */
  setPhase(binding: BindingView, phaseKey: string): Observable<BindingView | null> {
    const phase = binding.phases.find((p) => p.key === phaseKey);
    if (!phase) return of(null);
    return this.dialog
      .open(PhaseChangeDialogComponent, {
        panelClass: ['glass-dialog', 'compact-dialog'],
        data: {
          phase,
          isCurrent: phase.is_current,
          hasNextPhase: binding.phases.some((p) => p.ordinal > phase.ordinal),
        },
      })
      .afterClosed()
      .pipe(
        switchMap((result: PhaseChangeResult | undefined) =>
          result
            ? this.blueprints.setBindingPhase(
                binding.binding_id,
                phaseKey,
                result.timer,
                result.elapsed_seconds,
              )
            : of(null),
        ),
      );
  }
}
