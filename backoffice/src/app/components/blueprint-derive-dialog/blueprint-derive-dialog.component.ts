import { Component, inject } from '@angular/core';
import { MAT_DIALOG_DATA, MatDialogRef } from '@angular/material/dialog';
import { MatSnackBar } from '@angular/material/snack-bar';
import { SHARED_MATERIAL } from 'src/app/shared-ui';
import {
  BlueprintsService,
  DerivePreview,
  DeriveResult,
  SlotCandidate,
  SlotMatch,
} from 'src/app/services/blueprints.service';

// The derive wizard (F10.8). Deliberately one screen, not a stepper: the only genuine decisions
// are a name and — for slots where more than one device qualifies — which device. Auto-bound slots
// are shown filled in and confirmable rather than hidden, so the user can see everything the setup
// will take over before it does.
@Component({
  selector: 'app-blueprint-derive-dialog',
  imports: [SHARED_MATERIAL],
  templateUrl: './blueprint-derive-dialog.component.html',
  styleUrl: './blueprint-derive-dialog.component.css',
})
export class BlueprintDeriveDialogComponent {
  private blueprints = inject(BlueprintsService);
  private snackBar = inject(MatSnackBar);
  private dialogRef =
    inject<MatDialogRef<BlueprintDeriveDialogComponent, DeriveResult>>(MatDialogRef);

  preview: DerivePreview = inject<{ preview: DerivePreview }>(MAT_DIALOG_DATA).preview;
  name = this.preview.name;
  /**
   * slot_key → chosen user_device_ids. A list because a multi-device slot binds several. Seeded
   * from auto_bind (all fitting candidates) so nothing starts empty when the match is unambiguous.
   */
  chosen: Record<string, number[]> = Object.fromEntries(
    this.preview.slots.map((s) => [s.slot_key, this.initialPick(s)]),
  );
  submitting = false;
  error: string | null = null;

  private initialPick(s: SlotMatch): number[] {
    if (s.auto_bind.length > 0) return [...s.auto_bind];
    // A single-device slot defaults to its one free candidate; a multi slot with no obvious set is
    // left for the user to pick. Never default to a device already in another setup — the server
    // rejects it, so pre-selecting one would arm the dialog with a guaranteed 400.
    const free = this.freeCandidates(s);
    if (s.max_count <= 1 && free[0]) return [free[0].user_device_id];
    return [];
  }

  /**
   * Devices this slot can actually take. A device bound to another setup is still *listed* — the
   * user should see it and why it is unavailable — but it is never selectable, so every count that
   * drives a decision reads from here rather than from `candidates`.
   */
  freeCandidates(slot: SlotMatch): SlotCandidate[] {
    return slot.candidates.filter((c) => c.free);
  }

  /** The one device an unambiguous slot resolved to, for the read-only "matched" row. */
  soleFree(slot: SlotMatch): SlotCandidate | null {
    const free = this.freeCandidates(slot);
    return free.length === 1 ? free[0]! : null;
  }

  /** Listed but unavailable — drives the "already in use" note when a slot has no free device. */
  hasOnlyTaken(slot: SlotMatch): boolean {
    return slot.candidates.length > 0 && this.freeCandidates(slot).length === 0;
  }

  /**
   * Whether this candidate needs its MAC shown to be identifiable. Two sealed boards of one type
   * are named identically until renamed, so "HYDRO_FARM_WATER_TANK_MANAGER" on its own cannot say
   * *which* board a slot took — and when one of the pair is already in another setup, that is
   * exactly the question the user is asking.
   */
  needsMac(slot: SlotMatch, candidate: SlotCandidate): boolean {
    return slot.candidates.some(
      (c) => c.user_device_id !== candidate.user_device_id && c.name === candidate.name,
    );
  }

  isMulti(slot: SlotMatch): boolean {
    return slot.max_count > 1;
  }

  /** Slots with a real decision to make — the rest are shown but not asked about. */
  needsChoice(slot: SlotMatch): boolean {
    const free = this.freeCandidates(slot).length;
    return this.isMulti(slot) ? free > 0 : free > 1;
  }

  /** Single-select bridge: the ngModel of a one-device slot is a scalar over the id list. */
  singlePick(slot: SlotMatch): number | null {
    return this.chosen[slot.slot_key]?.[0] ?? null;
  }
  setSingle(slot: SlotMatch, value: number | null): void {
    this.chosen[slot.slot_key] = value == null ? [] : [value];
  }

  /** How many devices a slot has picked, for the multi-select count hint. */
  pickedCount(slot: SlotMatch): number {
    return this.chosen[slot.slot_key]?.length ?? 0;
  }

  private slotSatisfied(s: SlotMatch): boolean {
    const n = this.pickedCount(s);
    if (n > s.max_count) return false;
    return s.required ? n >= Math.max(s.min_count, 1) : true;
  }

  canSubmit(): boolean {
    if (!this.name.trim() || this.submitting) return false;
    return this.preview.slots.every((s) => this.slotSatisfied(s));
  }

  submit(): void {
    if (!this.canSubmit()) return;
    this.submitting = true;
    this.error = null;

    // Every chosen device is sent explicitly, including the auto-bound ones the user just
    // confirmed — the server records auto_bound=false for them, which is accurate: a human
    // approved this. A multi-device slot contributes one binding per picked device.
    const bindings = this.preview.slots.flatMap((s) =>
      (this.chosen[s.slot_key] ?? []).map((id) => ({ slot_key: s.slot_key, user_device_id: id })),
    );

    this.blueprints.derive(this.preview.blueprint_id, this.name.trim(), bindings).subscribe({
      next: (result) => this.dialogRef.close(result),
      error: (err) => {
        this.submitting = false;
        this.error = err?.error?.error ?? 'Could not create the setup';
        this.snackBar.open(this.error!, 'Close', { duration: 4000 });
      },
    });
  }

  cancel(): void {
    this.dialogRef.close();
  }
}
