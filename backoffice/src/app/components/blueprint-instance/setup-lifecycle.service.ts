import { inject, Injectable } from '@angular/core';
import { MatDialog } from '@angular/material/dialog';
import { Observable, of, switchMap } from 'rxjs';
import {
  BlueprintsService,
  InstancePhase,
  InstanceView,
} from 'src/app/services/blueprints.service';
import { ConfirmDialogComponent } from '../admin-device-config/confirm-dialog.component';
import { StartSetupDialogComponent, StartSetupResult } from './start-setup-dialog.component';

// Start / stop / reset, in one place (F10.13). Both the setups list and the instance page offer
// all three, and they are not one-press actions — starting asks which phase and how far into it,
// stopping holds every automation the setup owns and says so first. Duplicating that across two
// components is how the two would drift into telling the user different things about the same act.
//
// Each method resolves to the updated instance, or **null** when the user backed out, so callers
// can treat "cancelled" and "failed" differently: cancelling is not an error and must not raise a
// snackbar.

@Injectable({ providedIn: 'root' })
export class SetupLifecycleService {
  private blueprints = inject(BlueprintsService);
  private dialog = inject(MatDialog);

  /**
   * Start or resume. `phases` is optional: the instance page already holds them, the setups list
   * does not, and choosing a phase needs them all — so this fetches when they are not supplied,
   * one extra read on a deliberate click rather than on every list render.
   */
  start(
    id: number,
    opts: {
      phases?: InstancePhase[];
      defaultPhaseKey?: string | null;
      resuming?: boolean;
    } = {},
  ): Observable<InstanceView | null> {
    const source: Observable<InstancePhase[]> = opts.phases
      ? of(opts.phases)
      : this.blueprints.getInstance(id).pipe(switchMap((i) => of(i.phases)));

    return source.pipe(
      switchMap((phases) => {
        // No phases to choose between and no clock to position — a blueprint that is not
        // time-dependent still pauses and continues, it just does so without a dialog.
        if (phases.length === 0) return this.blueprints.start(id);
        return this.dialog
          .open(StartSetupDialogComponent, {
            panelClass: ['glass-dialog', 'compact-dialog'],
            data: {
              phases,
              defaultPhaseKey:
                opts.defaultPhaseKey ?? phases.find((p) => p.is_current)?.key ?? phases[0]!.key,
              resuming: opts.resuming ?? false,
            },
          })
          .afterClosed()
          .pipe(
            switchMap((result: StartSetupResult | undefined) =>
              result
                ? this.blueprints.start(id, result.phase_key, result.timer, result.elapsed_seconds)
                : of(null),
            ),
          );
      }),
    );
  }

  /**
   * Pause, behind a confirm. Pausing holds *everything* the setup owns, emergency rules included,
   * so it is stated before the fact rather than discovered after — a user who thinks they are
   * pausing a schedule must not silently switch off a safety rule.
   */
  stop(id: number, heldCount?: number): Observable<InstanceView | null> {
    const held =
      heldCount === undefined
        ? 'Every automation this setup owns'
        : `Its ${heldCount} automation${heldCount === 1 ? '' : 's'}`;
    return this.dialog
      .open(ConfirmDialogComponent, {
        panelClass: ['glass-dialog', 'compact-dialog'],
        data: {
          title: 'Pause this setup',
          message:
            `${held} will be held until you continue it, including any marked as ` +
            'emergencies. The time in the current phase is kept, so continuing carries on ' +
            'from here.',
          confirmLabel: 'Pause',
        },
      })
      .afterClosed()
      .pipe(switchMap((ok) => (ok ? this.blueprints.stop(id) : of(null))));
  }

  /** Back to never-started. Destructive about time and nothing else. */
  reset(id: number): Observable<InstanceView | null> {
    return this.dialog
      .open(ConfirmDialogComponent, {
        panelClass: ['glass-dialog', 'compact-dialog'],
        data: {
          title: 'Reset the lifecycle',
          message:
            'This setup goes back to not started, and the time counted in every phase is ' +
            'discarded. Your devices, settings and automations are all kept.',
          confirmLabel: 'Reset',
        },
      })
      .afterClosed()
      .pipe(switchMap((ok) => (ok ? this.blueprints.resetLifecycle(id) : of(null))));
  }
}
