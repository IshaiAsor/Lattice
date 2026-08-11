import { Component, inject, signal, computed } from '@angular/core';
import { MatDialogRef } from '@angular/material/dialog';
import { MatSnackBar } from '@angular/material/snack-bar';
import { FormControl } from '@angular/forms';
import { toSignal } from '@angular/core/rxjs-interop';
import { SHARED_MATERIAL } from 'src/app/shared-ui';
import {
  UserPreferencesService,
  allTimeZones,
  browserTimeZone,
} from 'src/app/services/user-preferences.service';

/**
 * Which clock this account's schedules are read against.
 *
 * It matters because a schedule is a sentence about the user's own day — "water from 06:00 to
 * 17:30" — and before this it was evaluated wherever the worker happened to run, which in a
 * container is UTC. The default is this browser's zone, adopted silently at sign-in; this is where
 * someone whose devices are somewhere else can say so.
 */
@Component({
  selector: 'app-timezone-dialog',
  standalone: true,
  imports: [SHARED_MATERIAL],
  templateUrl: './timezone-dialog.component.html',
  styleUrl: './timezone-dialog.component.css',
})
export class TimezoneDialogComponent {
  private prefs = inject(UserPreferencesService);
  private snack = inject(MatSnackBar);
  ref = inject(MatDialogRef<TimezoneDialogComponent>);

  readonly detected = browserTimeZone();
  private readonly zones = allTimeZones();

  saving = signal(false);
  filter = new FormControl('', { nonNullable: true });
  selected = signal<string>(this.prefs.timezone() ?? this.detected);

  private query = toSignal(this.filter.valueChanges, { initialValue: '' });

  /**
   * Capped: the full IANA list is ~450 entries and rendering all of them makes the list unusable.
   *
   * The current and detected zones are hoisted to the top, because the cap is alphabetical and
   * would otherwise hide them — Africa/* and America/* fill the first hundred on their own, so
   * someone in Asia/Jerusalem opened the dialog and could not see their own zone at all.
   */
  filteredZones = computed(() => {
    const q = this.query().trim().toLowerCase();
    const matches = q ? this.zones.filter((z) => z.toLowerCase().includes(q)) : this.zones;
    const pinned = [this.selected(), this.detected].filter((z) => matches.includes(z));
    const rest = matches.filter((z) => !pinned.includes(z));
    return [...new Set([...pinned, ...rest])].slice(0, 100);
  });

  constructor() {
    // The dialog may be the first thing to need the profile; harmless if it is already loaded.
    this.prefs.load().subscribe({
      next: (u) => this.selected.set(u.timezone ?? this.detected),
      error: () => undefined,
    });
  }

  /** What the chosen zone reads right now — the check that catches picking the wrong continent. */
  nowThere(): string {
    try {
      return new Intl.DateTimeFormat(undefined, {
        timeZone: this.selected(),
        hour: '2-digit',
        minute: '2-digit',
        weekday: 'short',
      }).format(new Date());
    } catch {
      return '—';
    }
  }

  useDetected(): void {
    this.selected.set(this.detected);
  }

  save(): void {
    this.saving.set(true);
    this.prefs.setTimezone(this.selected()).subscribe({
      next: () => {
        this.snack.open(`Schedules now follow ${this.selected()}`, 'Close', { duration: 3000 });
        this.ref.close(this.selected());
      },
      error: () => {
        this.saving.set(false);
        this.snack.open('Could not save the timezone', 'Close', { duration: 3000 });
      },
    });
  }
}
