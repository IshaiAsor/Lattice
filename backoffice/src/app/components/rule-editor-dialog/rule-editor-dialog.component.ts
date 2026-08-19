import { Component, ElementRef, inject, OnInit, ViewChild } from '@angular/core';
import { FormArray, FormBuilder, FormGroup, Validators } from '@angular/forms';
import { MAT_DIALOG_DATA, MatDialogRef } from '@angular/material/dialog';
import { MatButtonToggleModule } from '@angular/material/button-toggle';
import { SHARED_MATERIAL } from 'src/app/shared-ui';
import { DeviceActionView, DeviceView } from 'src/app/services/device.mgmt.service';
import { CreateRuleDto, UserRuleView } from 'src/app/services/user.rules.service';
import { actionControlType, ActionControlType } from 'src/app/utils/device-type.utils';

interface ConditionPrefill {
  days?: number[];
  until?: string;
  everyMinutes?: number | null;
  time?: string;
  user_device_id?: number | null;
  value?: string;
  status?: string;
  user_device_action_id?: number | null;
  operator?: string;
}

interface ActionPrefill {
  user_device_action_id?: number | null;
  target_state?: string;
  delay_seconds?: number;
}

interface ConditionFormValue {
  condition_type: string;
  time?: string;
  days?: boolean[];
  until?: string;
  everyMinutes?: number | null;
  device_id?: number;
  value?: unknown;
  user_device_action_id?: number;
  operator?: string;
}

interface ActionFormValue {
  user_device_action_id: number;
  target_state: unknown;
  delay_seconds: number;
}

export interface RuleEditorData {
  rule?: UserRuleView;
  actions: DeviceActionView[];
  devices: DeviceView[];
}

export type ConditionType = 'device_state' | 'threshold' | 'schedule' | 'device_status';

const DAY_LABELS = ['S', 'M', 'T', 'W', 'T', 'F', 'S'];
const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

const UNIT_MULT: Record<string, number> = { sec: 1, min: 60, hours: 3600 };

function decomposeCooldown(sec: number | null): { value: number; unit: string } {
  if (!sec) return { value: 0, unit: 'sec' };
  if (sec % 3600 === 0) return { value: sec / 3600, unit: 'hours' };
  if (sec % 60 === 0) return { value: sec / 60, unit: 'min' };
  return { value: sec, unit: 'sec' };
}

// The editor is a summary board plus one focused editing surface (a right drawer on desktop, a
// bottom sheet under 600px) — the same shell as the pipeline editor. These are the board's cards,
// the rail's rows and the panel's identities, all at once. Match (ALL/ANY) belongs to Conditions,
// so it lives at the top of that panel rather than floating in a form of its own.
export type RuleSectionKey = 'conditions' | 'actions' | 'timing' | 'priority';

export const NAME_REQUIRED = 'The rule needs a name.';

export const RULE_SECTION_META: { key: RuleSectionKey; label: string }[] = [
  { key: 'conditions', label: 'Conditions' },
  { key: 'actions', label: 'Actions' },
  { key: 'timing', label: 'Timing' },
  { key: 'priority', label: 'Priority' },
];

@Component({
  selector: 'app-rule-editor-dialog',
  standalone: true,
  imports: [...SHARED_MATERIAL, MatButtonToggleModule],
  templateUrl: './rule-editor-dialog.component.html',
  styleUrl: './rule-editor-dialog.component.css',
})
export class RuleEditorDialogComponent implements OnInit {
  dialogRef = inject(MatDialogRef<RuleEditorDialogComponent>);
  data: RuleEditorData = inject(MAT_DIALOG_DATA);
  fb = inject(FormBuilder);

  @ViewChild('nameInput') nameInput?: ElementRef<HTMLInputElement>;

  dayLabels = DAY_LABELS;
  dayNames = DAY_NAMES;
  readonly sectionMeta = RULE_SECTION_META;

  readonly cooldownUnits = [
    { value: 'sec', label: 'Seconds' },
    { value: 'min', label: 'Minutes' },
    { value: 'hours', label: 'Hours' },
  ];

  form!: FormGroup;

  get conditionsArray(): FormArray {
    return this.form.get('conditions') as FormArray;
  }
  get actionsArray(): FormArray {
    return this.form.get('actions') as FormArray;
  }

  get uniqueDevices(): { id: number; name: string }[] {
    return this.data.devices.map((d) => ({ id: d.id, name: d.deviceName }));
  }

  getActionsForDevice(deviceId: number | null | undefined): DeviceActionView[] {
    if (!deviceId) return [];
    return this.data.actions.filter((a) => a.deviceId === deviceId);
  }

  private deviceIdForAction(actionId: number | null | undefined): number | null {
    if (!actionId) return null;
    return this.data.actions.find((a) => a.id === Number(actionId))?.deviceId ?? null;
  }

  ngOnInit(): void {
    const rule = this.data.rule;
    const cooldown = decomposeCooldown(rule?.cooldown_seconds ?? 60);
    this.form = this.fb.group({
      name: [rule?.name ?? '', Validators.required],
      condition_operator: [rule?.condition_operator ?? 'AND'],
      cooldown_value: [cooldown.value, [Validators.required, Validators.min(0)]],
      cooldown_unit: [cooldown.unit],
      is_emergency: [rule?.is_emergency ?? false],
      conditions: this.fb.array([]),
      actions: this.fb.array([]),
    });

    if (rule) {
      for (const c of rule.conditions) {
        this.addCondition(c.condition_type as ConditionType, {
          days: c.schedule_days ?? [],
          time: c.schedule_time ?? undefined,
          until: c.schedule_until ?? undefined,
          everyMinutes: c.schedule_every_minutes ?? null,
          user_device_id: c.user_device_id ?? undefined,
          value: c.threshold_value ?? c.status_value ?? undefined,
          status: c.status_value ?? undefined,
          user_device_action_id: c.user_device_action_id ?? undefined,
          operator: c.operator ?? undefined,
        });
      }
      for (const a of rule.actions) {
        this.addAction(a);
      }
      this.expandedConditionIndex = null;
      this.expandedActionIndex = null;
    }
  }

  // ── Action info helpers ──────────────────────────────────────────

  getAction(id: number | null | undefined): DeviceActionView | undefined {
    return id != null ? this.data.actions.find((a) => a.id === Number(id)) : undefined;
  }

  actionLabel(a: DeviceActionView): string {
    return a.deviceName ? `${a.deviceName} · ${a.name}` : a.name;
  }

  getActionControlType(id: number | null | undefined): ActionControlType {
    return actionControlType(this.getAction(id));
  }

  getConditionOperators(condIndex: number): { value: string; label: string }[] {
    const all = [
      { value: '=', label: '=' },
      { value: '!=', label: '≠' },
      { value: '>', label: '>' },
      { value: '<', label: '<' },
      { value: '>=', label: '≥' },
      { value: '<=', label: '≤' },
    ];
    const actionId = this.conditionsArray.at(condIndex).get('user_device_action_id')?.value;
    const type = this.getActionControlType(actionId);
    return type === 'onoff' ? all.slice(0, 2) : all;
  }

  // ── Form array mutations ─────────────────────────────────────────

  addCondition(type: ConditionType, prefill?: ConditionPrefill): void {
    let group: FormGroup;
    if (type === 'schedule') {
      const days = prefill?.days ?? [];
      group = this.fb.group({
        condition_type: [type],
        time: [prefill?.time ?? '08:00', Validators.required],
        // Blank `until` keeps the single-time shape every schedule had before; filling both turns
        // it into a loop — "06:00 to 17:30 every 10 minutes" — evaluated by the same matcher.
        until: [prefill?.until ?? ''],
        everyMinutes: [prefill?.everyMinutes ?? null],
        days: this.fb.array(DAY_LABELS.map((_, i) => this.fb.control(days.includes(i)))),
      });
    } else if (type === 'device_state' || type === 'device_status') {
      group = this.fb.group({
        condition_type: ['device_state'],
        device_id: [prefill?.user_device_id ?? null, Validators.required],
        value: [prefill?.value ?? prefill?.status ?? 'online', Validators.required],
      });
    } else {
      // threshold
      group = this.fb.group({
        condition_type: [type],
        device_id: [this.deviceIdForAction(prefill?.user_device_action_id)],
        user_device_action_id: [prefill?.user_device_action_id ?? null, Validators.required],
        operator: [prefill?.operator ?? '=', Validators.required],
        value: [prefill?.value ?? '', Validators.required],
      });
    }
    this.conditionsArray.push(group);
    this.expandedConditionIndex = this.conditionsArray.length - 1;
  }

  removeCondition(i: number): void {
    this.conditionsArray.removeAt(i);
    this.expandedConditionIndex = null;
  }

  onConditionDeviceChange(i: number): void {
    this.conditionsArray.at(i).get('user_device_action_id')?.setValue(null);
    this.conditionsArray.at(i).get('value')?.setValue('');
    this.conditionsArray.at(i).get('operator')?.setValue('=');
  }

  onConditionActionChange(i: number): void {
    this.conditionsArray.at(i).get('value')?.setValue('');
    this.conditionsArray.at(i).get('operator')?.setValue('=');
  }

  getDaysArray(conditionIndex: number): FormArray {
    return this.conditionsArray.at(conditionIndex).get('days') as FormArray;
  }

  /** Toggles one day of a schedule condition (replaces the old checkbox row). */
  toggleDay(ci: number, d: number): void {
    const c = this.getDaysArray(ci).at(d);
    c.setValue(!c.value);
  }

  addAction(prefill?: ActionPrefill): void {
    this.actionsArray.push(
      this.fb.group({
        user_device_action_id: [prefill?.user_device_action_id ?? null, Validators.required],
        target_state: [prefill?.target_state ?? '', Validators.required],
        delay_seconds: [prefill?.delay_seconds ?? 0, [Validators.required, Validators.min(0)]],
      }),
    );
    this.expandedActionIndex = this.actionsArray.length - 1;
  }

  removeAction(i: number): void {
    this.actionsArray.removeAt(i);
    this.expandedActionIndex = null;
  }

  onTargetActionChange(i: number): void {
    this.actionsArray.at(i).get('target_state')?.setValue('');
  }

  // ── Board / rail / focused panel ─────────────────────────────────

  /** Which section's editing surface is open; null = the board itself. */
  openSection: RuleSectionKey | null = null;

  /** Accordion keys — one condition and one action expanded at a time inside their panel. */
  expandedConditionIndex: number | null = null;
  expandedActionIndex: number | null = null;

  // ── When an error is allowed to go red ───────────────────────────
  //
  // An existing rule holds real data, so a problem in it is worth showing the moment the editor
  // opens. A NEW rule is empty by definition — painting every unfilled field red before the user
  // has typed anything is noise. A section earns its red only when the user leaves it having
  // CHANGED something in it. Save stays disabled either way: `ruleErrors` is untouched, and the
  // rail's summary line always names the first blocker.
  private engaged = new Set<RuleSectionKey>();

  /** Value fingerprint of the controls a section owns, taken on entry and compared on exit. */
  private sectionSnapshot(key: RuleSectionKey): string {
    switch (key) {
      case 'conditions':
        return JSON.stringify([
          this.form.get('condition_operator')?.value,
          this.conditionsArray.getRawValue(),
        ]);
      case 'actions':
        return JSON.stringify(this.actionsArray.getRawValue());
      case 'timing':
        return JSON.stringify([
          this.form.get('cooldown_value')?.value,
          this.form.get('cooldown_unit')?.value,
        ]);
      case 'priority':
        return JSON.stringify([this.form.get('is_emergency')?.value]);
    }
  }

  private snapshotOnEntry: string | null = null;

  /** Leaving a section only earns its red if something in it actually changed. */
  private leaveSection(key: RuleSectionKey): void {
    if (this.snapshotOnEntry !== null && this.sectionSnapshot(key) !== this.snapshotOnEntry) {
      this.engaged.add(key);
    }
    this.snapshotOnEntry = null;
  }

  revealed(key: RuleSectionKey): boolean {
    return !!this.data.rule || this.engaged.has(key);
  }

  /** Section errors that are allowed to render. Never used for gating Save. */
  visibleErrors(key: RuleSectionKey): string[] {
    return this.revealed(key) ? this.sectionErrors(key) : [];
  }

  get anyRevealed(): boolean {
    return !!this.data.rule || this.engaged.size > 0;
  }

  openPanel(key: RuleSectionKey): void {
    // Jumping straight from one section to another counts as leaving the first.
    if (this.openSection && this.openSection !== key) this.leaveSection(this.openSection);
    this.openSection = key;
    this.snapshotOnEntry = this.sectionSnapshot(key);
    // Land on whatever is actually wrong, so the panel opens where the work is.
    if (key === 'conditions') {
      const bad = this.conditionsArray.controls.findIndex((c) => c.invalid);
      this.expandedConditionIndex = bad >= 0 ? bad : this.conditionsArray.length ? 0 : null;
    }
    if (key === 'actions') {
      const bad = this.actionsArray.controls.findIndex((a) => a.invalid);
      this.expandedActionIndex = bad >= 0 ? bad : this.actionsArray.length ? 0 : null;
    }
  }

  closePanel(): void {
    if (this.openSection) this.leaveSection(this.openSection);
    this.openSection = null;
  }

  get openSectionLabel(): string {
    return this.sectionMeta.find((s) => s.key === this.openSection)?.label ?? '';
  }

  toggleCondition(i: number): void {
    this.expandedConditionIndex = this.expandedConditionIndex === i ? null : i;
  }
  conditionHasError(i: number): boolean {
    return this.conditionsArray.at(i).invalid;
  }

  toggleAction(i: number): void {
    this.expandedActionIndex = this.expandedActionIndex === i ? null : i;
  }
  actionHasError(i: number): boolean {
    return this.actionsArray.at(i).invalid || this.isSensorTarget(i);
  }

  /** A sensor reading cannot be commanded — the old form said so in a note and still let it save. */
  isSensorTarget(i: number): boolean {
    const id = this.actionsArray.at(i).get('user_device_action_id')?.value;
    return !!id && this.getActionControlType(id) === 'sensor';
  }

  // ── Board summaries ──────────────────────────────────────────────

  private plural(n: number, word: string): string {
    return `${n} ${word}${n === 1 ? '' : 's'}`;
  }

  /** Badge class + label for a condition row: schedule / threshold / state. */
  conditionKind(i: number): { key: string; label: string } {
    const type = this.conditionsArray.at(i).get('condition_type')?.value as string;
    if (type === 'schedule') return { key: 'schedule', label: 'Schedule' };
    if (type === 'threshold') return { key: 'threshold', label: 'Threshold' };
    return { key: 'state', label: 'State' };
  }

  /** One condition, in words — the board row and the collapsed panel row share this. */
  conditionDescription(i: number): string {
    const c = this.conditionsArray.at(i);
    const type = c.get('condition_type')?.value as string;

    if (type === 'schedule') {
      const time = c.get('time')?.value || '--:--';
      const until = c.get('until')?.value;
      const every = c.get('everyMinutes')?.value;
      const when = until && every ? `${time}–${until} every ${every} min` : `At ${time}`;
      const days = (this.getDaysArray(i).value as boolean[])
        .map((on, d) => (on ? this.dayNames[d].slice(0, 3) : null))
        .filter(Boolean);
      return days.length === 0 || days.length === 7 ? when : `${when} · ${days.join(', ')}`;
    }

    if (type === 'device_state') {
      const device = this.uniqueDevices.find((d) => d.id === c.get('device_id')?.value);
      return device ? `${device.name} is ${c.get('value')?.value}` : 'no device selected';
    }

    const action = this.getAction(c.get('user_device_action_id')?.value);
    if (!action) return 'no action selected';
    const value = c.get('value')?.value;
    return `${this.actionLabel(action)} ${c.get('operator')?.value} ${value === '' ? '…' : value}`;
  }

  actionDescription(i: number): string {
    const a = this.actionsArray.at(i);
    const action = this.getAction(a.get('user_device_action_id')?.value);
    if (!action) return 'no target selected';
    const state = a.get('target_state')?.value;
    const delay = a.get('delay_seconds')?.value;
    return `${this.actionLabel(action)} → ${state || 'not set'}${delay ? ` · after ${delay}s` : ''}`;
  }

  get conditionsSummary(): string {
    const n = this.conditionsArray.length;
    if (n === 0) return 'none yet';
    if (n === 1) return '1 condition';
    return `${n} · ${this.form.get('condition_operator')?.value === 'AND' ? 'ALL' : 'ANY'} match`;
  }

  get actionsSummary(): string {
    const n = this.actionsArray.length;
    return n === 0 ? 'none yet' : this.plural(n, 'action');
  }

  get cooldownSeconds(): number {
    const value = Number(this.form.get('cooldown_value')?.value ?? 0);
    const unit = this.form.get('cooldown_unit')?.value as string;
    return value * (UNIT_MULT[unit] ?? 1);
  }

  /** "5 min" / "2 h" / "none" — the board's Timing card states the cooldown twice (headline and
   *  row), so both have to speak the same units or the card reads as two different numbers. */
  get cooldownLabel(): string {
    const s = this.cooldownSeconds;
    if (!s) return 'none';
    if (s % 3600 === 0) return `${s / 3600} h`;
    if (s % 60 === 0) return `${s / 60} min`;
    return `${s} s`;
  }

  get timingSummary(): string {
    return this.cooldownSeconds ? `Cooldown ${this.cooldownLabel}` : 'No cooldown';
  }

  /** The slowest action decides when the rule has finished acting — worth stating next to cooldown. */
  get longestDelay(): number {
    return this.actionsArray.controls.reduce(
      (max, a) => Math.max(max, Number(a.get('delay_seconds')?.value ?? 0)),
      0,
    );
  }

  get isEmergency(): boolean {
    return !!this.form.get('is_emergency')?.value;
  }

  get prioritySummary(): string {
    return this.isEmergency ? 'Emergency' : 'Normal';
  }

  // ── Validation ───────────────────────────────────────────────────

  sectionErrors(key: RuleSectionKey): string[] {
    const errors: string[] = [];

    switch (key) {
      case 'conditions': {
        if (this.conditionsArray.length === 0) {
          errors.push('At least one condition is required.');
          break;
        }
        const controls = this.conditionsArray.controls;
        if (
          controls.some(
            (c) => c.get('condition_type')?.value === 'schedule' && !c.get('time')?.value,
          )
        ) {
          errors.push('Every schedule needs a time.');
        }
        if (
          controls.some(
            (c) => c.get('condition_type')?.value === 'device_state' && !c.get('device_id')?.value,
          )
        ) {
          errors.push('Every device-state condition needs a device.');
        }
        const thresholds = controls.filter(
          (c) => c.get('condition_type')?.value === 'threshold',
        );
        if (thresholds.some((c) => !c.get('user_device_action_id')?.value)) {
          errors.push('Every threshold condition needs an action to watch.');
        }
        if (thresholds.some((c) => c.get('value')?.value === '' || c.get('value')?.value == null)) {
          errors.push('Every threshold condition needs a value to compare against.');
        }
        break;
      }

      case 'actions': {
        if (this.actionsArray.length === 0) {
          errors.push('At least one action is required.');
          break;
        }
        const controls = this.actionsArray.controls;
        if (controls.some((a) => !a.get('user_device_action_id')?.value)) {
          errors.push('Every action needs a target.');
        }
        if (
          controls.some(
            (a) =>
              a.get('user_device_action_id')?.value &&
              (a.get('target_state')?.value === '' || a.get('target_state')?.value == null),
          )
        ) {
          errors.push('Every action needs a state to set.');
        }
        if (this.actionsArray.controls.some((_a, i) => this.isSensorTarget(i))) {
          errors.push('Sensor readings are read-only — pick a controllable action instead.');
        }
        break;
      }

      case 'timing': {
        const v = this.form.get('cooldown_value');
        if (v?.value == null || v.value === '' || Number(v.value) < 0) {
          errors.push('Cooldown must be zero or more.');
        }
        break;
      }

      case 'priority':
        break;
    }

    return errors;
  }

  get ruleErrors(): string[] {
    const errors = this.sectionMeta.flatMap((s) => this.sectionErrors(s.key));
    return this.nameMissing ? [NAME_REQUIRED, ...errors] : errors;
  }

  /** The name is a header field, so it belongs to no section — it reports on itself. */
  get nameMissing(): boolean {
    return !this.form?.get('name')?.value?.trim();
  }
  nameBlurred = false;
  get nameInvalid(): boolean {
    return this.nameMissing && (this.nameBlurred || this.anyRevealed);
  }

  /** First blocking problem — the rail strip and the mobile issue bar both jump to it.
   *  A null `key` means it is the header's name field rather than a section. */
  get firstError(): { key: RuleSectionKey | null; section: string; message: string } | null {
    if (this.nameMissing) return { key: null, section: 'Rule', message: NAME_REQUIRED };
    for (const s of this.sectionMeta) {
      const [message] = this.sectionErrors(s.key);
      if (message) return { key: s.key, section: s.label, message };
    }
    return null;
  }

  /** Jump to whatever is blocking Save: a section panel, or the name field itself. */
  goToFirstError(): void {
    const e = this.firstError;
    if (!e) return;
    if (e.key) {
      this.openPanel(e.key);
      return;
    }
    this.nameBlurred = true;
    this.nameInput?.nativeElement.focus();
  }

  // ── Save ─────────────────────────────────────────────────────────

  save(): void {
    if (this.ruleErrors.length > 0) return;

    const value = this.form.getRawValue();
    const dto: CreateRuleDto = {
      name: value.name,
      condition_operator: value.condition_operator,
      cooldown_seconds: this.cooldownSeconds,
      is_emergency: value.is_emergency,
      conditions: value.conditions.map((c: ConditionFormValue) => {
        if (c.condition_type === 'schedule') {
          const days = (c.days as boolean[])
            .map((checked, i) => (checked ? i : -1))
            .filter((i) => i >= 0);
          // Half a window is not a window: the API rejects one without the other, so a
          // part-filled form is sent as the plain single-time shape rather than as an error.
          const looping = !!c.until && !!c.everyMinutes;
          return {
            condition_type: 'schedule',
            schedule_time: c.time,
            schedule_days: days,
            schedule_until: looping ? c.until : null,
            schedule_every_minutes: looping ? Number(c.everyMinutes) : null,
          };
        }
        if (c.condition_type === 'device_state') {
          return {
            condition_type: 'device_state',
            user_device_id: c.device_id,
            status_value: String(c.value),
          };
        }
        // threshold
        return {
          condition_type: 'threshold',
          user_device_action_id: c.user_device_action_id,
          operator: c.operator,
          threshold_value: String(c.value),
        };
      }),
      actions: value.actions.map((a: ActionFormValue) => ({
        user_device_action_id: a.user_device_action_id,
        target_state: String(a.target_state),
        delay_seconds: a.delay_seconds,
      })),
    };

    this.dialogRef.close(dto);
  }
}
