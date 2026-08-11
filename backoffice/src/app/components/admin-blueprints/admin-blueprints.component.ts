import { Component, inject, OnInit, signal } from '@angular/core';
import { ActivatedRoute, Router } from '@angular/router';
import { MatSnackBar } from '@angular/material/snack-bar';
import { NgTemplateOutlet } from '@angular/common';
import { MatTabsModule } from '@angular/material/tabs';
import { MatCheckboxModule } from '@angular/material/checkbox';
import { forkJoin } from 'rxjs';
import { SHARED_MATERIAL } from 'src/app/shared-ui';
import {
  AdminBlueprintsService,
  BlueprintSummary,
  MlModelOption,
  SealedTemplateDetail,
} from 'src/app/services/admin.blueprints.service';
import {
  BlueprintDraft,
  COMPRESSIONS,
  CONDITION_TYPES,
  COOLDOWN_UNITS,
  DURATION_UNITS,
  OPERATORS,
  ParamDraft,
  PhaseDraft,
  ProfileDraft,
  FieldDraft,
  FanOutDraft,
  PipelineDraft,
  PipelineSensorDraft,
  PipelineStageDraft,
  PipelineTriggerDraft,
  RawBlueprint,
  RuleDraft,
  SceneDraft,
  SlotDraft,
  STAGE_KINDS,
  TRIGGER_TYPES,
  emptyDraft,
  newCondition,
  newParam,
  newPhase,
  newProfile,
  newField,
  newFieldOption,
  allDraftPhases,
  phasesOf,
  FAN_OUT_MODES,
  FIELD_TYPES,
  FIELD_SCOPES,
  newPipeline,
  newRule,
  newRuleAction,
  newScene,
  newSceneMember,
  newSensor,
  newSlot,
  newStage,
  newTrigger,
  toDocument,
  toDraft,
  uniqueSlug,
} from './blueprint-draft.model';

/**
 * A template that is both phase-scoped and fanned out — rules, scenes and pipelines all are. Which
 * phases it may be scoped to depends on how it fans out, so the two travel together.
 */
type ScopableDraft = FanOutDraft & { phase_scope: string[] };

/** The string-typed keys of a draft row — what a reference may be written into. */
type StringField<T> = { [K in keyof T]: T[K] extends string ? K : never }[keyof T];

/**
 * The builder's authoring sections, in the order they appear — the ones a problem can hide in.
 *
 * Ordered by what depends on what, so nothing is ever picked from a list that is still empty:
 *
 *   questions → slots   what the setup asks the user reads first; a per-device question then
 *                       names the slot whose devices it is asked about.
 *   rules / pipelines → phases   a phase says what *ends* it by naming a rule or a pipeline, so
 *                       authoring phases first means choosing a decider that does not exist yet.
 *   scenes last         nothing points at a scene. It is on-demand, so it depends on everything
 *                       and nothing depends on it.
 */
const SECTIONS = [
  'details',
  'fields',
  'slots',
  'params',
  'rules',
  'pipelines',
  'phases',
  'scenes',
] as const;
/** `backup` collapses the same way but is not authoring, so `openAllSections` leaves it alone. */
export type SectionId = (typeof SECTIONS)[number] | 'backup';

// Admin blueprint builder (F10.9) — a form over the blueprint definition.
//
// The one thing this UI has to get right is **addressing**: a template row names a device action as
// `(slot_key, action_name)`, and `action_name` must be an `mqtt_action_name` that the slot's sealed
// template actually provides. Typing that by hand is how a blueprint publishes clean and then
// resolves to nothing at derive time — so every slot and action field here is a dropdown fed from
// the chosen sealed template's entries, and picking a slot narrows the actions to that slot's.
//
// Values that may hold a `@param.` / `@phase.` reference get a picker beside them that inserts a
// declared parameter, for the same reason: a typo'd reference is indistinguishable from a deleted
// one at evaluation time.
//
// Publish stays the authority — the server re-validates everything against the persisted rows.
@Component({
  selector: 'app-admin-blueprints',
  imports: [
    SHARED_MATERIAL,
    MatTabsModule,
    MatCheckboxModule,
    NgTemplateOutlet,
  ],
  templateUrl: './admin-blueprints.component.html',
  styleUrl: './admin-blueprints.component.css',
})
export class AdminBlueprintsComponent implements OnInit {
  private service = inject(AdminBlueprintsService);
  private snackBar = inject(MatSnackBar);
  private route = inject(ActivatedRoute);
  private router = inject(Router);

  blueprints = signal<BlueprintSummary[]>([]);
  templates = signal<SealedTemplateDetail[]>([]);
  mlModels = signal<MlModelOption[]>([]);
  selected = signal<BlueprintSummary | null>(null);

  draft: BlueprintDraft = emptyDraft();
  problems = signal<string[]>([]);
  validated = signal(false);
  busy = signal(false);

  readonly durationUnits = DURATION_UNITS;
  readonly cooldownUnits = COOLDOWN_UNITS;
  readonly conditionTypes = CONDITION_TYPES;
  readonly operators = OPERATORS;
  readonly stageKinds = STAGE_KINDS;
  readonly triggerTypes = TRIGGER_TYPES;
  readonly compressions = COMPRESSIONS;
  // command_exec stage options — the values ml-router's registry falls back to are the defaults.
  readonly executeConditions = ['always', 'confident_only', 'never'];
  readonly notifyModes = ['none', 'on_action', 'always'];

  ngOnInit(): void {
    forkJoin({
      templates: this.service.sealedTemplatesWithEntries(),
      models: this.service.mlModels(),
    }).subscribe(({ templates, models }) => {
      this.templates.set(templates);
      this.mlModels.set(models);
    });
    // Load the list first, then let the URL's id decide what's open — the id lookup needs the
    // summaries. Subscribing (not a one-off snapshot) also handles back/forward and our own
    // navigate() calls from select/save/publish.
    this.service.list().subscribe((rows) => {
      this.blueprints.set(rows);
      this.route.paramMap.subscribe((pm) => this.applyRouteId(pm.get('id')));
    });
  }

  load(): void {
    this.service.list().subscribe((rows) => this.blueprints.set(rows));
  }

  /**
   * Open whatever the URL points at. The guard against the already-open id is what keeps our own
   * `select`/`save` navigations from re-fetching and wiping the draft — they set `selected` first,
   * so by the time the param event arrives the id already matches.
   */
  private applyRouteId(idStr: string | null): void {
    const id = idStr ? Number(idStr) : null;
    if (id === (this.selected()?.id ?? null)) return;
    if (id === null) {
      this.resetToNew();
      return;
    }
    const summary = this.blueprints().find((b) => b.id === id);
    if (!summary) {
      // A stale or deleted id — drop back to the new-blueprint state without leaving it in the URL.
      this.router.navigate(['/admin/blueprints'], { replaceUrl: true });
      return;
    }
    this.loadDraft(summary);
  }

  // ── Pickers ────────────────────────────────────────────────────────────
  //
  // These are what make the form worth having over free text.

  /** Only released templates can be published against, so only those are offered. */
  releasedTemplates(): SealedTemplateDetail[] {
    return this.templates().filter((t) => t.status === 'released');
  }

  slotKeys(): string[] {
    return this.draft.slots.map((s) => s.key).filter(Boolean);
  }

  paramKeys(): string[] {
    return this.draft.params.map((p) => p.key).filter(Boolean);
  }

  /** The actions a slot can address — the entries of the sealed template it targets. */
  actionsForSlot(slotKey: string): { name: string; label: string }[] {
    const slot = this.draft.slots.find((s) => s.key === slotKey);
    if (!slot) return [];
    const template = this.templates().find((t) => t.name === slot.sealed_template);
    return (template?.entries ?? []).map((e) => ({
      name: e.mqtt_action_name ?? e.capability_key,
      label: e.action_label,
    }));
  }

  /** Clearing the action when the slot changes stops a stale name silently surviving the edit. */
  onSlotChange(row: { slot_key: string; action_name: string }): void {
    row.action_name = '';
  }

  /** The actions a slot contributes — shown on the slot itself so its content isn't a mystery. */
  slotActions(slot: SlotDraft): { name: string; label: string }[] {
    const template = this.templates().find((t) => t.name === slot.sealed_template);
    return (template?.entries ?? []).map((e) => ({
      name: e.mqtt_action_name ?? e.capability_key,
      label: e.action_label,
    }));
  }

  // ── Keeping references in step with the slots they point at ────────────
  //
  // Every rule/scene/pipeline row addresses a slot by `slot_key`. Editing a slot after writing
  // those rows would silently orphan them — publish catches it, but only after the admin has lost
  // the work. So the two edits that can invalidate a reference fix it up instead.

  // The last key each slot was *committed* under. Tracked in a map rather than captured on focus:
  // a focus event is not guaranteed (programmatic edits, autofill, a re-render stealing focus), and
  // missing it would silently orphan every reference instead of renaming it.
  private committedSlotKey = new WeakMap<SlotDraft, string>();

  private rememberSlotKeys(): void {
    for (const slot of this.draft.slots) this.committedSlotKey.set(slot, slot.key);
  }

  /** Renaming a slot rewrites every reference to it. */
  commitSlotKey(slot: SlotDraft): void {
    const from = this.committedSlotKey.get(slot) ?? '';
    const to = slot.key.trim();
    slot.key = to;
    this.committedSlotKey.set(slot, to);
    if (!from || from === to) return;

    let updated = 0;
    for (const row of this.allSlotReferences()) {
      if (row.slot_key === from) {
        row.slot_key = to;
        updated++;
      }
    }
    if (updated > 0) {
      this.snackBar.open(`Renamed — ${updated} reference(s) updated`, 'Close', { duration: 3000 });
    }
  }

  /**
   * Changing a slot's sealed template changes which actions exist on it, so any reference to an
   * action the new template does not provide is cleared rather than left to fail at publish.
   */
  onSlotTemplateChange(slot: SlotDraft): void {
    const valid = new Set(this.slotActions(slot).map((a) => a.name));
    let cleared = 0;
    for (const row of this.allSlotReferences()) {
      if (row.slot_key === slot.key && row.action_name && !valid.has(row.action_name)) {
        row.action_name = '';
        cleared++;
      }
    }
    if (cleared > 0) {
      this.snackBar.open(
        `${cleared} action(s) cleared — the new template doesn't provide them`,
        'Close',
        { duration: 4000 },
      );
    }
  }

  /**
   * Once a setup has been derived, its `blueprint_slot_bindings.slot_key` rows point at these keys
   * — and reconcile resolves a template's `(slot_key, action_name)` against *those* bindings. So a
   * key that changes under a live instance makes every derived entity unresolvable on the next
   * publish.
   */
  keysLocked(): boolean {
    return (this.selected()?.instance_count ?? 0) > 0;
  }

  // Only keys that were *loaded from the persisted blueprint* are what live instances depend on.
  // A row added during this edit has no references yet, so its key may still follow its name even
  // while the blueprint is in use — otherwise you could never add a param/rule/etc. to a live
  // blueprint (its key would stay empty and fail validation). Seeded at load, per row object.
  private persistedKeyed = new WeakSet<object>();

  private rememberPersistedKeyed(): void {
    for (const row of [
      ...this.draft.slots,
      ...this.draft.params,
      ...this.draft.fields,
      ...this.draft.profiles,
      ...allDraftPhases(this.draft),
      ...this.draft.rules,
      ...this.draft.scenes,
      ...this.draft.pipelines,
    ]) {
      this.persistedKeyed.add(row);
    }
  }

  /** A key is frozen only if the blueprint is in use *and* this row came from the saved definition. */
  frozen(row: object): boolean {
    return this.keysLocked() && this.persistedKeyed.has(row);
  }

  /** The slot key follows its label until the blueprint is in use. Never typed by hand. */
  onSlotLabelChange(slot: SlotDraft): void {
    if (this.frozen(slot)) return;
    const others = this.draft.slots.filter((s) => s !== slot).map((s) => s.key);
    slot.key = uniqueSlug(slot.label, others);
    this.commitSlotKey(slot);
  }

  /** Likewise the blueprint key, which is only the handle import matches on. */
  onNameChange(): void {
    if (this.selected()) return; // an existing blueprint's key is its identity — never re-slug it
    this.draft.key = uniqueSlug(this.draft.name, []);
  }

  // ── Param keys follow their label, and carry their references along ────────────────────────
  //
  // A param is addressed as @param.<key> / @phase.<key> in rule/scene/pipeline values and by
  // param_key on a phase target. So unlike a rule or scene — whose key nothing points at —
  // renaming a param has to rewrite everything referencing it, the same contract as a slot rename.
  private committedParamKey = new WeakMap<ParamDraft, string>();

  private rememberParamKeys(): void {
    for (const p of this.draft.params) this.committedParamKey.set(p, p.key);
  }

  /** The param key follows its label until the blueprint is in use. */
  onParamLabelChange(param: ParamDraft): void {
    if (this.frozen(param)) return;
    const others = this.draft.params.filter((p) => p !== param).map((p) => p.key);
    param.key = uniqueSlug(param.label, others);
    this.commitParamKey(param);
  }

  private commitParamKey(param: ParamDraft): void {
    const from = this.committedParamKey.get(param) ?? '';
    const to = param.key.trim();
    param.key = to;
    this.committedParamKey.set(param, to);
    if (!from || from === to) return;
    const updated = this.renameParamReferences(from, to);
    if (updated > 0) {
      this.snackBar.open(`Renamed — ${updated} reference(s) updated`, 'Close', { duration: 3000 });
    }
  }

  /**
   * Repoint every reference to param key `from` at `to`: the exact `param_key` on a phase target,
   * and any embedded `@param.`/`@phase.` token in a value or free-text field. The negative
   * lookahead is load-bearing — renaming `level` must not also rewrite `@phase.level.min`.
   */
  private renameParamReferences(from: string, to: string): number {
    const esc = from.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const re = new RegExp(`@(param|phase)\\.${esc}(?![\\w.])`, 'g');
    let n = 0;
    const rw = (s: string | null | undefined): string => {
      const before = s ?? '';
      const after = before.replace(re, (_m, kind: string) => `@${kind}.${to}`);
      if (after !== before) n++;
      return after;
    };
    for (const ph of allDraftPhases(this.draft)) {
      for (const t of ph.targets) {
        if (t.param_key === from) {
          t.param_key = to;
          n++;
        }
      }
      ph.context_notes = rw(ph.context_notes);
    }
    this.draft.context_notes = rw(this.draft.context_notes);
    for (const r of this.draft.rules) {
      for (const c of r.conditions) c.threshold_value = rw(c.threshold_value);
      for (const a of r.actions) a.target_state = rw(a.target_state);
    }
    for (const s of this.draft.scenes) {
      for (const m of s.members) m.target_state = rw(m.target_state);
    }
    for (const p of this.draft.pipelines) {
      for (const se of p.sensors) {
        se.min_value = rw(se.min_value);
        se.max_value = rw(se.max_value);
      }
      for (const st of p.stages) st.prompt_template = rw(st.prompt_template);
      for (const tr of p.triggers) tr.threshold_value = rw(tr.threshold_value);
    }
    return n;
  }

  // ── Keyed entities nothing references — key just follows the name, no rewrite needed ────────
  onPhaseNameChange(phase: PhaseDraft): void {
    if (this.frozen(phase)) return;
    // Unique *within its own lifecycle* (F11): two profiles legitimately declare the same phase
    // key, and forcing a suffix would make the second one read as a different step than it is.
    const others = this.activeProfile()
      .phases.filter((p) => p !== phase)
      .map((p) => p.key);
    phase.key = uniqueSlug(phase.name, others);
  }

  onProfileNameChange(profile: ProfileDraft): void {
    if (this.frozen(profile)) return;
    const others = this.draft.profiles.filter((pr) => pr !== profile).map((pr) => pr.key);
    profile.key = uniqueSlug(profile.label, others);
  }

  onFieldLabelChange(field: FieldDraft): void {
    if (this.frozen(field)) return;
    const others = this.draft.fields.filter((f) => f !== field).map((f) => f.key);
    field.key = uniqueSlug(field.label, others);
  }
  onRuleNameChange(rule: RuleDraft): void {
    if (this.frozen(rule)) return;
    const others = this.draft.rules.filter((r) => r !== rule).map((r) => r.key);
    rule.key = uniqueSlug(rule.name, others);
  }
  onSceneNameChange(scene: SceneDraft): void {
    if (this.frozen(scene)) return;
    const others = this.draft.scenes.filter((s) => s !== scene).map((s) => s.key);
    scene.key = uniqueSlug(scene.name, others);
  }
  onPipelineNameChange(pipeline: PipelineDraft): void {
    if (this.frozen(pipeline)) return;
    const others = this.draft.pipelines.filter((p) => p !== pipeline).map((p) => p.key);
    pipeline.key = uniqueSlug(pipeline.name, others);
  }

  /** Every row in the draft that addresses a slot. */
  private allSlotReferences(): { slot_key: string; action_name: string }[] {
    return [
      ...this.draft.scenes.flatMap((sc) => sc.members),
      ...this.draft.rules.flatMap((r) => [...r.conditions, ...r.actions]),
      ...this.draft.pipelines.flatMap((p) => [...p.sensors, ...p.triggers]),
    ];
  }

  /**
   * Replace a value field with `@phase.<key>`.
   *
   * `@phase.` rather than `@param.` is the right default: it resolves override → phase → default,
   * so a value that no phase tunes still falls through to the blueprint default. `@param.` exists
   * for the narrower "a phase must not be able to change this" case.
   *
   * The `StringField` constraint keeps the template honest — only a string-typed field of that
   * exact row can be passed, so a rename can't silently target nothing.
   */
  insertRef<T>(row: T, field: StringField<T>, paramKey: string): void {
    (row as Record<string, string>)[field as string] = `@phase.${paramKey}`;
  }

  /** Append a reference inside free text (prompt templates), rather than replacing it. */
  appendRef<T>(row: T, field: StringField<T>, ref: string): void {
    const target = row as Record<string, string>;
    const key = field as string;
    target[key] = `${target[key] ?? ''}${target[key] ? ' ' : ''}${ref}`;
  }

  phaseMetaRefs(): string[] {
    return ['@phase.name', '@phase.context_notes'];
  }

  /**
   * The blueprint's own questions, as references (F11.6). A field is a *stated fact* — what the
   * user said this device is for — so it reads very differently from a tunable param, and a prompt
   * that can name it ("This pot is growing @field.plant") is the whole reason fields exist.
   * Offered wherever a reference can go, so the author never has to type one and risk a typo that
   * resolves to nothing at run time.
   */
  fieldRefs(): { ref: string; label: string }[] {
    return this.draft.fields
      .filter((f) => f.key)
      .map((f) => ({ ref: `@field.${f.key}`, label: f.label || f.key }));
  }

  // ── Pipeline readings, grouped ─────────────────────────────────────────
  //
  // `group_name` is a label on each sensor row, and the enrich stage buckets readings by it — so a
  // group is genuinely one-to-many. Editing it per row made that invisible and easy to typo into
  // two near-identical groups, so the UI renders the buckets and each row inherits its group.

  sensorGroups(pipeline: PipelineDraft): { name: string; sensors: PipelineSensorDraft[] }[] {
    const groups: { name: string; sensors: PipelineSensorDraft[] }[] = [];
    for (const sensor of pipeline.sensors) {
      const existing = groups.find((g) => g.name === sensor.group_name);
      if (existing) existing.sensors.push(sensor);
      else groups.push({ name: sensor.group_name, sensors: [sensor] });
    }
    return groups;
  }

  /** Rename a bucket — every reading in it moves together, which is the point of the grouping. */
  renameSensorGroup(pipeline: PipelineDraft, from: string, to: string): void {
    for (const sensor of pipeline.sensors) {
      if (sensor.group_name === from) sensor.group_name = to;
    }
  }

  addSensorToGroup(pipeline: PipelineDraft, groupName: string): void {
    const sensor = newSensor();
    sensor.group_name = groupName;
    pipeline.sensors.push(sensor);
  }

  addSensorGroup(pipeline: PipelineDraft): void {
    const taken = new Set(pipeline.sensors.map((s) => s.group_name));
    let name = 'group';
    for (let i = 2; taken.has(name); i++) name = `group_${i}`;
    this.addSensorToGroup(pipeline, name);
  }

  removeSensor(pipeline: PipelineDraft, sensor: PipelineSensorDraft): void {
    const i = pipeline.sensors.indexOf(sensor);
    if (i >= 0) pipeline.sensors.splice(i, 1);
  }

  // ── Stage model kinds ──────────────────────────────────────────────────

  /**
   * A vision model scores frames; it has no text context to take. Only an `llm` stage gets a
   * prompt, so the field is hidden rather than sent and silently dropped.
   */
  stageTakesPrompt(stage: PipelineStageDraft): boolean {
    return stage.kind === 'infer' && stage.ml_model?.kind === 'llm';
  }

  // ── Schedule (cron) built from a plain-language picker ─────────────────
  //
  // Admins author blueprints; a raw 5-field cron is a needless way to get "every 6 hours" wrong.
  // The cron string stays the stored form — this only builds and reads it back.

  readonly scheduleModes = [
    { id: 'minutes', label: 'Every N minutes' },
    { id: 'hours', label: 'Every N hours' },
    { id: 'daily', label: 'Every day at' },
    { id: 'weekly', label: 'Every week on' },
    { id: 'cron', label: 'Custom cron' },
  ];
  readonly weekdays = [
    { value: 1, label: 'Monday' },
    { value: 2, label: 'Tuesday' },
    { value: 3, label: 'Wednesday' },
    { value: 4, label: 'Thursday' },
    { value: 5, label: 'Friday' },
    { value: 6, label: 'Saturday' },
    { value: 0, label: 'Sunday' },
  ];

  /**
   * Plain-language echo of a schedule trigger, so the fields can be checked at a glance.
   *
   * Replaces the cron picker: `schedule_cron` was accepted, stored and never evaluated, so a
   * pipeline whose only trigger was a schedule never ran. The window shape a rule condition uses
   * now serves both, which means one evaluator to keep correct and one thing for an author to
   * learn — and the summary can be read back without decoding an expression.
   */
  scheduleSummary(trigger: PipelineTriggerDraft): string {
    if (!trigger.schedule_time) return 'no schedule set';
    const days = trigger.schedule_days?.length
      ? trigger.schedule_days
          .map((d) => this.weekdays.find((w) => w.value === d)?.label ?? d)
          .join(', ')
      : 'every day';
    if (trigger.schedule_until && trigger.schedule_every_minutes) {
      return `${days}, ${trigger.schedule_time}–${trigger.schedule_until} every ${trigger.schedule_every_minutes} min`;
    }
    return `${days} at ${trigger.schedule_time}`;
  }

  // ── Collapsing ─────────────────────────────────────────────────────────
  //
  // Seven sections, each holding rows several fields deep: a real blueprint runs to a dozen
  // screens, and reaching Scenes meant scrolling past every rule's conditions. So both levels
  // collapse — sections to a header and a count, rows to a one-line summary.
  //
  // Row state is keyed on the row *object* rather than its index. A WeakSet survives splices and
  // reordering, where an index set would silently hand "expanded" to whichever row slid into the
  // vacated slot; it also keeps the state off the draft, so it cannot leak into the saved
  // document or a round-trip through toDocument/toDraft.

  private expandedRows = new WeakSet<object>();
  private openSections = new Set<SectionId>(['details', 'slots']);

  sectionOpen(id: SectionId): boolean {
    return this.openSections.has(id);
  }

  toggleSection(id: SectionId): void {
    if (!this.openSections.delete(id)) this.openSections.add(id);
  }

  isRowOpen(row: object): boolean {
    return this.expandedRows.has(row);
  }

  toggleRow(row: object): void {
    if (!this.expandedRows.delete(row)) this.expandedRows.add(row);
  }

  /** A row the admin just added starts expanded — they added it in order to fill it in. */
  private opened<T extends object>(row: T): T {
    this.expandedRows.add(row);
    return row;
  }

  /**
   * Collapsing must never hide the reason a publish failed, so a failed validation opens
   * everything. Deliberately not keyed off the problem text: those strings come from the server
   * and matching on them would quietly stop working the day one is reworded, leaving the admin
   * staring at a collapsed section with no idea the error is inside it.
   */
  private openAllSections(): void {
    for (const id of SECTIONS) this.openSections.add(id);
  }

  // ── Collapsed-row summaries ────────────────────────────────────────────
  //
  // Each names the row by the key rules reference it as, so the list stays scannable without
  // expanding anything.

  slotSummary(slot: SlotDraft): string {
    const kind = slot.sealed_template || 'no device kind chosen';
    return this.isMultiSlot(slot) ? `${kind} · ${slot.min_count}–${slot.max_count} devices` : kind;
  }

  /** A slot that can hold more than one device — its template references fan out to each. */
  isMultiSlot(slot: SlotDraft): boolean {
    return slot.max_count > 1;
  }

  setSlotMulti(slot: SlotDraft, multi: boolean): void {
    if (multi) {
      if (slot.max_count <= 1) slot.max_count = 8;
      if (slot.min_count < 1) slot.min_count = 1;
    } else {
      slot.min_count = 1;
      slot.max_count = 1;
    }
  }

  paramSummary(param: ParamDraft): string {
    const value = param.default_value?.trim();
    return value ? `${value}${param.unit?.trim() ?? ''}` : 'no default';
  }

  phaseSummary(phase: PhaseDraft): string {
    const parts: string[] = [];
    if (phase.duration_value && phase.duration_unit) {
      parts.push(`${phase.duration_value} ${phase.duration_unit}`);
    }
    parts.push(`sets ${phase.targets.length}`);
    return parts.join(' · ');
  }

  /**
   * What the duration the author just typed actually means (F11.13).
   *
   * A literal is the same length for every device on this lifecycle; a param is the whole point of
   * the feature and reads differently, so the hint says which of the two they have chosen rather
   * than making them infer it from an `@` they may not have noticed typing.
   */
  durationHint(phase: PhaseDraft): string {
    const value = (phase.duration_value ?? '').trim();
    if (!value) return 'A number, or a param every device can answer differently.';
    if (value.startsWith('@param.')) {
      const key = value.slice('@param.'.length);
      return this.paramKeys().includes(key)
        ? `Each device uses its own ${key} — override it per device to make this phase shorter for one of them.`
        : `⚠ "${key}" is not a param of this blueprint — publish will refuse it.`;
    }
    if (value.startsWith('@')) return `⚠ only @param. references may set a duration.`;
    return Number(value) > 0
      ? `The same ${value} ${phase.duration_unit ?? ''} for every device on this lifecycle.`
      : `⚠ "${value}" is neither a positive number nor a param.`;
  }

  // ── Phase advance trigger (F11.x) ──────────────────────────────────────
  //
  // A phase declares what ends it. A rule/pipeline decider must sit at the phase's lifecycle level:
  // once any slot is profiled every phase belongs to a bound device, so its decider must be
  // per_device (and cover this profile); otherwise the setup owns the lifecycle and the decider is
  // combined. The picker only offers automations that qualify, so an invalid pairing can't be built.

  /** A one-word chip for a collapsed phase row — how it advances, when that isn't manual. */
  phaseAdvanceChip(phase: PhaseDraft): string {
    switch (phase.advance_mode) {
      case 'schedule':
        return 'timed';
      case 'rule':
        return 'rule';
      case 'pipeline':
        return 'AI';
      default:
        return '';
    }
  }

  /** The declared rules or pipelines eligible to end a phase of the active profile. */
  advanceDeciders(mode: string): { key: string; name: string }[] {
    const anyProfiled = this.draft.slots.some((s) => s.profiled);
    const profileKey = this.activeProfile().key;
    const list: (RuleDraft | PipelineDraft)[] =
      mode === 'rule' ? this.draft.rules : this.draft.pipelines;
    return list
      .filter((a) => a.key)
      .filter((a) =>
        anyProfiled
          ? a.fan_out === 'per_device' &&
            (a.fan_out_profiles.length === 0 || a.fan_out_profiles.includes(profileKey))
          : a.fan_out !== 'per_device',
      )
      .map((a) => ({ key: a.key, name: a.name || a.key }));
  }

  /** Phases of the active profile a phase may point `advance_to_key` at ('' = next). */
  otherPhases(phase: PhaseDraft): PhaseDraft[] {
    return this.activeProfile().phases.filter((p) => p.key && p.key !== phase.key);
  }

  /**
   * Spin up the rule/pipeline that ends this phase, pre-scoped to the phase and pre-set to the
   * right fan-out level, then point the phase at it — so the author never leaves the phase to wire
   * its exit, even though the automation lives in its own (earlier) section.
   */
  createDecider(phase: PhaseDraft): void {
    const anyProfiled = this.draft.slots.some((s) => s.profiled);
    const profileKey = this.activeProfile().key;
    const name = `Advance ${phase.name || phase.key || 'phase'}`;
    const fanSlot = () => this.profiledFanOutSlots()[0]?.key ?? this.fanOutSlots()[0]?.key ?? '';

    if (phase.advance_mode === 'rule') {
      const rule = newRule();
      rule.name = name;
      rule.key = uniqueSlug(name, this.draft.rules.map((r) => r.key));
      rule.phase_scope = phase.key ? [phase.key] : [];
      if (anyProfiled) {
        rule.fan_out = 'per_device';
        rule.fan_out_slot_key = fanSlot();
        rule.fan_out_profiles = profileKey ? [profileKey] : [];
      }
      this.draft.rules.push(this.opened(rule));
      phase.advance_ref_key = rule.key;
    } else if (phase.advance_mode === 'pipeline') {
      const pipeline = newPipeline();
      pipeline.name = name;
      pipeline.key = uniqueSlug(name, this.draft.pipelines.map((p) => p.key));
      pipeline.phase_scope = phase.key ? [phase.key] : [];
      if (anyProfiled) {
        pipeline.fan_out = 'per_device';
        pipeline.fan_out_slot_key = fanSlot();
        pipeline.fan_out_profiles = profileKey ? [profileKey] : [];
      }
      this.draft.pipelines.push(this.opened(pipeline));
      phase.advance_ref_key = pipeline.key;
    } else {
      return;
    }
    const section = phase.advance_mode === 'rule' ? 'Rules' : 'Pipelines';
    this.snackBar.open(`Created "${name}" — finish it in the ${section} section below.`, 'OK', {
      duration: 5000,
    });
  }

  ruleSummary(rule: RuleDraft): string {
    // Name the combinator once there is more than one condition — with a single one it is noise.
    const how =
      rule.conditions.length > 1 ? ` (${rule.condition_operator === 'OR' ? 'any' : 'all'})` : '';
    return `${rule.conditions.length} condition(s)${how} → ${rule.actions.length} action(s)`;
  }

  sceneSummary(scene: SceneDraft): string {
    return `${scene.members.length} action(s)`;
  }

  pipelineSummary(pipeline: PipelineDraft): string {
    return `${pipeline.sensors.length} reading(s) · ${pipeline.stages.length} stage(s) · ${pipeline.triggers.length} trigger(s)`;
  }

  // ── Selection ──────────────────────────────────────────────────────────

  /** Selecting is just navigation now — the id in the URL drives the actual load via applyRouteId. */
  select(bp: BlueprintSummary): void {
    this.router.navigate(['/admin/blueprints', bp.id]);
  }

  newBlueprint(): void {
    this.router.navigate(['/admin/blueprints']);
  }

  /** Fetch a blueprint's full definition into the form. */
  private loadDraft(bp: BlueprintSummary): void {
    this.busy.set(true);
    this.service.get(bp.id).subscribe({
      next: (full) => {
        this.selected.set(bp);
        this.draft = toDraft(full as RawBlueprint);
        this.rememberSlotKeys();
        this.rememberParamKeys();
        this.rememberPersistedKeyed();
        this.problems.set([]);
        this.validated.set(false);
        this.busy.set(false);
      },
      error: () => {
        this.busy.set(false);
        this.snackBar.open('Could not load the blueprint', 'Close', { duration: 3000 });
      },
    });
  }

  /** The empty-form state, reached by navigating to the id-less route. */
  private resetToNew(): void {
    this.selected.set(null);
    this.draft = emptyDraft();
    this.problems.set([]);
    this.validated.set(false);
  }

  // ── Repeatable rows ────────────────────────────────────────────────────

  addSlot(): void {
    const slot = this.opened(newSlot());
    this.draft.slots.push(slot);
    this.committedSlotKey.set(slot, '');
  }
  // Adjustable and fixed params are declared in one array (their document order is a single
  // sort_order sequence) but shown as two groups: a fixed param is an alias the blueprint asserts,
  // not a value anyone tunes, and the two read as the same thing when interleaved. The split keys
  // off user_tunable, so flipping a card's toggle moves it between the groups.
  tunableParams(): ParamDraft[] {
    return this.draft.params.filter((p) => p.user_tunable);
  }
  fixedParams(): ParamDraft[] {
    return this.draft.params.filter((p) => !p.user_tunable);
  }
  addParam(tunable: boolean): void {
    const param = newParam();
    param.user_tunable = tunable;
    this.committedParamKey.set(param, '');
    this.draft.params.push(this.opened(param));
  }
  /** Remove by identity, not index: the two groups are filtered views, so an index isn't the
   *  position in draft.params. */
  removeParam(param: ParamDraft): void {
    const i = this.draft.params.indexOf(param);
    if (i >= 0) this.draft.params.splice(i, 1);
  }
  /** Move a param between the Adjustable and Fixed groups. A fixed alias has no unit, so drop any
   *  stale one on the way in — otherwise it would linger in the document behind a hidden field and
   *  reappear if the param were made adjustable again. */
  setParamTunable(param: ParamDraft, tunable: boolean): void {
    param.user_tunable = tunable;
    if (!tunable) param.unit = '';
  }
  // ── Lifecycles (F11.5) ──────────────────────────────────────────────────────────────────
  //
  // Phases hang off a profile, so the editor always edits ONE lifecycle at a time and switches
  // between them — rather than showing every phase of every lifecycle in one list, where two steps
  // called "Hold" belonging to different schedules would be indistinguishable.

  /** Choice lists the template renders — declared once in the model, surfaced for the form. */
  readonly fanOutModes = FAN_OUT_MODES;
  readonly fieldTypes = FIELD_TYPES;
  readonly fieldScopes = FIELD_SCOPES;

  /** Which lifecycle the phases section is editing. */
  activeProfileIndex = 0;

  activeProfile(): ProfileDraft {
    // A draft always has at least one (emptyDraft seeds it); clamp rather than trust the index,
    // which can outlive the profile it pointed at when one is removed.
    if (this.activeProfileIndex >= this.draft.profiles.length) this.activeProfileIndex = 0;
    return this.draft.profiles[this.activeProfileIndex]!;
  }

  selectProfile(index: number): void {
    this.activeProfileIndex = index;
  }

  addProfile(): void {
    this.draft.profiles.push(newProfile());
    this.activeProfileIndex = this.draft.profiles.length - 1;
  }

  /**
   * Remove a lifecycle, and with it any `phase_scope` that named only its phases — leaving a scope
   * pointing at a phase that no longer exists would silently make the automation inert.
   */
  removeProfile(index: number): void {
    const removed = this.draft.profiles[index];
    if (!removed || this.draft.profiles.length <= 1) return;
    this.draft.profiles.splice(index, 1);
    const live = new Set(allDraftPhases(this.draft).map((p) => p.key));
    for (const item of [...this.draft.rules, ...this.draft.scenes, ...this.draft.pipelines]) {
      item.phase_scope = item.phase_scope.filter((k) => live.has(k));
    }
    if (this.activeProfileIndex >= this.draft.profiles.length) {
      this.activeProfileIndex = this.draft.profiles.length - 1;
    }
  }

  /** True once more than one lifecycle exists — what the per-device slot toggle is for. */
  get hasSeveralProfiles(): boolean {
    return this.draft.profiles.length > 1;
  }

  addPhase(): void {
    const profile = this.activeProfile();
    profile.phases.push(this.opened(newPhase(profile.phases.length + 1)));
  }

  // ── The dynamic form (F11.6) ────────────────────────────────────────────────────────────
  addField(): void {
    this.draft.fields.push(this.opened(newField()));
  }
  addFieldOption(field: FieldDraft): void {
    field.options.push(newFieldOption());
  }
  /** Slots whose devices can be asked about individually — a per-device question needs one. */
  bindingSlots(): SlotDraft[] {
    return this.draft.slots.filter((s) => s.key);
  }

  // ── Fan-out (F11.2) ─────────────────────────────────────────────────────────────────────
  /** Slots a template can fan out over: only a multi-device one has anything to fan out to. */
  fanOutSlots(): SlotDraft[] {
    return this.draft.slots.filter((s) => s.key && s.max_count > 1);
  }
  /** The control is pointless — and the mode invalid — unless such a slot exists. */
  canFanOut(): boolean {
    return this.fanOutSlots().length > 0;
  }
  setFanOut(item: FanOutDraft, mode: string): void {
    item.fan_out = mode;
    if (mode === 'per_device' && !item.fan_out_slot_key) {
      item.fan_out_slot_key = this.fanOutSlots()[0]?.key ?? '';
    }
    // A combined template keeps its slot key only while a lifecycle selection still reads it.
    if (mode === 'combined' && item.fan_out_profiles.length === 0) item.fan_out_slot_key = '';
  }

  // ── Which devices (F11.9) ───────────────────────────────────────────────────────────────
  //
  // Orthogonal to the mode above: that says how many automations, this says which devices they
  // cover. Selection is by lifecycle because that is the only handle an author has — they write
  // the template long before the user owns a device, and a device moved onto another lifecycle
  // then joins and leaves the right automations without anyone editing anything.

  /** Multi-device slots whose devices each follow a lifecycle — the only ones selectable this way. */
  profiledFanOutSlots(): SlotDraft[] {
    return this.fanOutSlots().filter((s) => s.profiled);
  }
  /** The lifecycles offered as a filter, or none when no slot could be narrowed by one. */
  fanOutProfileChoices(): ProfileDraft[] {
    return this.profiledFanOutSlots().length > 0 ? this.draft.profiles : [];
  }
  /** Slots the "over slot" select offers — only profiled ones once a lifecycle filter is on. */
  fanOutSlotChoices(item: FanOutDraft): SlotDraft[] {
    return item.fan_out_profiles.length > 0 ? this.profiledFanOutSlots() : this.fanOutSlots();
  }
  /** The slot select is only worth showing when something actually reads the answer. */
  fanOutNeedsSlot(item: FanOutDraft): boolean {
    return item.fan_out === 'per_device' || item.fan_out_profiles.length > 0;
  }
  hasFanOutProfile(item: FanOutDraft, key: string): boolean {
    return item.fan_out_profiles.includes(key);
  }
  toggleFanOutProfile(item: FanOutDraft, key: string): void {
    const next = this.hasFanOutProfile(item, key)
      ? item.fan_out_profiles.filter((k) => k !== key)
      : [...item.fan_out_profiles, key];
    item.fan_out_profiles = next;
    // Narrowing needs a slot to narrow, and it has to be one whose devices have lifecycles at all.
    if (next.length > 0 && !this.profiledFanOutSlots().some((s) => s.key === item.fan_out_slot_key)) {
      item.fan_out_slot_key = this.profiledFanOutSlots()[0]?.key ?? '';
    }
    if (next.length === 0 && item.fan_out === 'combined') item.fan_out_slot_key = '';
  }
  /** "All of them" is the absence of a filter, not a value — clearing it is the whole action. */
  setFanOutAllDevices(item: FanOutDraft): void {
    item.fan_out_profiles = [];
    if (item.fan_out === 'combined') item.fan_out_slot_key = '';
  }
  fanOutProfileHint(item: FanOutDraft, noun: string): string {
    if (item.fan_out_profiles.length === 0) {
      return `${noun} covers every device bound to the slot.`;
    }
    const labels = item.fan_out_profiles
      .map((k) => this.draft.profiles.find((p) => p.key === k)?.label || k)
      .join(', ');
    return item.fan_out === 'per_device'
      ? `${noun} exists once per device on ${labels} — devices on any other lifecycle get none.`
      : `${noun} covers only the devices on ${labels}.`;
  }
  addPhaseTarget(phase: PhaseDraft): void {
    phase.targets.push({ param_key: '', value: '' });
  }
  addScene(): void {
    this.draft.scenes.push(this.opened(newScene()));
  }
  addSceneMember(scene: SceneDraft): void {
    scene.members.push(newSceneMember());
  }
  addRule(): void {
    this.draft.rules.push(this.opened(newRule()));
  }
  addCondition(rule: RuleDraft): void {
    rule.conditions.push(newCondition());
  }
  addRuleAction(rule: RuleDraft): void {
    rule.actions.push(newRuleAction());
  }
  addPipeline(): void {
    this.draft.pipelines.push(this.opened(newPipeline()));
  }
  addSensor(pipeline: PipelineDraft): void {
    pipeline.sensors.push(newSensor());
  }
  addStage(pipeline: PipelineDraft): void {
    pipeline.stages.push(newStage(pipeline.stages.length + 1));
  }
  addTrigger(pipeline: PipelineDraft): void {
    pipeline.triggers.push(newTrigger());
  }
  removeAt(list: unknown[], index: number): void {
    list.splice(index, 1);
  }

  /** Renumber after a removal so ordinals stay 1..n without the admin editing numbers by hand. */
  renumber(list: { ordinal: number }[]): void {
    list.forEach((item, i) => (item.ordinal = i + 1));
  }

  // Keys are machine identity — generated, never typed. Anywhere one would be *shown* to whoever is
  // authoring, show the label they actually wrote instead and keep the key as the bound value.
  // A key only appears where it is genuinely the subject: the `id` line and the row badge.
  paramLabel(key: string): string {
    return this.draft.params.find((p) => p.key === key)?.label || key;
  }

  slotLabel(key: string): string {
    return this.draft.slots.find((s) => s.key === key)?.label || key;
  }

  phaseLabel(key: string): string {
    return allDraftPhases(this.draft).find((p) => p.key === key)?.name || key;
  }

  // Phases an automation can be scoped to. A phase without a key can't be referenced yet (its key
  // follows its name), so it's excluded from the picker.
  // Across every lifecycle, deduped: a scope names phase KEYS, and the gate is evaluated against
  // whichever profile the bound device follows — so a key declared in any of them is scopable.
  /**
   * The phases an automation could actually be in — not every phase in the blueprint.
   *
   * A scope is evaluated against the phase of whatever the automation belongs to, so offering keys
   * it can never see produces a box that silently makes the automation inert. Two narrowings:
   *
   *  - a **combined** automation on a blueprint whose devices own the schedule has no phase of its
   *    own at all, and publish rejects a scope on it — so there is nothing to offer;
   *  - one limited to some lifecycles (F11.9) can only ever be in *those* lifecycles' phases.
   */
  scopablePhases(item?: FanOutDraft): PhaseDraft[] {
    const profiled = this.draft.slots.some((s) => s.profiled);
    if (!item) return allDraftPhases(this.draft);
    if (profiled && item.fan_out !== 'per_device') return [];
    const only = item.fan_out_profiles ?? [];
    const profiles =
      only.length > 0 ? this.draft.profiles.filter((p) => only.includes(p.key)) : this.draft.profiles;
    return phasesOf(profiles);
  }

  /** Why the phase picker is empty, so a missing control is never just a missing control. */
  scopeUnavailableReason(item: FanOutDraft): string | null {
    if (this.scopablePhases(item).length > 0) return null;
    if (this.draft.slots.some((s) => s.profiled) && item.fan_out !== 'per_device') {
      return 'Each bound device is in its own phase, so this setup-wide automation has no phase to be scoped to. Switch it to one per device to scope it.';
    }
    return null;
  }

  // The "Active in phases" chip text on a collapsed automation row. Empty scope = every phase.
  phaseScopeSummary(scope: string[]): string {
    if (!scope || scope.length === 0) return 'all phases';
    return scope.map((k) => this.phaseLabel(k)).join(', ');
  }

  // --- "Active in phases" checkbox group -------------------------------------------------------
  // Empty scope means every phase, so with nothing set every box reads as ticked (default true).
  isPhaseChecked(item: ScopableDraft, key: string): boolean {
    return item.phase_scope.length === 0 || item.phase_scope.includes(key);
  }

  // Keep the last remaining phase from being unticked — an automation active in no phase is
  // meaningless (disable it instead). The lone checked box is locked on.
  isOnlyCheckedPhase(item: ScopableDraft, key: string): boolean {
    return item.phase_scope.length === 1 && item.phase_scope[0] === key;
  }

  setPhaseChecked(item: ScopableDraft, key: string, checked: boolean): void {
    // Narrowed to the same set the checkboxes render, so unticking one key cannot silently drop
    // the phases this automation was never offered in the first place.
    const all = this.scopablePhases(item).map((p) => p.key);
    // Materialize the implicit "all" before toggling, then drop any keys no longer declared.
    const current = (item.phase_scope.length === 0 ? all : item.phase_scope).filter((k) =>
      all.includes(k),
    );
    let next = checked ? [...new Set([...current, key])] : current.filter((k) => k !== key);
    if (next.length === 0) next = [key]; // never leave an automation scoped to zero phases
    // All boxes ticked ⇒ store empty (= every phase, including ones a later version may add).
    item.phase_scope = all.every((k) => next.includes(k)) ? [] : next;
  }

  modelLabel(model: { kind: string; name: string; version: string } | null): string {
    return model ? `${model.kind}/${model.name}/${model.version}` : '';
  }

  compareModel = (
    a: { kind: string; name: string; version: string } | null,
    b: { kind: string; name: string; version: string } | null,
  ): boolean =>
    a === b || (!!a && !!b && a.kind === b.kind && a.name === b.name && a.version === b.version);

  // ── Save / validate / publish ──────────────────────────────────────────

  canSave(): boolean {
    return !this.busy() && !!this.draft.key.trim() && !!this.draft.name.trim();
  }

  save(): void {
    if (!this.canSave()) return;
    this.busy.set(true);
    this.service.import(toDocument(this.draft)).subscribe({
      next: (saved) => {
        this.busy.set(false);
        this.snackBar.open('Saved as a draft', 'Close', { duration: 2500 });
        this.load();
        // Set selected before navigating so applyRouteId's guard treats the new id as already-open
        // and keeps the draft, rather than re-fetching it.
        this.selected.set(saved);
        void this.router.navigate(['/admin/blueprints', saved.id]);
        this.validate();
      },
      error: (err) => {
        this.busy.set(false);
        this.problems.set([err?.error?.error ?? 'Save failed']);
        this.validated.set(true);
      },
    });
  }

  /** Validates the form's current contents, saved or not — so the verdict matches what is shown. */
  validate(): void {
    this.busy.set(true);
    this.service.validate(toDocument(this.draft)).subscribe({
      next: (result) => {
        this.problems.set(result.problems);
        this.validated.set(true);
        this.busy.set(false);
        if (result.problems.length > 0) this.openAllSections();
      },
      error: () => this.busy.set(false),
    });
  }

  publish(): void {
    const bp = this.selected();
    if (!bp) return;
    this.busy.set(true);
    // Save first: publishing validates what is *persisted*, so unsaved edits would be published
    // as their previous version and silently ignored.
    this.service.import(toDocument(this.draft)).subscribe({
      next: (saved) => {
        this.service.publish(saved.id).subscribe({
          next: () => {
            this.busy.set(false);
            this.problems.set([]);
            this.validated.set(true);
            // Publishing also reconciles every live setup — say so, because it is not obvious an
            // admin action reaches other people's devices.
            this.snackBar.open(
              saved.instance_count > 0
                ? `Published — ${saved.instance_count} live setup(s) updated`
                : 'Published',
              'Close',
              { duration: 4000 },
            );
            this.load();
            this.selected.set(saved);
            void this.router.navigate(['/admin/blueprints', saved.id]);
          },
          error: (err) => {
            this.busy.set(false);
            // The 400 carries every reason; a bare message would hide all but the first.
            this.problems.set(err?.error?.details ?? [err?.error?.error ?? 'Publish failed']);
            this.validated.set(true);
            this.openAllSections();
            this.load();
            this.selected.set(saved);
            void this.router.navigate(['/admin/blueprints', saved.id]);
          },
        });
      },
      error: (err) => {
        this.busy.set(false);
        this.problems.set([err?.error?.error ?? 'Save failed']);
        this.validated.set(true);
      },
    });
  }

  remove(bp: BlueprintSummary): void {
    if (bp.instance_count > 0) {
      this.snackBar.open(`${bp.instance_count} live setup(s) use this blueprint`, 'Close', {
        duration: 3500,
      });
      return;
    }
    this.service.remove(bp.id).subscribe({
      next: () => {
        if (this.selected()?.id === bp.id) this.newBlueprint();
        this.load();
        this.snackBar.open('Deleted', 'Close', { duration: 2000 });
      },
      error: () => this.snackBar.open('Could not delete', 'Close', { duration: 3000 }),
    });
  }

  /** The blueprint as a document, pretty-printed — the backup format. */
  private documentText(): string {
    return JSON.stringify(toDocument(this.draft), null, 2);
  }

  /** Save the blueprint to a file. This — not hand-written JSON — is what the panel is for. */
  downloadJson(): void {
    const blob = new Blob([this.documentText()], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `${this.draft.key || 'blueprint'}.json`;
    link.click();
    // Revoking immediately can cancel the download in some browsers; one tick is enough.
    setTimeout(() => URL.revokeObjectURL(url), 0);
  }

  /** Drop the document into the textarea so it can be read or copied out. */
  showJson(box: HTMLTextAreaElement): void {
    box.value = this.documentText();
    box.select();
  }

  /** Restore a previously saved document. Ids are kept as saved — see the note in the template. */
  importJson(text: string): void {
    try {
      const parsed = JSON.parse(text) as RawBlueprint;
      this.draft = toDraft(parsed);
      this.rememberSlotKeys();
      this.rememberParamKeys();
      // A pasted doc is unsaved, so clear any id from the URL. selected is nulled first, so the
      // resulting param event is a no-op guard hit and leaves this freshly-loaded draft in place.
      this.selected.set(null);
      void this.router.navigate(['/admin/blueprints']);
      this.snackBar.open('Loaded into the form — review, then save', 'Close', { duration: 3000 });
    } catch (err) {
      this.snackBar.open(
        err instanceof Error ? `Not valid JSON: ${err.message}` : 'Not valid JSON',
        'Close',
        { duration: 5000 },
      );
    }
  }
}
