import { db, Prisma } from '../db';

// Per-entity reconcile diff (scenes / rules / pipelines). Split out of the reconcile service so
// the orchestration (load, resolve, disable-removed, version bump) stays readable and each
// entity's create/update/skip/unresolvable decision lives in one focused function.
//
// Each function reconciles ONE template against its derived counterpart and returns the single
// ReconcileChange describing what happened. The rules that govern all three (match by
// blueprint_key, skip user_modified, never write a half-wired entity) live in the service header.

export interface ReconcileChange {
  kind: 'scene' | 'rule' | 'pipeline';
  blueprint_key: string;
  name: string;
  action: 'created' | 'updated' | 'skipped_user_modified' | 'disabled' | 'unresolvable';
  detail?: string;
}

// (slot, action) → the action ids on every bound device, or null when the reference is not fully
// resolvable (unbound slot, or the action missing on a bound device). Supplied by the service.
export type ResolveAll = (slotKey: string, actionName: string) => number[] | null;

// The bits of the instance a diff needs — its identity and where derived rows should land.
//
// One context per *entity*, not per instance (F11.2): a per-device template is reconciled once per
// bound device, each pass carrying that binding's id, its own name suffix and a `resolveAll` scoped
// to its own device. A combined template gets exactly one pass with `bindingId: null`, which is
// what every pre-F11 derived row already has.
export interface DiffContext {
  userId: number;
  areaId: number;
  instanceId: number;
  instanceName: string;
  resolveAll: ResolveAll;
  /** The devices bound to a slot — what a device_status condition resolves against. */
  devicesInSlot: (slotKey: string) => number[];
  /** The binding this entity belongs to, or null when it belongs to the whole setup. */
  bindingId: number | null;
  /** Appended to the template's name for a per-device entity; null leaves the name alone. */
  nameSuffix: string | null;
}

/** "Water low · Loop A" — kept in step with derive via @see blueprints.fanout. */
function entityName(base: string, ctx: DiffContext): string {
  return ctx.nameSuffix ? `${base} · ${ctx.nameSuffix}` : base;
}

type SceneTemplate = Prisma.BlueprintSceneTemplateGetPayload<{ include: { members: true } }>;
type RuleTemplate = Prisma.BlueprintRuleTemplateGetPayload<{
  include: { conditions: true; actions: true };
}>;
type PipelineTemplate = Prisma.BlueprintPipelineTemplateGetPayload<{
  include: { sensors: true; stages: true; triggers: true };
}>;
type DerivedScene = Prisma.SceneGetPayload<object>;
type DerivedRule = Prisma.UserRuleGetPayload<object>;
type DerivedPipeline = Prisma.PipelineGetPayload<object>;

// A scene name must be unique per user; a v2 that adds a scene can collide with something the user
// already has. Qualify with the instance name, then fall back to a counter.
export async function freeSceneName(
  userId: number,
  base: string,
  instanceName: string,
): Promise<string> {
  const taken = new Set(
    (await db.scene.findMany({ where: { user_id: userId }, select: { name: true } })).map(
      (s) => s.name,
    ),
  );
  if (!taken.has(base)) return base;
  const qualified = `${base} (${instanceName})`;
  if (!taken.has(qualified)) return qualified;
  for (let n = 2; ; n++) {
    const candidate = `${qualified} ${n}`;
    if (!taken.has(candidate)) return candidate;
  }
}

export async function reconcileSceneTemplate(
  template: SceneTemplate,
  existing: DerivedScene | undefined,
  ctx: DiffContext,
): Promise<ReconcileChange> {
  if (existing?.user_modified) {
    return {
      kind: 'scene',
      blueprint_key: template.key,
      name: existing.name,
      action: 'skipped_user_modified',
    };
  }
  let unresolved = 0;
  let sortOrder = 0;
  const memberData: Prisma.SceneMemberUncheckedCreateWithoutSceneInput[] = [];
  for (const m of template.members) {
    const ids = ctx.resolveAll(m.slot_key, m.action_name);
    if (ids === null) {
      unresolved++;
      continue;
    }
    for (const id of ids) {
      memberData.push({
        user_device_action_id: id,
        target_state: m.target_state,
        sort_order: sortOrder++,
        delay_seconds: m.delay_seconds,
        duration_seconds: m.duration_seconds,
      });
    }
  }
  if (unresolved > 0) {
    return {
      kind: 'scene',
      blueprint_key: template.key,
      name: entityName(template.name, ctx),
      action: 'unresolvable',
      detail: `${unresolved} member reference(s) not present on the bound devices`,
    };
  }

  if (existing) {
    await db.$transaction(async (tx) => {
      await tx.sceneMember.deleteMany({ where: { scene_id: existing.id } });
      await tx.scene.update({
        where: { id: existing.id },
        data: {
          phase_scope: template.phase_scope,
          updated_at: new Date(),
          members: { create: memberData },
        },
      });
    });
    return { kind: 'scene', blueprint_key: template.key, name: existing.name, action: 'updated' };
  }

  const name = await freeSceneName(ctx.userId, entityName(template.name, ctx), ctx.instanceName);
  await db.scene.create({
    data: {
      user_id: ctx.userId,
      name,
      sort_order: template.sort_order,
      area_id: ctx.areaId,
      blueprint_instance_id: ctx.instanceId,
      blueprint_binding_id: ctx.bindingId,
      blueprint_key: template.key,
      phase_scope: template.phase_scope,
      members: { create: memberData },
    },
  });
  return { kind: 'scene', blueprint_key: template.key, name, action: 'created' };
}

export async function reconcileRuleTemplate(
  template: RuleTemplate,
  existing: DerivedRule | undefined,
  ctx: DiffContext,
): Promise<ReconcileChange> {
  if (existing?.user_modified) {
    return {
      kind: 'rule',
      blueprint_key: template.key,
      name: existing.name,
      action: 'skipped_user_modified',
    };
  }
  let unresolved = 0;
  const conditionData: Prisma.UserRuleConditionUncheckedCreateWithoutRuleInput[] = [];
  for (const c of template.conditions) {
    // Written once so the two branches below cannot drift apart — they did: the resolved branch
    // was missing `schedule_until` / `schedule_every_minutes`, so reconciling a condition that
    // carried both a device action and a window silently dropped the window.
    const common = {
      condition_type: c.condition_type,
      operator: c.operator,
      threshold_value: c.threshold_value,
      status_value: c.status_value,
      schedule_time: c.schedule_time,
      schedule_until: c.schedule_until,
      schedule_every_minutes: c.schedule_every_minutes,
      schedule_days: c.schedule_days,
    };

    // A device_status condition is about the DEVICE — the engine reads `user_device_id` and
    // ignores the action. Resolving it here is what makes it able to fire at all; derive does the
    // same, and the two must agree or a reconcile would silently break a working rule.
    if (c.condition_type === 'device_status' || c.condition_type === 'device_state') {
      const deviceIds = c.slot_key ? ctx.devicesInSlot(c.slot_key) : [];
      if (c.slot_key && deviceIds.length === 0) {
        unresolved++;
        continue;
      }
      if (deviceIds.length === 0) {
        conditionData.push({ ...common, user_device_action_id: null, user_device_id: null });
      } else {
        for (const deviceId of deviceIds) {
          conditionData.push({ ...common, user_device_action_id: null, user_device_id: deviceId });
        }
      }
      continue;
    }

    // Schedule conditions carry no device action — pass them through unchanged.
    if (!(c.slot_key && c.action_name)) {
      conditionData.push({ ...common, user_device_action_id: null, user_device_id: null });
      continue;
    }
    const ids = ctx.resolveAll(c.slot_key, c.action_name);
    if (ids === null) {
      unresolved++;
      continue;
    }
    for (const id of ids) {
      conditionData.push({ ...common, user_device_action_id: id, user_device_id: null });
    }
  }
  const actionData: Prisma.UserRuleActionUncheckedCreateWithoutRuleInput[] = [];
  for (const a of template.actions) {
    const ids = ctx.resolveAll(a.slot_key, a.action_name);
    if (ids === null) {
      unresolved++;
      continue;
    }
    for (const id of ids) {
      actionData.push({
        user_device_action_id: id,
        target_state: a.target_state,
        delay_seconds: a.delay_seconds,
        duration_seconds: a.duration_seconds,
      });
    }
  }
  if (unresolved > 0) {
    return {
      kind: 'rule',
      blueprint_key: template.key,
      name: entityName(template.name, ctx),
      action: 'unresolvable',
      detail: `${unresolved} referenced action(s) not present on the bound devices`,
    };
  }

  if (existing) {
    await db.$transaction(async (tx) => {
      await tx.userRuleCondition.deleteMany({ where: { rule_id: existing.id } });
      await tx.userRuleAction.deleteMany({ where: { rule_id: existing.id } });
      await tx.userRule.update({
        where: { id: existing.id },
        data: {
          // Restore ONLY what reconcile itself switched off (a template that came back, a device
          // that returned to the fan-out selection). A user's own disable is left alone, because
          // toggling `enabled` is not drift and must not make the row abandoned either.
          ...(existing.disabled_by_reconcile
            ? { enabled: true, disabled_by_reconcile: false }
            : {}),
          name: entityName(template.name, ctx),
          is_emergency: template.is_emergency,
          condition_operator: template.condition_operator,
          cooldown_seconds: template.cooldown_seconds,
          phase_scope: template.phase_scope,
          updated_at: new Date(),
          conditions: { create: conditionData },
          actions: { create: actionData },
        },
      });
    });
    return {
      kind: 'rule',
      blueprint_key: template.key,
      name: entityName(template.name, ctx),
      action: 'updated',
    };
  }

  await db.userRule.create({
    data: {
      user_id: ctx.userId,
      name: entityName(template.name, ctx),
      is_emergency: template.is_emergency,
      condition_operator: template.condition_operator,
      cooldown_seconds: template.cooldown_seconds,
      phase_scope: template.phase_scope,
      area_id: ctx.areaId,
      blueprint_instance_id: ctx.instanceId,
      blueprint_binding_id: ctx.bindingId,
      blueprint_key: template.key,
      conditions: { create: conditionData },
      actions: { create: actionData },
    },
  });
  return {
    kind: 'rule',
    blueprint_key: template.key,
    name: entityName(template.name, ctx),
    action: 'created',
  };
}

export async function reconcilePipelineTemplate(
  template: PipelineTemplate,
  existing: DerivedPipeline | undefined,
  ctx: DiffContext,
): Promise<ReconcileChange> {
  if (existing?.user_modified) {
    return {
      kind: 'pipeline',
      blueprint_key: template.key,
      name: existing.name,
      action: 'skipped_user_modified',
    };
  }
  let unresolved = 0;
  const sensorData: Prisma.PipelineSensorUncheckedCreateWithoutPipelineInput[] = [];
  for (const s of template.sensors) {
    const ids = ctx.resolveAll(s.slot_key, s.action_name);
    if (ids === null) {
      unresolved++;
      continue;
    }
    for (const id of ids) {
      sensorData.push({
        group_name: s.group_name,
        description: s.description,
        user_device_action_id: id,
        inject_as_sensor: s.inject_as_sensor,
        inject_as_action: s.inject_as_action,
        min_value: s.min_value,
        max_value: s.max_value,
        compression: s.compression,
        window_minutes: s.window_minutes,
        n: s.n,
      });
    }
  }
  const triggerData: Prisma.PipelineTriggerUncheckedCreateWithoutPipelineInput[] = [];
  for (const t of template.triggers) {
    // Schedule triggers carry no device action — pass through unchanged.
    if (!(t.slot_key && t.action_name)) {
      triggerData.push({
        trigger_type: t.trigger_type,
        user_device_action_id: null,
        operator: t.operator,
        threshold_value: t.threshold_value,
        schedule_time: t.schedule_time,
        schedule_until: t.schedule_until,
        schedule_every_minutes: t.schedule_every_minutes,
        schedule_days: t.schedule_days,
        min_interval_sec: t.min_interval_sec,
      });
      continue;
    }
    const ids = ctx.resolveAll(t.slot_key, t.action_name);
    if (ids === null) {
      unresolved++;
      continue;
    }
    for (const id of ids) {
      triggerData.push({
        trigger_type: t.trigger_type,
        user_device_action_id: id,
        operator: t.operator,
        threshold_value: t.threshold_value,
        schedule_time: t.schedule_time,
        schedule_until: t.schedule_until,
        schedule_every_minutes: t.schedule_every_minutes,
        schedule_days: t.schedule_days,
        min_interval_sec: t.min_interval_sec,
      });
    }
  }
  if (unresolved > 0) {
    return {
      kind: 'pipeline',
      blueprint_key: template.key,
      name: entityName(template.name, ctx),
      action: 'unresolvable',
      detail: `${unresolved} referenced action(s) not present on the bound devices`,
    };
  }
  const stageData = template.stages.map((s) => ({
    ordinal: s.ordinal,
    kind: s.kind,
    ml_model_id: s.ml_model_id,
    prompt_template: s.prompt_template,
    notify: s.notify,
    execute_condition: s.execute_condition,
  }));

  if (existing) {
    await db.$transaction(async (tx) => {
      await tx.pipelineStage.deleteMany({ where: { pipeline_id: existing.id } });
      await tx.pipelineSensor.deleteMany({ where: { pipeline_id: existing.id } });
      await tx.pipelineTrigger.deleteMany({ where: { pipeline_id: existing.id } });
      await tx.pipeline.update({
        where: { id: existing.id },
        data: {
          name: entityName(template.name, ctx),
          // A template that ships disabled is the author's statement and still wins. Otherwise
          // reconcile restores only its own disable, exactly as for rules above — before this,
          // `enabled: template.enabled` also silently re-enabled pipelines the user had turned off.
          ...(template.enabled === false
            ? { enabled: false }
            : existing.disabled_by_reconcile
              ? { enabled: true, disabled_by_reconcile: false }
              : {}),
          phase_scope: template.phase_scope,
          updated_at: new Date(),
          sensors: { create: sensorData },
          stages: { create: stageData },
          triggers: { create: triggerData },
        },
      });
    });
    return {
      kind: 'pipeline',
      blueprint_key: template.key,
      name: entityName(template.name, ctx),
      action: 'updated',
    };
  }

  await db.pipeline.create({
    data: {
      user_id: ctx.userId,
      name: entityName(template.name, ctx),
      enabled: template.enabled,
      phase_scope: template.phase_scope,
      area_id: ctx.areaId,
      blueprint_instance_id: ctx.instanceId,
      blueprint_binding_id: ctx.bindingId,
      blueprint_key: template.key,
      sensors: { create: sensorData },
      stages: { create: stageData },
      triggers: { create: triggerData },
    },
  });
  return {
    kind: 'pipeline',
    blueprint_key: template.key,
    name: entityName(template.name, ctx),
    action: 'created',
  };
}
