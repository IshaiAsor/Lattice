import { Component, ElementRef, inject, OnInit, ViewChild } from '@angular/core';
import { AbstractControl, FormBuilder, FormArray, FormGroup, ValidationErrors, Validators } from '@angular/forms';
import { MAT_DIALOG_DATA, MatDialogRef } from '@angular/material/dialog';
import { MatSnackBar } from '@angular/material/snack-bar';
import { forkJoin } from 'rxjs';
import { SHARED_MATERIAL } from 'src/app/shared-ui';
import {
  PipelinesService,
  CreatePipelineDto,
  PipelineStageDto,
  MlModelView,
  PipelineDetail,
} from 'src/app/services/pipelines.service';
import { UserActionsService } from 'src/app/services/user.actions.service';
import { DeviceActionView } from 'src/app/services/device.mgmt.service';

// implementation_type value that produces image frames (same set as digest-service/resolve.ts)
const IMAGE_IMPL_TYPES = new Set(['CameraAction']);

// Read-only sensor types — cannot receive commands; forced inject_as_sensor=true / inject_as_action=false,
// same as image types (mirrors services/api/src/services/pipelines.service.ts)
const SENSOR_IMPL_TYPES = new Set([
  'TemperatureAction', 'AirTemperatureAction', 'HumidityAction',
  'WaterLevelAction', 'PhLevelAction', 'TdsLevelAction', 'CO2LevelAction',
]);

const UNIT_MULT: Record<string, number> = { sec: 1, min: 60, hours: 3600, days: 86400 };

function decomposeInterval(sec: number | null): { value: number; unit: string } {
  if (!sec) return { value: 60, unit: 'sec' };
  if (sec % 86400 === 0) return { value: sec / 86400, unit: 'days' };
  if (sec % 3600  === 0) return { value: sec / 3600,  unit: 'hours' };
  if (sec % 60    === 0) return { value: sec / 60,    unit: 'min' };
  return { value: sec, unit: 'sec' };
}

// Days of the week, in JS getDay() order. Empty selection = every day.
export const DAY_LABELS = ['S', 'M', 'T', 'W', 'T', 'F', 'S'];
export const DAY_NAMES  = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

// The editor is a summary board plus one focused editing surface (a right drawer on desktop, a
// bottom sheet under 600px) — not a linear stepper. These are the board's cards, the rail's rows
// and the panel's identities, all at once; `action` drops out when nothing is commandable.
export type SectionKey = 'inputs' | 'enrich' | 'reasoning' | 'action' | 'triggers';

export const NAME_REQUIRED = 'The pipeline needs a name.';

export const SECTION_META: { key: SectionKey; label: string }[] = [
  { key: 'inputs',    label: 'Inputs'    },
  { key: 'enrich',    label: 'Enrich'    },
  { key: 'reasoning', label: 'Reasoning' },
  { key: 'action',    label: 'Action'    },
  { key: 'triggers',  label: 'Triggers'  },
];


@Component({
  selector: 'app-pipeline-editor-dialog',
  standalone: true,
  imports: [SHARED_MATERIAL],
  templateUrl: './pipeline-editor-dialog.component.html',
  styleUrl: './pipeline-editor-dialog.component.css',
})
export class PipelineEditorDialogComponent implements OnInit {
  private fb       = inject(FormBuilder);
  private svc      = inject(PipelinesService);
  private actionsSvc = inject(UserActionsService);
  private snack    = inject(MatSnackBar);
  ref  = inject(MatDialogRef<PipelineEditorDialogComponent>);
  data: { pipelineId: number | null } = inject(MAT_DIALOG_DATA);

  @ViewChild('nameInput') nameInput?: ElementRef<HTMLInputElement>;

  allActions:   DeviceActionView[] = [];
  mlModels:     MlModelView[] = [];
  saving  = false;
  loading = false;

  get scalarActions(): DeviceActionView[] {
    return this.allActions.filter((a) => !IMAGE_IMPL_TYPES.has(a.implementation_type));
  }
  get imageActions(): DeviceActionView[] {
    return this.allActions.filter((a) => IMAGE_IMPL_TYPES.has(a.implementation_type));
  }
  get llmModels(): MlModelView[] { return this.mlModels.filter((m) => m.kind === 'llm'); }
  get vlmModels(): MlModelView[] { return this.mlModels.filter((m) => m.kind === 'vlm'); }

  // ── Searchable action picker (mat-autocomplete bound directly to the numeric
  // user_device_action_id control) ─────────────────────────────────────────
  // While the user types, the control's raw value is momentarily the typed string
  // (not yet a valid id) — filter off of that, and require a real numeric id at
  // save time via validActionId rather than trying to commit/reset on blur.

  actionDisplayName = (id: number | null): string => {
    if (id == null || typeof id !== 'number') return '';
    const a = this.allActions.find((x) => x.id === id);
    return a ? `${a.deviceName} — ${a.name}` : '';
  };

  private validActionId = (control: AbstractControl): ValidationErrors | null => {
    const v = control.value;
    if (v == null || v === '') return null; // let Validators.required handle emptiness
    return typeof v === 'number' ? null : { invalidAction: true };
  };

  // Same sensor/action can't be picked twice anywhere in the pipeline (any group, any item) —
  // counts live occurrences across all groups rather than tracking pairwise state.
  private uniqueActionId = (control: AbstractControl): ValidationErrors | null => {
    const v = control.value;
    if (typeof v !== 'number') return null; // non-numeric/empty handled by other validators
    const count = this.groups.controls.reduce((n, g) => {
      const items = (g.get('items') as FormArray).controls;
      return n + items.filter((it) => it.get('user_device_action_id')?.value === v).length;
    }, 0);
    return count > 1 ? { duplicateAction: true } : null;
  };

  // A duplicate becomes valid/invalid based on *sibling* controls, which Angular doesn't
  // revalidate automatically — call after any add/remove/change that could affect the count.
  private revalidateActionUniqueness(): void {
    this.groups.controls.forEach((g) => {
      (g.get('items') as FormArray).controls.forEach((it) => {
        it.get('user_device_action_id')!.updateValueAndValidity({ emitEvent: false });
      });
    });
  }

  private filterQuery(g: AbstractControl): string {
    const v = g.get('user_device_action_id')?.value;
    return typeof v === 'string' ? v.toLowerCase() : '';
  }

  filteredScalarActions(g: AbstractControl): DeviceActionView[] {
    const q = this.filterQuery(g);
    if (!q) return this.scalarActions;
    return this.scalarActions.filter((a) => `${a.deviceName} ${a.name}`.toLowerCase().includes(q));
  }

  filteredImageActions(g: AbstractControl): DeviceActionView[] {
    const q = this.filterQuery(g);
    if (!q) return this.imageActions;
    return this.imageActions.filter((a) => `${a.deviceName} ${a.name}`.toLowerCase().includes(q));
  }

  compressionOptions = [
    { value: 'average',     label: 'Average',           hint: 'Mean of all readings' },
    { value: 'last_n',      label: 'Last N readings',   hint: 'Most-recent N values in order' },
    { value: 'min_max',     label: 'Min / Max',         hint: 'Extremes only' },
    { value: 'min_max_avg', label: 'Min / Max / Avg',   hint: 'Range + mean vector' },
    { value: 'time_series', label: 'Time series (all)', hint: 'Full window, ordered' },
  ];
  windowUnits  = ['minutes', 'hours', 'days'];
  triggerTypes = ['sensor_threshold', 'schedule', 'manual'];
  operators    = ['>', '<', '>=', '<=', '='];

  notifyChoices = [
    { value: 'none',   label: 'None' },
    { value: 'socket', label: 'Socket (real-time)' },
    { value: 'push',   label: 'Push notification' },
  ];
  execCondChoices = [
    { value: 'always',      label: 'Always' },
    { value: 'on_positive', label: 'Only on positive LLM decision' },
  ];
  triggerTypeLabels: Record<string, string> = {
    sensor_threshold: 'Sensor threshold',
    schedule:         'Schedule',
    manual:           'Manual only',
  };
  cooldownUnits = [
    { value: 'sec',   label: 'Seconds' },
    { value: 'min',   label: 'Minutes' },
    { value: 'hours', label: 'Hours' },
    { value: 'days',  label: 'Days' },
  ];

  form = this.fb.group({
    name:              ['', Validators.required],
    groups:            this.fb.array([]),
    llm_model_id:      [null as number | null, Validators.required],
    vlm_model_id:      [null as number | null],
    prompt_template:   ['', Validators.required],
    notify:            ['none'],
    execute_condition: ['always'],
    triggers:          this.fb.array([]),
  });

  get groups():   FormArray { return this.form.get('groups')   as FormArray; }
  get triggers(): FormArray { return this.form.get('triggers') as FormArray; }

  ngOnInit(): void {
    this.svc.getModels().subscribe((m) => { this.mlModels = m; });

    if (this.data.pipelineId) {
      this.loading = true;
      // actionDisplayName (used by the sensor/action autocompletes) resolves ids against
      // allActions at the moment the form value is written to the view, not reactively —
      // so allActions must be loaded before the pipeline's groups/triggers are built,
      // otherwise the autocomplete inputs render blank despite a valid underlying value.
      forkJoin({
        actions:  this.actionsSvc.getUserActions(),
        pipeline: this.svc.getPipeline(this.data.pipelineId),
      }).subscribe({
        next: ({ actions, pipeline: p }) => {
          this.allActions = actions;
          this.form.patchValue({ name: p.name });
          this.buildGroupsFromSensors(p.sensors);
          this.revalidateActionUniqueness();

          const llmStage = p.stages.find((s) => s.kind === 'infer' && s.ml_model?.kind === 'llm');
          const vlmStage = p.stages.find((s) => s.kind === 'infer' && s.ml_model?.kind === 'vlm');
          const execStage = p.stages.find((s) => s.kind === 'command_exec');

          // The API reads these back FLAT (prompt_template / notify / execute_condition are
          // columns), even though writes go up nested under `config`. Reading only `config`
          // meant every existing pipeline opened with its prompt blanked and its notify reset
          // to "none" — and, since notify has no validator, saving quietly wrote that back.
          // `config` is still checked first so any older/nested payload keeps working.
          if (llmStage) {
            const cfg = llmStage.config as Record<string, unknown> | null;
            this.form.patchValue({
              llm_model_id:    llmStage.ml_model_id ?? null,
              prompt_template: (cfg?.['prompt_template'] as string) ?? llmStage.prompt_template ?? '',
            });
          }
          if (vlmStage) {
            this.form.patchValue({ vlm_model_id: vlmStage.ml_model_id ?? null });
          }
          if (execStage) {
            const cfg = execStage.config as Record<string, unknown> | null;
            this.form.patchValue({
              notify:            (cfg?.['notify'] as string) ?? execStage.notify ?? 'none',
              execute_condition: (cfg?.['execute_condition'] as string) ?? execStage.execute_condition ?? 'always',
            });
          }

          p.triggers.forEach((t) => this.triggers.push(this.makeTrigger({
            trigger_type:           t.trigger_type as never,
            user_device_action_id:  t.user_device_action_id,
            operator:               t.operator,
            threshold_value:        t.threshold_value,
            schedule_time:          t.schedule_time,
            schedule_until:         t.schedule_until,
            schedule_every_minutes: t.schedule_every_minutes,
            schedule_days:          t.schedule_days,
            min_interval_sec:       t.min_interval_sec ?? null,
          })));

          this.loading = false;
        },
        error: () => { this.loading = false; },
      });
    } else {
      this.actionsSvc.getUserActions().subscribe((a) => { this.allActions = a; });
      this.addGroup();
      this.addTrigger();
    }
  }

  // ── Group helpers ─────────────────────────────────────────────────────────
  // A group is a named bundle of sensor/action items (e.g. "Climate control"); the group name
  // is entered once per group, not repeated per item.

  makeGroup(name = ''): FormGroup {
    return this.fb.group({
      name:  [name, Validators.required],
      items: this.fb.array([]),
    });
  }

  itemsOf(gi: number): FormArray { return this.groups.at(gi).get('items') as FormArray; }

  addGroup(): void {
    const g = this.makeGroup();
    this.groups.push(g);
    (g.get('items') as FormArray).push(this.makeItem());
    // The accordion keys are index-based, so anything structural resets them.
    this.activeGroupIndex = this.groups.length - 1;
    this.expandedItemKey = `${this.activeGroupIndex}:0`;
  }
  removeGroup(gi: number): void {
    this.groups.removeAt(gi);
    this.revalidateActionUniqueness();
    this.activeGroupIndex = Math.max(0, Math.min(this.activeGroupIndex, this.groups.length - 1));
    this.expandedItemKey = null;
  }

  addItem(gi: number): void {
    this.itemsOf(gi).push(this.makeItem());
    this.expandedItemKey = `${gi}:${this.itemsOf(gi).length - 1}`;
  }
  removeItem(gi: number, ii: number): void {
    this.itemsOf(gi).removeAt(ii);
    this.revalidateActionUniqueness();
    this.expandedItemKey = null;
  }

  private buildGroupsFromSensors(sensors: PipelineDetail['sensors']): void {
    const order: string[] = [];
    const byName = new Map<string, PipelineDetail['sensors']>();
    for (const s of sensors) {
      if (!byName.has(s.group_name)) { byName.set(s.group_name, []); order.push(s.group_name); }
      byName.get(s.group_name)!.push(s);
    }
    for (const name of order) {
      const g = this.makeGroup(name);
      const items = g.get('items') as FormArray;
      for (const s of byName.get(name)!) {
        items.push(this.makeItem({
          description:           s.description,
          user_device_action_id: s.user_device_action_id,
          inject_as_sensor:      s.inject_as_sensor,
          inject_as_action:      s.inject_as_action,
          compression:           s.compression as never,
          window_value:          s.window_minutes,
          window_unit:           'minutes',
          n:                     s.n ?? undefined,
          min_value:             s.min_value ?? undefined,
          max_value:             s.max_value ?? undefined,
        }));
      }
      this.groups.push(g);
    }
  }

  // ── Sensor/action item helpers ───────────────────────────────────────────

  makeItem(v?: {
    description?: string; user_device_action_id?: number | null;
    inject_as_sensor?: boolean; inject_as_action?: boolean;
    compression?: string; window_value?: number; window_unit?: string; n?: number;
    min_value?: string; max_value?: string;
  }): FormGroup {
    const g = this.fb.group({
      description:           [v?.description ?? '', Validators.required],
      user_device_action_id: [v?.user_device_action_id ?? null,
                               [Validators.required, this.validActionId, this.uniqueActionId]],
      inject_as_sensor:      [v?.inject_as_sensor ?? true],
      inject_as_action:      [v?.inject_as_action ?? false],
      compression:           [v?.compression ?? 'average'],
      window_value:          [v?.window_value ?? 60, [Validators.required, Validators.min(1)]],
      window_unit:           [v?.window_unit ?? 'minutes'],
      n:                     [v?.n ?? null],
      min_value:             [v?.min_value ?? null],
      max_value:             [v?.max_value ?? null],
    });
    g.get('user_device_action_id')!.valueChanges.subscribe((id) => {
      this.applyToggleForcing(g, id);
      this.revalidateActionUniqueness();
    });
    this.applyToggleForcing(g, v?.user_device_action_id ?? null);
    return g;
  }

  // Telemetry and image/camera items are read-only from the LLM's perspective: they always feed
  // the sensor digest and can never be commanded, so their toggles are forced and locked.
  private isForcedItem(actionId: number | null): boolean {
    const a = this.allActions.find((x) => x.id === actionId);
    if (!a) return false;
    return SENSOR_IMPL_TYPES.has(a.implementation_type) || IMAGE_IMPL_TYPES.has(a.implementation_type);
  }

  private applyToggleForcing(g: FormGroup, actionId: number | null): void {
    const sensorCtrl = g.get('inject_as_sensor')!;
    const actionCtrl = g.get('inject_as_action')!;
    if (this.isForcedItem(actionId)) {
      sensorCtrl.setValue(true, { emitEvent: false });
      actionCtrl.setValue(false, { emitEvent: false });
      sensorCtrl.disable({ emitEvent: false });
      actionCtrl.disable({ emitEvent: false });
    } else {
      sensorCtrl.enable({ emitEvent: false });
      actionCtrl.enable({ emitEvent: false });
    }
  }

  compression(gi: number, ii: number): string {
    return this.itemsOf(gi).at(ii).get('compression')?.value ?? '';
  }

  itemActionName(gi: number, ii: number): string {
    return this.actionDisplayName(this.itemsOf(gi).at(ii).get('user_device_action_id')?.value ?? null);
  }

  itemBadge(gi: number, ii: number): string {
    const g = this.itemsOf(gi).at(ii);
    const sensor = g.get('inject_as_sensor')?.value;
    const action = g.get('inject_as_action')?.value;
    if (sensor && action) return 'sensor + action';
    return action ? 'action' : 'sensor';
  }

  private isImageItem(g: AbstractControl): boolean {
    const imageIds = new Set(this.imageActions.map((a) => a.id));
    return imageIds.has(g.get('user_device_action_id')?.value);
  }

  // Compression (average/last_n/min_max/...) aggregates the historic sensor_history digest —
  // meaningless for camera items, which the VLM stage reads as a live/cached frame instead
  // (see run.context.image; nothing in the historic digest is ever fed to a VLM). Camera items
  // stay "sensor-flagged" (so their current_state shows up) but skip the Enrich step's config.
  get sensorFlaggedPairs(): { gi: number; ii: number }[] {
    const pairs: { gi: number; ii: number }[] = [];
    this.groups.controls.forEach((_, gi) => {
      this.itemsOf(gi).controls.forEach((c, ii) => {
        if (c.get('inject_as_sensor')?.value && !this.isImageItem(c)) pairs.push({ gi, ii });
      });
    });
    return pairs;
  }

  get imageItemPairs(): { gi: number; ii: number }[] {
    const pairs: { gi: number; ii: number }[] = [];
    this.groups.controls.forEach((_, gi) => {
      this.itemsOf(gi).controls.forEach((c, ii) => {
        if (this.isImageItem(c)) pairs.push({ gi, ii });
      });
    });
    return pairs;
  }

  get hasImageSensor(): boolean {
    const imageIds = new Set(this.imageActions.map((a) => a.id));
    return this.groups.controls.some((_, gi) =>
      this.itemsOf(gi).controls.some((c) => imageIds.has(c.get('user_device_action_id')?.value)),
    );
  }

  get hasActionItems(): boolean {
    return this.groups.controls.some((_, gi) =>
      this.itemsOf(gi).controls.some((c) => c.get('inject_as_action')?.value),
    );
  }

  get totalItemCount(): number {
    return this.groups.controls.reduce((sum, _, gi) => sum + this.itemsOf(gi).length, 0);
  }

  // ── Trigger helpers ──────────────────────────────────────────────────────

  // The schedule shape every surface now uses: a time, and optionally a window to repeat it in.
  // This dialog used to write `schedule_cron` — a 6-field cron nothing in the platform ever read,
  // so a pipeline whose only trigger was a schedule never ran at all.
  makeTrigger(v?: {
    trigger_type?: string; user_device_action_id?: number | null; operator?: string | null;
    threshold_value?: string | null; min_interval_sec?: number | null;
    schedule_time?: string | null; schedule_until?: string | null;
    schedule_every_minutes?: number | null; schedule_days?: number[] | null;
  }): FormGroup {
    const interval = decomposeInterval(v?.min_interval_sec ?? null);
    const days = new Set(v?.schedule_days ?? []);
    const g = this.fb.group({
      trigger_type:           [v?.trigger_type ?? 'manual', Validators.required],
      user_device_action_id:  [v?.user_device_action_id ?? null],
      operator:               [v?.operator ?? '>'],
      threshold_value:        [v?.threshold_value ?? null],
      schedule_time:          [v?.schedule_time ?? '08:00'],
      // Blank pair = fire once at `schedule_time`. Filled, they repeat it through the day.
      schedule_until:         [v?.schedule_until ?? ''],
      schedule_every_minutes: [v?.schedule_every_minutes ?? null],
      schedule_days:          this.fb.array(DAY_LABELS.map((_, d) => this.fb.control(days.has(d)))),
      min_interval_value:     [interval.value],
      min_interval_unit:      [interval.unit],
    });
    g.get('trigger_type')!.valueChanges.subscribe((type) => this.updateTriggerValidators(g, type ?? 'manual'));
    this.updateTriggerValidators(g, v?.trigger_type ?? 'manual');
    return g;
  }

  private updateTriggerValidators(g: FormGroup, type: string): void {
    const actionCtrl    = g.get('user_device_action_id')!;
    const thresholdCtrl = g.get('threshold_value')!;
    const timeCtrl      = g.get('schedule_time')!;
    if (type === 'sensor_threshold') {
      actionCtrl.setValidators([Validators.required, this.validActionId]);
      thresholdCtrl.setValidators(Validators.required);
      timeCtrl.clearValidators();
    } else if (type === 'schedule') {
      timeCtrl.setValidators(Validators.required);
      actionCtrl.setValidators(this.validActionId);
      thresholdCtrl.clearValidators();
    } else {
      actionCtrl.setValidators(this.validActionId);
      thresholdCtrl.clearValidators();
      timeCtrl.clearValidators();
    }
    actionCtrl.updateValueAndValidity({ emitEvent: false });
    thresholdCtrl.updateValueAndValidity({ emitEvent: false });
    timeCtrl.updateValueAndValidity({ emitEvent: false });
  }

  /** The day checkboxes of one trigger, for the template's formArrayName. */
  scheduleDays(i: number): FormArray {
    return this.triggers.at(i).get('schedule_days') as FormArray;
  }

  readonly dayLabels = DAY_LABELS;
  readonly dayNames  = DAY_NAMES;

  addTrigger(): void {
    this.triggers.push(this.makeTrigger());
    this.expandedTriggerIndex = this.triggers.length - 1;
  }
  removeTrigger(i: number): void {
    this.triggers.removeAt(i);
    this.expandedTriggerIndex = null;
  }

  triggerType(i: number): string { return this.triggers.at(i).get('trigger_type')?.value ?? ''; }

  // ── Board / rail / focused panel ─────────────────────────────────────────

  readonly sectionMeta = SECTION_META;

  /** Which section's editing surface is open; null = the board itself. */
  openSection: SectionKey | null = null;

  /** Mobile only: groups become tabs inside the Inputs panel (see the .group-hidden rule). */
  activeGroupIndex = 0;

  /** Accordion keys — one item and one trigger expanded at a time inside their panel. */
  expandedItemKey: string | null = null;
  expandedTriggerIndex: number | null = null;

  /** `action` only exists once something in the pipeline can actually be commanded. */
  get sections(): { key: SectionKey; label: string }[] {
    return this.sectionMeta.filter((s) => s.key !== 'action' || this.hasActionItems);
  }

  // ── When an error is allowed to go red ───────────────────────────────────
  //
  // An existing pipeline holds real data, so a problem in it is worth showing the moment the
  // editor opens. A NEW pipeline is empty by definition — painting every unfilled field red
  // before the user has typed anything is noise, and it made the whole board red on open.
  //
  // A section earns its red only when the user leaves it having CHANGED something in it.
  // Entering can't earn it (nothing has been filled in yet, and going red behind the open
  // panel is noise while they work), and neither can looking and leaving — opening a section
  // to see what it holds is not a mistake to report. Inside the panel, Material's own
  // touched/dirty errors still do the per-field work. Save stays disabled either way:
  // `pipelineErrors` is untouched, and the rail's summary line always names the first blocker.
  private engaged = new Set<SectionKey>();

  /** Value fingerprint of the controls a section owns, taken on entry and compared on exit. */
  private sectionSnapshot(key: SectionKey): string {
    switch (key) {
      case 'inputs':
        return JSON.stringify([this.form.get('name')?.value, this.groups.getRawValue()]);
      case 'enrich':
        return JSON.stringify(this.sensorFlaggedPairs.map((p) => {
          const it = this.itemsOf(p.gi).at(p.ii);
          return [it.get('compression')?.value, it.get('window_value')?.value,
                  it.get('window_unit')?.value, it.get('n')?.value];
        }));
      case 'reasoning':
        return JSON.stringify([this.form.get('llm_model_id')?.value, this.form.get('prompt_template')?.value]);
      case 'action':
        return JSON.stringify([this.form.get('notify')?.value, this.form.get('execute_condition')?.value]);
      case 'triggers':
        return JSON.stringify(this.triggers.getRawValue());
    }
  }

  private snapshotOnEntry: string | null = null;

  /** Leaving a section only earns its red if something in it actually changed. */
  private leaveSection(key: SectionKey): void {
    if (this.snapshotOnEntry !== null && this.sectionSnapshot(key) !== this.snapshotOnEntry) {
      this.engaged.add(key);
    }
    this.snapshotOnEntry = null;
  }

  revealed(key: SectionKey): boolean {
    return !!this.data.pipelineId || this.engaged.has(key);
  }

  /** Section errors that are allowed to render. Never used for gating Save. */
  visibleErrors(key: SectionKey): string[] {
    return this.revealed(key) ? this.sectionErrors(key) : [];
  }

  get anyRevealed(): boolean {
    return !!this.data.pipelineId || this.engaged.size > 0;
  }

  openPanel(key: SectionKey): void {
    // Jumping straight from one section to another counts as leaving the first.
    if (this.openSection && this.openSection !== key) this.leaveSection(this.openSection);
    this.openSection = key;
    this.snapshotOnEntry = this.sectionSnapshot(key);
    if (key === 'inputs') {
      // Land on whatever is actually wrong, so the panel opens where the work is.
      const bad = this.groups.controls.flatMap((_, gi) =>
        this.itemsOf(gi).controls.map((_c, ii) => ({ gi, ii })),
      ).find((p) => this.itemHasError(p.gi, p.ii));
      const first = bad ?? (this.totalItemCount > 0 ? { gi: 0, ii: 0 } : null);
      if (first) { this.activeGroupIndex = first.gi; this.expandedItemKey = `${first.gi}:${first.ii}`; }
    }
    if (key === 'triggers') {
      const bad = this.triggers.controls.findIndex((t) => t.invalid);
      this.expandedTriggerIndex = bad >= 0 ? bad : (this.triggers.length ? 0 : null);
    }
  }
  closePanel(): void {
    if (this.openSection) this.leaveSection(this.openSection);
    this.openSection = null;
  }

  get openSectionLabel(): string {
    return this.sectionMeta.find((s) => s.key === this.openSection)?.label ?? '';
  }

  isItemExpanded(gi: number, ii: number): boolean { return this.expandedItemKey === `${gi}:${ii}`; }
  toggleItem(gi: number, ii: number): void {
    const key = `${gi}:${ii}`;
    this.expandedItemKey = this.expandedItemKey === key ? null : key;
  }
  itemHasError(gi: number, ii: number): boolean { return this.itemsOf(gi).at(ii).invalid; }

  toggleTrigger(i: number): void {
    this.expandedTriggerIndex = this.expandedTriggerIndex === i ? null : i;
  }
  triggerHasError(i: number): boolean { return this.triggers.at(i).invalid; }

  /** Toggles one day of a schedule trigger (replaces the old checkbox row). */
  toggleDay(ti: number, d: number): void {
    const c = this.scheduleDays(ti).at(d);
    c.setValue(!c.value);
  }

  // ── Board summaries ──────────────────────────────────────────────────────

  private plural(n: number, word: string): string { return `${n} ${word}${n === 1 ? '' : 's'}`; }

  get inputsSummary(): string {
    return `${this.plural(this.groups.length, 'group')} · ${this.plural(this.totalItemCount, 'item')}`;
  }

  get enrichSummary(): string {
    const n = this.sensorFlaggedPairs.length;
    return n === 0 ? 'nothing to compress' : this.plural(n, 'reading');
  }

  /** Distinct compression settings across the sensor-flagged items, with how many share each. */
  get enrichLines(): { text: string; count: number }[] {
    const byKey = new Map<string, number>();
    for (const p of this.sensorFlaggedPairs) {
      const it = this.itemsOf(p.gi).at(p.ii);
      const c = it.get('compression')?.value as string;
      const label = this.compressionOptions.find((o) => o.value === c)?.label ?? c;
      const detail = c === 'last_n'
        ? `${it.get('n')?.value ?? '?'}`
        : `${it.get('window_value')?.value} ${it.get('window_unit')?.value}`;
      const key = `${label} · ${detail}`;
      byKey.set(key, (byKey.get(key) ?? 0) + 1);
    }
    return [...byKey].map(([text, count]) => ({ text, count }));
  }

  get llmModelName(): string {
    const id = this.form.get('llm_model_id')?.value;
    const m = this.llmModels.find((x) => x.id === id);
    return m ? `${m.name} ${m.version ?? ''}`.trim() : 'no model selected';
  }

  get actionSummary(): string {
    const notify = this.notifyChoices.find((n) => n.value === this.form.get('notify')?.value)?.label ?? 'None';
    const cond = this.form.get('execute_condition')?.value === 'on_positive' ? 'on positive' : 'always';
    return `${notify} · ${cond}`;
  }

  get triggersSummary(): string { return this.plural(this.triggers.length, 'trigger'); }

  /** The items the LLM is allowed to command — the Action panel's read-only manifest.
   *  Carries the action id: distinct actions can share a display name (three sockets of one
   *  device type all read "MULTI_SOCKET_8_CH — Socket 1"), so the name is not a usable key. */
  get availableActionItems(): { id: number; name: string; group: string }[] {
    const out: { id: number; name: string; group: string }[] = [];
    this.groups.controls.forEach((g, gi) => {
      this.itemsOf(gi).controls.forEach((it, ii) => {
        if (it.get('inject_as_action')?.value) {
          out.push({
            id:    it.get('user_device_action_id')?.value as number,
            name:  this.itemActionName(gi, ii),
            group: g.get('name')?.value ?? '',
          });
        }
      });
    });
    return out;
  }

  /** One-line human reading of a trigger, for the board card and the collapsed row. */
  triggerDescription(i: number): string {
    const t = this.triggers.at(i);
    const type = t.get('trigger_type')?.value as string;
    if (type === 'sensor_threshold') {
      const name = this.actionDisplayName(t.get('user_device_action_id')?.value ?? null) || 'sensor';
      return `${name} ${t.get('operator')?.value ?? ''} ${t.get('threshold_value')?.value ?? ''}`.trim();
    }
    if (type === 'schedule') {
      const from  = t.get('schedule_time')?.value;
      const until = t.get('schedule_until')?.value;
      const every = t.get('schedule_every_minutes')?.value;
      return until && every ? `${from} → ${until}, every ${every} min` : `at ${from}`;
    }
    return 'Manual only';
  }

  itemGroupName(gi: number): string { return this.groups.at(gi).get('name')?.value || `Group ${gi + 1}`; }

  // ── Cross-field structural rules ─────────────────────────────────────────

  // Field-level mat-error only renders once a control is "touched", which never happens for
  // fields the user hasn't directly clicked into (e.g. a required field left at its default) —
  // so an invalid form can disable Save with no visible explanation anywhere. Every rule that
  // can make form.invalid true without an always-visible inline error must also show up here.
  // Errors are attributed to the section that owns them so the rail, the board card and the
  // header chip can all point at the same place. Without this the board would hide a problem
  // behind a closed card — the exact failure the stepper had, in a new shape.
  sectionErrors(key: SectionKey): string[] {
    const errors: string[] = [];

    switch (key) {
      case 'inputs': {
        // The pipeline name is NOT an Inputs field — it lives in the header, and reporting it
        // on this card pointed at a panel that doesn't contain it. See `nameMissing`.
        if (this.groups.controls.some((g) => !g.get('name')?.value?.trim())) {
          errors.push('Every group needs a name.');
        }
        if (this.totalItemCount === 0) {
          errors.push('At least one sensor or action item is required.');
          break;
        }
        const allItems = this.groups.controls.flatMap((g) => (g.get('items') as FormArray).controls);
        if (allItems.some((it) => !it.get('user_device_action_id')?.value)) {
          errors.push('Every item needs a sensor or action selected.');
        }
        if (allItems.some((it) => it.get('user_device_action_id')?.hasError('invalidAction'))) {
          errors.push('Pick each sensor/action from the list — typed text that isn’t selected doesn’t count.');
        }
        if (allItems.some((it) => it.get('user_device_action_id')?.hasError('duplicateAction'))) {
          errors.push('The same sensor/action is used more than once.');
        }
        if (allItems.some((it) => !it.get('description')?.value?.trim())) {
          errors.push('Every item needs Context.');
        }
        if (this.imageItemPairs.length > 1) {
          errors.push('Only one camera item is supported per pipeline.');
        }
        break;
      }

      case 'enrich': {
        if (this.sensorFlaggedPairs.some((p) => !this.itemsOf(p.gi).at(p.ii).get('window_value')?.value)) {
          errors.push('Every reading needs a compression window.');
        }
        break;
      }

      case 'reasoning': {
        if (!this.form.get('llm_model_id')?.value) {
          errors.push('Select a language model.');
        }
        if (!this.form.get('prompt_template')?.value?.trim()) {
          errors.push('Add context for the LLM.');
        }
        break;
      }

      case 'action':
        break;

      case 'triggers': {
        // These rules live in updateTriggerValidators, so they can disable Save. Before the
        // board redesign they had no message anywhere — form.invalid with nothing to read.
        this.triggers.controls.forEach((t, i) => {
          const type = t.get('trigger_type')?.value as string;
          const n = i + 1;
          if (type === 'sensor_threshold') {
            if (!t.get('user_device_action_id')?.value) {
              errors.push(`Trigger ${n}: pick a sensor action.`);
            } else if (t.get('user_device_action_id')?.hasError('invalidAction')) {
              errors.push(`Trigger ${n}: pick the sensor from the list.`);
            }
            if (!`${t.get('threshold_value')?.value ?? ''}`.trim()) {
              errors.push(`Trigger ${n}: a threshold value is required.`);
            }
          }
          if (type === 'schedule' && !t.get('schedule_time')?.value) {
            errors.push(`Trigger ${n}: a start time is required.`);
          }
        });
        break;
      }
    }

    return errors;
  }

  // Field-level mat-error only renders once a control is "touched", which never happens for
  // fields the user hasn't directly clicked into (e.g. a required field left at its default) —
  // so an invalid form can disable Save with no visible explanation anywhere. Every rule that
  // can make form.invalid true without an always-visible inline error must also show up here.
  // Walks SECTION_META rather than `sections` so a hidden section still reports.
  get pipelineErrors(): string[] {
    const errors = this.sectionMeta.flatMap((s) => this.sectionErrors(s.key));
    return this.nameMissing ? [NAME_REQUIRED, ...errors] : errors;
  }

  /** The name is a header field, so it belongs to no section — it reports on itself. */
  get nameMissing(): boolean {
    return !this.form.get('name')?.value?.trim();
  }
  nameBlurred = false;
  get nameInvalid(): boolean {
    return this.nameMissing && (this.nameBlurred || this.anyRevealed);
  }

  /** First blocking problem — the rail strip and the mobile issue bar both jump to it.
   *  A null `key` means it is the header's name field rather than a section. */
  get firstError(): { key: SectionKey | null; section: string; message: string } | null {
    if (this.nameMissing) return { key: null, section: 'Pipeline', message: NAME_REQUIRED };
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
    if (e.key) { this.openPanel(e.key); return; }
    this.nameBlurred = true;
    this.nameInput?.nativeElement.focus();
  }

  // ── Save ─────────────────────────────────────────────────────────────────

  save(): void {
    if (this.form.invalid || this.pipelineErrors.length > 0) return;
    this.saving = true;
    const v = this.form.getRawValue() as {
      name: string;
      groups: {
        name: string;
        items: {
          description: string; user_device_action_id: number;
          inject_as_sensor: boolean; inject_as_action: boolean;
          compression: never; window_value: number; window_unit: never; n: number | null;
          min_value: string | null; max_value: string | null;
        }[];
      }[];
      llm_model_id: number | null;
      vlm_model_id: number | null;
      prompt_template: string;
      notify: string;
      execute_condition: string;
      triggers: {
        trigger_type: never; user_device_action_id: number | null; operator: string | null;
        threshold_value: string | null;
        schedule_time: string | null; schedule_until: string | null;
        schedule_every_minutes: number | null; schedule_days: boolean[];
        min_interval_value: number; min_interval_unit: string;
      }[];
    };

    const flatSensors = v.groups.flatMap((g) => g.items.map((it) => ({
      group_name:            g.name,
      description:           it.description,
      user_device_action_id: it.user_device_action_id,
      inject_as_sensor:      it.inject_as_sensor,
      inject_as_action:      it.inject_as_action,
      compression:           it.compression,
      window_value:          it.window_value,
      window_unit:           it.window_unit,
      n:                     it.n,
      min_value:             it.min_value,
      max_value:             it.max_value,
    })));

    const stages: PipelineStageDto[] = [];
    stages.push({ kind: 'enrich', ordinal: stages.length });
    // VLM/YOLO stage parked: a camera item's frame now flows from enrich straight to the
    // multimodal LLM (see ml-executor). No separate vision stage is constructed. Re-enable by
    // un-hiding the Vision-model control in the template and restoring this push.
    stages.push({
      kind: 'infer', ordinal: stages.length, ml_model_id: v.llm_model_id!,
      config: v.prompt_template ? { prompt_template: v.prompt_template } : undefined,
    });
    if (flatSensors.some((s) => s.inject_as_action)) {
      stages.push({
        kind: 'command_exec', ordinal: stages.length,
        config: { notify: v.notify, execute_condition: v.execute_condition },
      });
    }

    const dto: CreatePipelineDto = {
      name:     v.name,
      sensors:  flatSensors,
      stages,
      triggers: v.triggers.map((t) => {
        // Half a window is not a smaller window — the API rejects it — so an incomplete pair is
        // sent as no window at all, which is the single-time shape the fields already read as.
        const repeats = t.trigger_type === 'schedule' && !!t.schedule_until && !!t.schedule_every_minutes;
        return {
          trigger_type:           t.trigger_type,
          user_device_action_id:  t.user_device_action_id,
          operator:               t.operator,
          threshold_value:        t.threshold_value,
          schedule_time:          t.trigger_type === 'schedule' ? (t.schedule_time || null) : null,
          schedule_until:         repeats ? t.schedule_until : null,
          schedule_every_minutes: repeats ? Number(t.schedule_every_minutes) : null,
          schedule_days:          t.trigger_type === 'schedule'
                                    ? t.schedule_days.map((on, d) => (on ? d : -1)).filter((d) => d >= 0)
                                    : [],
          min_interval_sec:       t.min_interval_value
                                    ? Math.round(t.min_interval_value * (UNIT_MULT[t.min_interval_unit] ?? 1))
                                    : null,
        };
      }),
    };

    const req$ = this.data.pipelineId
      ? this.svc.updatePipeline(this.data.pipelineId, dto)
      : this.svc.createPipeline(dto);

    req$.subscribe({
      next:  () => { this.saving = false; this.ref.close(true); },
      error: (err) => {
        this.saving = false;
        this.snack.open(err?.error?.message ?? 'Save failed', 'Dismiss', { duration: 4000 });
      },
    });
  }
}
