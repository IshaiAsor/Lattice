import { Component, inject, OnInit } from '@angular/core';
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

// schedule_cron is stored as a 6-field cron (seconds first) so the "every N seconds" case is
// representable; these are the only shapes the "Every / Unit" picker below ever produces or reads.
const SCHEDULE_CRON_PATTERNS: { unit: string; re: RegExp }[] = [
  { unit: 'sec',   re: /^\*\/(\d+) \* \* \* \* \*$/ },
  { unit: 'min',   re: /^0 \*\/(\d+) \* \* \* \*$/ },
  { unit: 'hours', re: /^0 0 \*\/(\d+) \* \* \*$/ },
  { unit: 'days',  re: /^0 0 0 \*\/(\d+) \* \*$/ },
];

function decomposeCron(cron: string | null | undefined): { value: number; unit: string } {
  const trimmed = cron?.trim();
  if (trimmed) {
    for (const { unit, re } of SCHEDULE_CRON_PATTERNS) {
      const m = trimmed.match(re);
      if (m) return { value: Number(m[1]), unit };
    }
  }
  return { value: 5, unit: 'min' };
}

function buildCron(value: number, unit: string): string {
  const n = Math.max(1, Math.round(value || 1));
  switch (unit) {
    case 'sec':   return `*/${n} * * * * *`;
    case 'hours': return `0 0 */${n} * * *`;
    case 'days':  return `0 0 0 */${n} * *`;
    default:      return `0 */${n} * * * *`; // min
  }
}

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
  notifyOptions     = ['none', 'socket', 'push'];
  execCondOptions   = ['always', 'on_positive'];
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

          if (llmStage) {
            const cfg = llmStage.config as Record<string, unknown> | null;
            this.form.patchValue({
              llm_model_id:    llmStage.ml_model_id ?? null,
              prompt_template: (cfg?.['prompt_template'] as string) ?? '',
            });
          }
          if (vlmStage) {
            this.form.patchValue({ vlm_model_id: vlmStage.ml_model_id ?? null });
          }
          if (execStage) {
            const cfg = execStage.config as Record<string, unknown> | null;
            this.form.patchValue({
              notify:            (cfg?.['notify'] as string) ?? 'none',
              execute_condition: (cfg?.['execute_condition'] as string) ?? 'always',
            });
          }

          p.triggers.forEach((t) => this.triggers.push(this.makeTrigger({
            trigger_type:          t.trigger_type as never,
            user_device_action_id: t.user_device_action_id,
            operator:              t.operator,
            threshold_value:       t.threshold_value,
            schedule_cron:         t.schedule_cron,
            min_interval_sec:      t.min_interval_sec ?? null,
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
  }
  removeGroup(gi: number): void { this.groups.removeAt(gi); this.revalidateActionUniqueness(); }

  addItem(gi: number):             void { this.itemsOf(gi).push(this.makeItem()); }
  removeItem(gi: number, ii: number): void {
    this.itemsOf(gi).removeAt(ii);
    this.revalidateActionUniqueness();
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

  makeTrigger(v?: {
    trigger_type?: string; user_device_action_id?: number | null; operator?: string | null;
    threshold_value?: string | null; schedule_cron?: string | null; min_interval_sec?: number | null;
  }): FormGroup {
    const interval = decomposeInterval(v?.min_interval_sec ?? null);
    const schedule = decomposeCron(v?.schedule_cron);
    const g = this.fb.group({
      trigger_type:          [v?.trigger_type ?? 'manual', Validators.required],
      user_device_action_id: [v?.user_device_action_id ?? null],
      operator:              [v?.operator ?? '>'],
      threshold_value:       [v?.threshold_value ?? null],
      schedule_cron:         [v?.schedule_cron ?? buildCron(schedule.value, schedule.unit)],
      schedule_value:        [schedule.value, [Validators.required, Validators.min(1)]],
      schedule_unit:         [schedule.unit],
      min_interval_value:    [interval.value],
      min_interval_unit:     [interval.unit],
    });
    g.get('trigger_type')!.valueChanges.subscribe((type) => this.updateTriggerValidators(g, type ?? 'manual'));
    this.updateTriggerValidators(g, v?.trigger_type ?? 'manual');

    // The "Every / Unit" fields are the only user-facing schedule controls; schedule_cron is
    // derived from them and carried along purely so the existing DTO shape needs no change.
    const syncScheduleCron = () => g.get('schedule_cron')!.setValue(
      buildCron(g.get('schedule_value')!.value ?? 1, g.get('schedule_unit')!.value ?? 'min'),
      { emitEvent: false },
    );
    g.get('schedule_value')!.valueChanges.subscribe(syncScheduleCron);
    g.get('schedule_unit')!.valueChanges.subscribe(syncScheduleCron);

    return g;
  }

  private updateTriggerValidators(g: FormGroup, type: string): void {
    const actionCtrl    = g.get('user_device_action_id')!;
    const thresholdCtrl = g.get('threshold_value')!;
    const cronCtrl      = g.get('schedule_cron')!;
    const scheduleCtrl  = g.get('schedule_value')!;
    if (type === 'sensor_threshold') {
      actionCtrl.setValidators([Validators.required, this.validActionId]);
      thresholdCtrl.setValidators(Validators.required);
      cronCtrl.clearValidators();
      scheduleCtrl.clearValidators();
    } else if (type === 'schedule') {
      cronCtrl.setValidators(Validators.required);
      scheduleCtrl.setValidators([Validators.required, Validators.min(1)]);
      actionCtrl.setValidators(this.validActionId);
      thresholdCtrl.clearValidators();
    } else {
      actionCtrl.setValidators(this.validActionId);
      thresholdCtrl.clearValidators();
      cronCtrl.clearValidators();
      scheduleCtrl.clearValidators();
    }
    actionCtrl.updateValueAndValidity({ emitEvent: false });
    thresholdCtrl.updateValueAndValidity({ emitEvent: false });
    cronCtrl.updateValueAndValidity({ emitEvent: false });
    scheduleCtrl.updateValueAndValidity({ emitEvent: false });
  }

  addTrigger():              void { this.triggers.push(this.makeTrigger()); }
  removeTrigger(i: number):  void { this.triggers.removeAt(i); }

  triggerType(i: number): string { return this.triggers.at(i).get('trigger_type')?.value ?? ''; }

  // ── Cross-field structural rules ─────────────────────────────────────────

  // Field-level mat-error only renders once a control is "touched", which never happens for
  // fields the user hasn't directly clicked into (e.g. a required field left at its default) —
  // so an invalid form can disable Save with no visible explanation anywhere. Every rule that
  // can make form.invalid true without an always-visible inline error must also show up here.
  get pipelineErrors(): string[] {
    const errors: string[] = [];

    if (!this.form.get('name')?.value?.trim()) {
      errors.push('Enter a pipeline name in step 1.');
    }
    if (this.groups.controls.some((g) => !g.get('name')?.value?.trim())) {
      errors.push('Every group needs a name — fill in the missing ones in step 1.');
    }

    if (this.totalItemCount === 0) {
      errors.push('At least one sensor or action item is required.');
    } else {
      const allItems = this.groups.controls.flatMap((g) => (g.get('items') as FormArray).controls);
      if (allItems.some((it) => !it.get('user_device_action_id')?.value)) {
        errors.push('Every sensor/action item needs a Sensor/action selected — fill in the missing ones in step 1.');
      }
      if (allItems.some((it) => it.get('user_device_action_id')?.hasError('invalidAction'))) {
        errors.push('Pick a sensor/action from the dropdown list — a typed value that isn’t selected doesn’t count (step 1).');
      }
      if (allItems.some((it) => it.get('user_device_action_id')?.hasError('duplicateAction'))) {
        errors.push('The same sensor/action is selected more than once — fix the duplicate in step 1.');
      }
      if (allItems.some((it) => !it.get('description')?.value?.trim())) {
        errors.push('Every sensor/action item needs Context — fill in the missing ones in step 1.');
      }
    }
    if (this.sensorFlaggedPairs.some((p) => !this.itemsOf(p.gi).at(p.ii).get('window_value')?.value)) {
      errors.push('Every sensor-flagged item needs a compression Window in step 2 (Enrich).');
    }
    if (!this.form.get('llm_model_id')?.value) {
      errors.push('Select a language model in the LLM step.');
    }
    if (!this.form.get('prompt_template')?.value?.trim()) {
      errors.push('Add context for the LLM in the LLM step.');
    }
    if (this.hasImageSensor && !this.form.get('vlm_model_id')?.value) {
      errors.push('This pipeline includes a camera/vision item — select a vision model in the LLM step.');
    }
    if (this.imageItemPairs.length > 1) {
      errors.push('Only one camera item is supported per pipeline.');
    }

    return errors;
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
        threshold_value: string | null; schedule_cron: string | null;
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
    if (v.vlm_model_id) {
      stages.push({ kind: 'infer', ordinal: stages.length, ml_model_id: v.vlm_model_id });
    }
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
      triggers: v.triggers.map((t) => ({
        trigger_type:          t.trigger_type,
        user_device_action_id: t.user_device_action_id,
        operator:              t.operator,
        threshold_value:       t.threshold_value,
        schedule_cron:         t.schedule_cron,
        min_interval_sec:      t.min_interval_value
                                 ? Math.round(t.min_interval_value * (UNIT_MULT[t.min_interval_unit] ?? 1))
                                 : null,
      })),
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
