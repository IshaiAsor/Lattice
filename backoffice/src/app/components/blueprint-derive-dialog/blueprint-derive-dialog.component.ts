import { Component, inject } from '@angular/core';
import { MAT_DIALOG_DATA, MatDialogRef } from '@angular/material/dialog';
import { MatSnackBar } from '@angular/material/snack-bar';
import { SHARED_MATERIAL } from 'src/app/shared-ui';
import {
  BlueprintsService,
  DeriveBinding,
  DerivePreview,
  DeriveResult,
  FieldPrompt,
  SlotCandidate,
  SlotMatch,
} from 'src/app/services/blueprints.service';

// The derive wizard (F10.8). Deliberately one screen, not a stepper: the only genuine decisions
// are a name and — for slots where more than one device qualifies — which device. Auto-bound slots
// are shown filled in and confirmable rather than hidden, so the user can see everything the setup
// will take over before it does.
//
// Two things the blueprint may add to that (F11):
//
//   - A **profiled** slot means each device it binds runs its own schedule, so the wizard asks per
//     device rather than per slot. The answer may come from a form question instead (below), which
//     is why the profile picker only appears when nothing else has decided it.
//   - A **dynamic form** — questions the author declared. A `select` option may name a profile, so
//     one question both records a fact and picks the schedule; that is the shape a real blueprint
//     uses, and asking twice for the same thing is exactly what it avoids.
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
  /** `${slot_key}::${device_id}` → the profile chosen for that one device (F11). */
  profileByDevice: Record<string, string | null> = {};
  /** `${slot_key}::${device_id}` → what the user calls it, so six identical boards stay tellable. */
  labelByDevice: Record<string, string> = {};
  /** field key → answer, for the setup-scoped questions. */
  setupAnswers: Record<string, string> = {};
  /** `${slot_key}::${device_id}` → { field key → answer }, for the per-device questions. */
  deviceAnswers: Record<string, Record<string, string>> = {};
  submitting = false;
  error: string | null = null;

  constructor() {
    // Defaults are pre-filled rather than left blank so the common case is one click: a blueprint
    // with a single profile has no choice to make, and a field with a default is already answered.
    for (const field of this.preview.fields) {
      if (field.scope === 'setup' && field.default_value) {
        this.setupAnswers[field.key] = field.default_value;
      }
    }
  }

  // ── The dynamic form (F11.6) ──────────────────────────────────────────────

  setupFields(): FieldPrompt[] {
    return this.preview.fields.filter((f) => f.scope === 'setup');
  }

  fieldsForSlot(slot: SlotMatch): FieldPrompt[] {
    return this.preview.fields.filter(
      (f) => f.scope === 'binding' && f.slot_key === slot.slot_key,
    );
  }

  answersFor(slot: SlotMatch, deviceId: number): Record<string, string> {
    const key = this.deviceKey(slot, deviceId);
    if (!this.deviceAnswers[key]) {
      this.deviceAnswers[key] = Object.fromEntries(
        this.fieldsForSlot(slot)
          .filter((f) => f.default_value)
          .map((f) => [f.key, f.default_value!]),
      );
    }
    return this.deviceAnswers[key]!;
  }

  /** Record an answer, and let an option that names a profile decide this device's schedule. */
  answerDeviceField(slot: SlotMatch, deviceId: number, field: FieldPrompt, value: string): void {
    this.answersFor(slot, deviceId)[field.key] = value;
    const implied = field.options.find((o) => o.value === value)?.profile_key;
    if (implied) this.profileByDevice[this.deviceKey(slot, deviceId)] = implied;
  }

  /** True when a form answer already decides the profile, so the picker is not shown as well. */
  profileComesFromForm(slot: SlotMatch): boolean {
    return this.fieldsForSlot(slot).some((f) => f.options.some((o) => o.profile_key));
  }

  // ── Per-device profile + label (F11) ──────────────────────────────────────

  deviceKey(slot: SlotMatch, deviceId: number): string {
    return `${slot.slot_key}::${deviceId}`;
  }

  /** The devices currently picked for a slot, resolved to their candidate rows. */
  pickedDevices(slot: SlotMatch): SlotCandidate[] {
    const ids = this.chosen[slot.slot_key] ?? [];
    return ids
      .map((id) => slot.candidates.find((c) => c.user_device_id === id))
      .filter((c): c is SlotCandidate => c !== undefined);
  }

  /** Whether this slot needs per-device questions at all. */
  needsPerDevice(slot: SlotMatch): boolean {
    return slot.profiled || this.fieldsForSlot(slot).length > 0;
  }

  profileFor(slot: SlotMatch, deviceId: number): string | null {
    const key = this.deviceKey(slot, deviceId);
    if (this.profileByDevice[key] !== undefined) return this.profileByDevice[key];
    // One profile is not a choice — it is the answer, so it is taken rather than asked for.
    return this.preview.profiles.length === 1 ? this.preview.profiles[0]!.key : null;
  }

  setProfile(slot: SlotMatch, deviceId: number, value: string | null): void {
    this.profileByDevice[this.deviceKey(slot, deviceId)] = value;
  }

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
    if (!this.preview.slots.every((s) => this.slotSatisfied(s))) return false;
    // A required question with no answer would be a 400 from the server; better to hold the button
    // than to submit something the server has already told us it will reject.
    for (const field of this.setupFields()) {
      if (field.required && !this.setupAnswers[field.key]) return false;
    }
    for (const slot of this.preview.slots) {
      for (const device of this.pickedDevices(slot)) {
        if (slot.profiled && !this.profileFor(slot, device.user_device_id)) return false;
        const answers = this.answersFor(slot, device.user_device_id);
        for (const field of this.fieldsForSlot(slot)) {
          if (field.required && !answers[field.key]) return false;
        }
      }
    }
    return true;
  }

  submit(): void {
    if (!this.canSubmit()) return;
    this.submitting = true;
    this.error = null;

    // Every chosen device is sent explicitly, including the auto-bound ones the user just
    // confirmed — the server records auto_bound=false for them, which is accurate: a human
    // approved this. A multi-device slot contributes one binding per picked device.
    const bindings: DeriveBinding[] = this.preview.slots.flatMap((s) =>
      (this.chosen[s.slot_key] ?? []).map((id) => {
        const answers = this.answersFor(s, id);
        const label = this.labelByDevice[this.deviceKey(s, id)]?.trim();
        return {
          slot_key: s.slot_key,
          user_device_id: id,
          ...(s.profiled ? { profile_key: this.profileFor(s, id) } : {}),
          ...(label ? { label } : {}),
          ...(Object.keys(answers).length > 0
            ? {
                field_values: Object.entries(answers).map(([field_key, value]) => ({
                  field_key,
                  value,
                })),
              }
            : {}),
        };
      }),
    );
    const fieldValues = Object.entries(this.setupAnswers).map(([field_key, value]) => ({
      field_key,
      value,
    }));

    this.blueprints
      .derive(this.preview.blueprint_id, this.name.trim(), bindings, fieldValues)
      .subscribe({
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
