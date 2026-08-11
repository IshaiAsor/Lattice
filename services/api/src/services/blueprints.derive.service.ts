import { db, Prisma } from '../db';
import { createLogger } from '@lattice/logger';
import { buildSlotActionResolver, type SlotActionResolver } from './blueprints.addressing';
import { fanTargets, fannedName, type FanTarget } from './blueprints.fanout';
import {
  deriveInclude,
  fieldPrompts,
  matchSlots,
  unmetSlots,
  type DerivableBlueprint,
  type DerivePreview,
} from './blueprints.derive.matching';

const log = createLogger('api:blueprints-derive');

// Derive (F10.3) — turn a published blueprint into one user's live setup: bind their devices to
// its slots, put them in a new Area, and materialize the scenes/rules/pipelines the templates
// describe.
//
// Two things this deliberately does NOT do:
//
//  - It does not materialize device config. A sealed device's user_device_actions are written by
//    device-gateway when the device provisions (and re-written when an admin releases the
//    template), so by the time a device is bindable its actions already exist. Derive only reads
//    them. A device whose sealed template was never released therefore has no actions, and derive
//    fails naming it rather than silently producing automations wired to nothing — the fix is to
//    release the template, which re-materializes through the existing SEALED_TEMPLATE_APPLIED path.
//
//  - It does not resolve `@param.` / `@phase.` references. Those are copied through verbatim into
//    the derived rows; resolution happens at evaluation time against the instance's current phase
//    and overrides. That is the whole point — see prisma/schema.prisma tier 7.
//
// Derived rows are written directly rather than through rules/scenes/pipelines.service, whose
// validation assumes literal values from the UI (numeric thresholds, ownership re-checks) and
// would reject a stored reference. Ownership is guaranteed structurally here instead: every
// action id comes from a device the caller was just verified to own.

function badRequest(message: string): Error {
  return Object.assign(new Error(message), { statusCode: 400 });
}
function notFound(message: string): Error {
  return Object.assign(new Error(message), { statusCode: 404 });
}
function conflict(message: string): Error {
  return Object.assign(new Error(message), { statusCode: 409 });
}

// The document shape, slot-match types and matchSlots live in blueprints.derive.matching; this
// file owns binding, materialization and the write transaction. These two are the request/result
// contracts of the derive itself, so they stay here beside it.
export interface DeriveRequest {
  name: string;
  /**
   * Explicit picks, one per slot. Slots left out fall back to auto-bind.
   *
   * A pick on a **profiled** slot carries the lifecycle that device follows and, optionally, what
   * the user calls it. `profile_key` is required there — a bound device with no lifecycle is one
   * the setup can never start. It may instead be *implied* by a field answer whose option names a
   * profile (F11.6), which is the shape the wizard actually uses.
   */
  bindings?: {
    slot_key: string;
    user_device_id: number;
    profile_key?: string | null;
    label?: string | null;
    /** Answers to this blueprint's `scope: 'binding'` fields, for this device (F11.6). */
    field_values?: { field_key: string; value: string }[];
  }[];
  /** Answers to this blueprint's `scope: 'setup'` fields (F11.6). */
  field_values?: { field_key: string; value: string }[];
}

export interface DeriveResult {
  instance_id: number;
  area_id: number;
  name: string;
  /** `not_started` for anything with phases — deriving builds a setup, it does not start it. */
  lifecycle_state: string;
  /** Always null now: nothing is entered until the user starts the setup (F10.13). */
  current_phase: string | null;
  /** The phase Start will offer first, so the caller can name where it is about to begin. */
  first_phase: string | null;
  bindings: {
    slot_key: string;
    user_device_id: number;
    auto_bound: boolean;
    /** The lifecycle this device follows; null on a shared (unprofiled) device. */
    profile_key: string | null;
    label: string | null;
  }[];
  created: { scenes: number; rules: number; pipelines: number };
}

async function loadPublished(blueprintId: number): Promise<DerivableBlueprint> {
  const bp = await db.blueprint.findUnique({ where: { id: blueprintId }, include: deriveInclude });
  if (!bp) throw notFound('Blueprint not found');
  if (bp.status !== 'published') {
    throw badRequest(
      `blueprint "${bp.key}" is ${bp.status}; only a published blueprint can derive`,
    );
  }
  return bp;
}

// Scenes are unique per (user, name), so a template name that the user already used has to give
// way. Qualify with the instance name first (readable, and what a second derive of the same
// blueprint wants anyway), then fall back to a counter.
function uniqueName(base: string, instanceName: string, taken: Set<string>): string {
  const candidates = [base, `${base} (${instanceName})`];
  for (const c of candidates) {
    if (!taken.has(c)) {
      taken.add(c);
      return c;
    }
  }
  for (let n = 2; ; n++) {
    const c = `${base} (${instanceName}) ${n}`;
    if (!taken.has(c)) {
      taken.add(c);
      return c;
    }
  }
}

export const blueprintsDeriveService = {
  // What a derive would bind, without writing anything. Drives the wizard and makes an
  // unsatisfiable blueprint diagnosable before the user names an instance.
  async preview(userId: number, blueprintId: number): Promise<DerivePreview> {
    const bp = await loadPublished(blueprintId);
    const slots = await matchSlots(userId, bp);
    return {
      blueprint_id: bp.id,
      key: bp.key,
      name: bp.name,
      version: bp.version,
      slots,
      profiles: bp.profiles.map((pr) => ({ key: pr.key, label: pr.label })),
      fields: fieldPrompts(bp),
      unmet: unmetSlots(slots),
    };
  },

  async derive(userId: number, blueprintId: number, req: DeriveRequest): Promise<DeriveResult> {
    const instanceName = req?.name?.trim();
    if (!instanceName) throw badRequest('name is required');

    const bp = await loadPublished(blueprintId);
    const matches = await matchSlots(userId, bp);
    // Explicit picks grouped by slot: a slot may take several devices (a multi-device slot), so a
    // slot key can appear more than once in req.bindings.
    const chosenBySlot = new Map<string, number[]>();
    for (const b of req.bindings ?? []) {
      const arr = chosenBySlot.get(b.slot_key) ?? [];
      if (!arr.includes(b.user_device_id)) arr.push(b.user_device_id);
      chosenBySlot.set(b.slot_key, arr);
    }

    log.debug(
      {
        userId,
        blueprint: bp.key,
        version: bp.version,
        instanceName,
        requestedBindings: [...chosenBySlot].map(([slot, ids]) => `${slot}=${ids.join(',')}`),
        slots: matches.map((m) => ({
          slot: m.slot_key,
          required: m.required,
          count: `${m.min_count}..${m.max_count}`,
          candidates: m.candidates.map((c) => c.user_device_id),
          autoBind: m.auto_bind,
        })),
        templates: {
          scenes: bp.scenes.length,
          rules: bp.rules.length,
          pipelines: bp.pipelines.length,
        },
      },
      'derive: starting',
    );

    // ─── Resolve every slot to its bound device(s) ───────────────────────────
    // A slot may bind more than one device; leaf references to it fan out to one row per device
    // below. bindings holds one row per (slot, device).
    const bindings: {
      slot_key: string;
      user_device_id: number;
      auto_bound: boolean;
      profile_key: string | null;
      label: string | null;
      /** Answers to this blueprint's per-device fields, written with the binding (F11.6). */
      field_values: { field_key: string; value: string }[];
    }[] = [];
    // Profile choices from the request, keyed per (slot, device) — asked once per bound device.
    const pickBySlotDevice = new Map<
      string,
      {
        profile_key?: string | null;
        label?: string | null;
        field_values?: { field_key: string; value: string }[];
      }
    >((req.bindings ?? []).map((b) => [`${b.slot_key}::${b.user_device_id}`, b]));
    const profileKeys = new Set(bp.profiles.map((pr) => pr.key));

    // ─── The dynamic form (F11.6) ────────────────────────────────────────────
    const fieldByKey = new Map(bp.fields.map((f) => [f.key, f]));
    /**
     * Validate one device's or the setup's answers, and report the profile an answer implies.
     *
     * Returns the accepted rows rather than writing them, so a bad answer fails the whole derive
     * before anything is created — the same fail-before-write discipline as slot resolution.
     */
    const readAnswers = (
      scope: 'setup' | 'binding',
      slotKey: string | null,
      answers: { field_key: string; value: string }[] | undefined,
      where: string,
    ): { rows: { field_key: string; value: string }[]; profileFromAnswer: string | null } => {
      const given = new Map((answers ?? []).map((a) => [a.field_key, a.value]));
      const rows: { field_key: string; value: string }[] = [];
      let profileFromAnswer: string | null = null;

      for (const [key, value] of given) {
        const field = fieldByKey.get(key);
        if (!field) throw badRequest(`"${key}" is not a field of blueprint "${bp.key}"`);
        if (field.scope !== scope || (scope === 'binding' && field.slot_key !== slotKey)) {
          throw badRequest(`field "${key}" is not asked ${where}`);
        }
        if (field.input_type === 'select') {
          const option = field.options.find((o) => o.value === value);
          if (!option) {
            throw badRequest(
              `"${value}" is not an option of field "${key}" (has: ${field.options.map((o) => o.value).join(', ')})`,
            );
          }
          // One question, both facts: the answer is recorded AND it decides the lifecycle.
          if (option.profile_key) profileFromAnswer = option.profile_key;
        }
        rows.push({ field_key: key, value });
      }

      // A required field with neither an answer nor a default cannot be left unresolved: every
      // `@field.` reference to it would silently resolve to null.
      for (const field of bp.fields) {
        if (field.scope !== scope) continue;
        if (scope === 'binding' && field.slot_key !== slotKey) continue;
        if (given.has(field.key)) continue;
        if (field.default_value != null && field.default_value !== '') {
          rows.push({ field_key: field.key, value: field.default_value });
          continue;
        }
        if (field.required) throw badRequest(`"${field.label}" is required (field "${field.key}")`);
      }
      return { rows, profileFromAnswer };
    };

    const setupAnswers = readAnswers('setup', null, req.field_values, 'for this setup');

    for (const match of matches) {
      const picks = chosenBySlot.get(match.slot_key) ?? [];
      let deviceIds: number[];
      let autoBound: boolean;

      if (picks.length > 0) {
        for (const pick of picks) {
          const candidate = match.candidates.find((c) => c.user_device_id === pick);
          if (!candidate) {
            throw badRequest(
              `device ${pick} does not match slot "${match.slot_key}" (needs sealed template "${match.sealed_template}")`,
            );
          }
          // The dialog greys these out, which is not a guarantee — a stale preview or a direct
          // call would otherwise let one device be driven by two setups at once. This read happens
          // before the write transaction, so it is a *message*, not the invariant: the unique index
          // on blueprint_slot_bindings.user_device_id is what actually closes the race, and the
          // transaction below turns its violation back into this same 409.
          if (!candidate.free) {
            throw badRequest(
              `"${candidate.name}" is already part of another setup, so it cannot fill slot "${match.slot_key}"`,
            );
          }
        }
        deviceIds = picks;
        autoBound = false;
      } else if (match.auto_bind.length > 0) {
        deviceIds = match.auto_bind;
        autoBound = true;
      } else {
        // Nothing chosen and nothing to auto-bind. An optional slot is simply left empty (its
        // templates are skipped below); a required one fails the derive, named.
        if (!match.required) {
          log.debug(
            { slot: match.slot_key, candidates: match.candidates.length },
            'derive: optional slot left unbound — templates referencing it will be skipped',
          );
          continue;
        }
        const free = match.candidates.filter((c) => c.free);
        throw badRequest(
          match.candidates.length === 0
            ? `no device matches required slot "${match.slot_key}" (needs sealed template "${match.sealed_template}")`
            : free.length === 0
              ? `every device matching required slot "${match.slot_key}" is already part of another setup`
              : `slot "${match.slot_key}" matches ${free.length} available devices but holds ${match.min_count}–${match.max_count} — pass bindings to choose`,
        );
      }

      // Count must fit the slot. Required slots need at least min_count (and at least one);
      // optional slots that the user did fill still may not exceed the cap.
      const min = match.required ? Math.max(match.min_count, 1) : 1;
      if (deviceIds.length < min) {
        throw badRequest(
          `slot "${match.slot_key}" needs at least ${min} device(s), got ${deviceIds.length}`,
        );
      }
      if (deviceIds.length > match.max_count) {
        throw badRequest(
          `slot "${match.slot_key}" accepts at most ${match.max_count} device(s), got ${deviceIds.length}`,
        );
      }

      for (const id of deviceIds) {
        const pick = pickBySlotDevice.get(`${match.slot_key}::${id}`);
        const answers = readAnswers(
          'binding',
          match.slot_key,
          pick?.field_values,
          `for a device of slot "${match.slot_key}"`,
        );
        let profileKey: string | null = null;

        if (match.profiled) {
          // Three ways to know the lifecycle, most explicit first: the caller said so; an answer
          // implied it (F11.6); or there is only one profile, so no question was worth asking.
          // Silently defaulting past all three would put a device on a lifecycle nobody chose.
          profileKey =
            pick?.profile_key ??
            answers.profileFromAnswer ??
            (bp.profiles.length === 1 ? bp.profiles[0]!.key : null);
          if (!profileKey) {
            throw badRequest(
              `slot "${match.slot_key}" needs a profile per device (has: ${[...profileKeys].join(', ')})`,
            );
          }
          if (!profileKeys.has(profileKey)) {
            throw badRequest(
              `"${profileKey}" is not a profile of blueprint "${bp.key}" (has: ${[...profileKeys].join(', ')})`,
            );
          }
        } else if (pick?.profile_key) {
          throw badRequest(
            `slot "${match.slot_key}" does not take a profile — only a profiled slot has a lifecycle of its own`,
          );
        }

        bindings.push({
          slot_key: match.slot_key,
          user_device_id: id,
          auto_bound: autoBound,
          profile_key: profileKey,
          label: pick?.label?.trim() || null,
          field_values: answers.rows,
        });
      }
      log.debug(
        { slot: match.slot_key, deviceIds, autoBound },
        `derive: slot bound (${deviceIds.length} device(s))`,
      );
    }

    // ─── (slot_key, action_name) → user_device_action.id[] ───────────────────
    // The shared resolver fans a reference out to every device bound to the slot (same mapping
    // reconcile uses). Actions come from the sealed template materialization done at provision
    // time; see the header note on why derive reads rather than writes them.
    const allDeviceIds = [...new Set(bindings.map((b) => b.user_device_id))];
    const fullResolver = await buildSlotActionResolver(bindings);
    const deviceNames = new Map(
      matches.flatMap((m) => m.candidates.map((c) => [c.user_device_id, c.name] as const)),
    );

    const missing: string[] = [];
    // 'skip' means the slot is unbound (optional, no device) — the whole referencing entity is
    // dropped. Otherwise every bound device must carry the action; a gap is recorded and turns
    // into a hard 400 below (a half-wired automation is a broken one, not a smaller one).
    //
    // The resolver is per fan-out target (F11.2): a per-device entity gets one narrowed to its own
    // device for the fan-out slot, and every other slot still resolves to all of its devices.
    const resolveWith =
      (resolver: SlotActionResolver) =>
      (slotKey: string, actionName: string): number[] | 'skip' => {
        const devices = resolver.deviceCount(slotKey);
        if (devices === 0) return 'skip';
        const ids = resolver.actionIds(slotKey, actionName);
        if (ids.length < devices) missing.push(`${slotKey}.${actionName}`);
        return ids;
      };
    const resolverFor = (target: FanTarget, slotKey: string | null): SlotActionResolver =>
      target.deviceIds && slotKey ? fullResolver.scopedTo(slotKey, target.deviceIds) : fullResolver;

    // Resolve + fan out every entity first, so a device missing its config reports every gap at
    // once rather than one per retry. Each template yields a LIST of entities — one for a combined
    // template, one per bound device for a per_device one — and each entity carries a `skip` flag
    // (an unbound optional slot it references), its target, and its expanded leaf rows.
    const sceneMembers = bp.scenes.map((sc) =>
      fanTargets(sc, bindings, deviceNames).map((target) => {
        const resolve = resolveWith(resolverFor(target, sc.fan_out_slot_key));
        let skip = false;
        let order = 0;
        const members: {
          action_id: number;
          target_state: string;
          sort_order: number;
          delay_seconds: string | null;
          duration_seconds: string | null;
        }[] = [];
        for (const m of sc.members) {
          const ids = resolve(m.slot_key, m.action_name);
          if (ids === 'skip') {
            skip = true;
            continue;
          }
          for (const action_id of ids) {
            members.push({
              action_id,
              target_state: m.target_state,
              sort_order: order++,
              delay_seconds: m.delay_seconds,
              duration_seconds: m.duration_seconds,
            });
          }
        }
        return { skip, target, members };
      }),
    );
    const ruleData = bp.rules.map((r) =>
      fanTargets(r, bindings, deviceNames).map((target) => {
        const slotResolver = resolverFor(target, r.fan_out_slot_key);
        const resolve = resolveWith(slotResolver);
        let skip = false;
        const conditions: (Omit<(typeof r.conditions)[number], 'slot_key' | 'action_name'> & {
          action_id: number | null;
          device_id: number | null;
        })[] = [];
        for (const c of r.conditions) {
          // A device_status condition asks about the DEVICE, not one of its actions — the engine
          // reads `user_device_id` and ignores `user_device_action_id`. That column was never
          // populated here, so every blueprint-authored device_status condition evaluated false
          // forever: the rule published clean and then simply never fired.
          if (c.condition_type === 'device_status' || c.condition_type === 'device_state') {
            const deviceIds = c.slot_key ? slotResolver.devicesInSlot(c.slot_key) : [];
            if (c.slot_key && deviceIds.length === 0) {
              skip = true;
              continue;
            }
            // One condition per bound device, the same expansion a threshold gets per action.
            if (deviceIds.length === 0) {
              conditions.push({ ...c, action_id: null, device_id: null });
            } else {
              for (const device_id of deviceIds) {
                conditions.push({ ...c, action_id: null, device_id });
              }
            }
            continue;
          }
          if (!(c.slot_key && c.action_name)) {
            conditions.push({ ...c, action_id: null, device_id: null });
            continue;
          }
          const ids = resolve(c.slot_key, c.action_name);
          if (ids === 'skip') {
            skip = true;
            continue;
          }
          for (const action_id of ids) conditions.push({ ...c, action_id, device_id: null });
        }
        // Both positional columns are text since F11.14 and are copied through verbatim, exactly
        // like target_state: derive materialises references, it does not resolve them.
        const actionsOut: {
          action_id: number;
          target_state: string;
          delay_seconds: string | null;
          duration_seconds: string | null;
        }[] = [];
        for (const a of r.actions) {
          const ids = resolve(a.slot_key, a.action_name);
          if (ids === 'skip') {
            skip = true;
            continue;
          }
          for (const action_id of ids) {
            actionsOut.push({
              action_id,
              target_state: a.target_state,
              delay_seconds: a.delay_seconds,
              duration_seconds: a.duration_seconds,
            });
          }
        }
        return { skip, target, conditions, actions: actionsOut };
      }),
    );
    const pipelineData = bp.pipelines.map((p) =>
      fanTargets(p, bindings, deviceNames).map((target) => {
        const resolve = resolveWith(resolverFor(target, p.fan_out_slot_key));
        let skip = false;
        const sensors: (Omit<(typeof p.sensors)[number], 'slot_key' | 'action_name'> & {
          action_id: number;
        })[] = [];
        for (const s of p.sensors) {
          const ids = resolve(s.slot_key, s.action_name);
          if (ids === 'skip') {
            skip = true;
            continue;
          }
          for (const action_id of ids) sensors.push({ ...s, action_id });
        }
        const triggers: (Omit<(typeof p.triggers)[number], 'slot_key' | 'action_name'> & {
          action_id: number | null;
        })[] = [];
        for (const t of p.triggers) {
          if (!(t.slot_key && t.action_name)) {
            triggers.push({ ...t, action_id: null });
            continue;
          }
          const ids = resolve(t.slot_key, t.action_name);
          if (ids === 'skip') {
            skip = true;
            continue;
          }
          for (const action_id of ids) triggers.push({ ...t, action_id });
        }
        return { skip, target, sensors, triggers };
      }),
    );

    if (missing.length > 0) {
      log.warn(
        { userId, blueprint: bp.key, missing: [...new Set(missing)] },
        'derive: refused — bound devices are missing actions the blueprint needs',
      );
      throw Object.assign(
        new Error(
          'A bound device is missing actions this blueprint needs — release its sealed template so its config is materialized',
        ),
        { statusCode: 400, details: [...new Set(missing)].map((m) => `unresolved action ${m}`) },
      );
    }

    for (const [i, entities] of sceneMembers.entries()) {
      for (const s of entities) {
        if (s.skip)
          log.info({ scene: bp.scenes[i]!.key }, 'derive: scene skipped (optional slot unbound)');
      }
    }
    for (const [i, entities] of ruleData.entries()) {
      for (const r of entities) {
        if (r.skip)
          log.info({ rule: bp.rules[i]!.key }, 'derive: rule skipped (optional slot unbound)');
      }
    }
    for (const [i, entities] of pipelineData.entries()) {
      for (const p of entities) {
        if (p.skip) {
          log.info(
            { pipeline: bp.pipelines[i]!.key },
            'derive: pipeline skipped (optional slot unbound)',
          );
        }
      }
    }

    // The lifecycle a setup follows when its own slots are unprofiled — the single-lifecycle (F10)
    // shape, which is now the one-profile case.
    //
    // Once any slot IS profiled, the setup has no phase of its own: its bound devices each walk
    // their own, and there is no single answer to "which phase is this setup in". It is born
    // running instead, so its shared automations are live while each device is started separately.
    const setupHasOwnLifecycle = !bp.slots.some((s) => s.profiled);
    const firstPhase = setupHasOwnLifecycle ? (bp.profiles[0]?.phases[0] ?? null) : null;
    const takenSceneNames = new Set(
      (await db.scene.findMany({ where: { user_id: userId }, select: { name: true } })).map(
        (s) => s.name,
      ),
    );

    // ─── Write ───────────────────────────────────────────────────────────────
    const result = await db
      .$transaction(async (tx) => {
        const areaConflict = await tx.area.findUnique({
          where: { user_id_name: { user_id: userId, name: instanceName } },
          select: { id: true },
        });
        if (areaConflict) throw conflict(`an area named "${instanceName}" already exists`);
        const nameConflict = await tx.blueprintInstance.findUnique({
          where: { user_id_name: { user_id: userId, name: instanceName } },
          select: { id: true },
        });
        if (nameConflict) throw conflict(`a setup named "${instanceName}" already exists`);

        const area = await tx.area.create({ data: { user_id: userId, name: instanceName } });

        const instance = await tx.blueprintInstance.create({
          data: {
            user_id: userId,
            blueprint_id: bp.id,
            blueprint_version: bp.version,
            area_id: area.id,
            name: instanceName,
            // Derive builds the setup; it does not start it (F10.13). Binding a board says nothing
            // about when the process it watches began, so no phase is entered and no clock runs
            // until the user starts it and says where in the lifecycle they are.
            //
            // A blueprint with no phases has no lifecycle to start, and would be permanently inert
            // under the run/hold gate — so it is born running instead.
            lifecycle_state: firstPhase ? 'not_started' : 'running',
            current_phase_id: null,
            phase_started_at: null,
            field_values: { create: setupAnswers.rows },
          },
        });

        // Created one at a time rather than nested, because a per-device entity has to carry the id
        // of the binding it belongs to — that pair is the reconcile identity (F11.2).
        const bindingIdByDevice = new Map<string, number>();
        for (const { field_values, ...b } of bindings) {
          const row = await tx.blueprintSlotBinding.create({
            data: { instance_id: instance.id, ...b, field_values: { create: field_values } },
            select: { id: true },
          });
          bindingIdByDevice.set(`${b.slot_key}::${b.user_device_id}`, row.id);
        }
        // A combined entity belongs to no single binding, so its id is null — exactly what every
        // pre-F11 derived row has, which is why they keep reconciling on `blueprint_key` alone.
        const bindingIdFor = (slotKey: string | null, target: FanTarget): number | null =>
          target.deviceId !== null && slotKey
            ? (bindingIdByDevice.get(`${slotKey}::${target.deviceId}`) ?? null)
            : null;

        // Grouping the bound devices is the visible half of a derive — the dashboard sections by
        // area, and area-tagged automations name it in notifications (F10.7).
        await tx.userDevice.updateMany({
          where: { id: { in: allDeviceIds }, user_id: userId },
          data: { area_id: area.id, updated_at: new Date() },
        });

        const provenance = { blueprint_instance_id: instance.id, area_id: area.id };

        for (const [i, sc] of bp.scenes.entries()) {
          for (const entity of sceneMembers[i]!) {
            if (entity.skip) continue;
            await tx.scene.create({
              data: {
                ...provenance,
                blueprint_binding_id: bindingIdFor(sc.fan_out_slot_key, entity.target),
                user_id: userId,
                name: uniqueName(fannedName(sc.name, entity.target), instanceName, takenSceneNames),
                sort_order: sc.sort_order,
                blueprint_key: sc.key,
                phase_scope: sc.phase_scope,
                members: {
                  create: entity.members.map((m) => ({
                    user_device_action_id: m.action_id,
                    target_state: m.target_state,
                    sort_order: m.sort_order,
                    delay_seconds: m.delay_seconds,
                    // Was dropped here: the template carried a hold duration, the derived member
                    // never got one, and scenes.service dutifully read the null. A scene authored
                    // as "open for two minutes" opened indefinitely.
                    duration_seconds: m.duration_seconds,
                  })),
                },
              },
            });
          }
        }

        for (const [i, r] of bp.rules.entries()) {
          for (const entity of ruleData[i]!) {
            if (entity.skip) continue;
            await tx.userRule.create({
              data: {
                ...provenance,
                blueprint_binding_id: bindingIdFor(r.fan_out_slot_key, entity.target),
                user_id: userId,
                name: fannedName(r.name, entity.target),
                is_emergency: r.is_emergency,
                condition_operator: r.condition_operator,
                cooldown_seconds: r.cooldown_seconds,
                blueprint_key: r.key,
                phase_scope: r.phase_scope,
                conditions: {
                  create: entity.conditions.map((c) => ({
                    condition_type: c.condition_type,
                    user_device_action_id: c.action_id,
                    // Only a device_status condition carries one; see the resolution above.
                    user_device_id: c.device_id,
                    operator: c.operator,
                    threshold_value: c.threshold_value,
                    status_value: c.status_value,
                    schedule_time: c.schedule_time,
                    schedule_until: c.schedule_until,
                    schedule_every_minutes: c.schedule_every_minutes,
                    schedule_days: c.schedule_days,
                  })),
                },
                actions: {
                  create: entity.actions.map((a) => ({
                    user_device_action_id: a.action_id,
                    target_state: a.target_state,
                    delay_seconds: a.delay_seconds,
                    duration_seconds: a.duration_seconds,
                  })),
                },
              },
            });
          }
        }

        for (const [i, p] of bp.pipelines.entries()) {
          for (const entity of pipelineData[i]!) {
            if (entity.skip) continue;
            await tx.pipeline.create({
              data: {
                ...provenance,
                blueprint_binding_id: bindingIdFor(p.fan_out_slot_key, entity.target),
                user_id: userId,
                name: fannedName(p.name, entity.target),
                enabled: p.enabled,
                blueprint_key: p.key,
                phase_scope: p.phase_scope,
                sensors: {
                  create: entity.sensors.map((s) => ({
                    group_name: s.group_name,
                    description: s.description,
                    user_device_action_id: s.action_id,
                    inject_as_sensor: s.inject_as_sensor,
                    inject_as_action: s.inject_as_action,
                    min_value: s.min_value,
                    max_value: s.max_value,
                    compression: s.compression,
                    window_minutes: s.window_minutes,
                    n: s.n,
                  })),
                },
                stages: {
                  create: p.stages.map((s) => ({
                    ordinal: s.ordinal,
                    kind: s.kind,
                    ml_model_id: s.ml_model_id,
                    prompt_template: s.prompt_template,
                    notify: s.notify,
                    execute_condition: s.execute_condition,
                  })),
                },
                triggers: {
                  create: entity.triggers.map((t) => ({
                    trigger_type: t.trigger_type,
                    user_device_action_id: t.action_id,
                    operator: t.operator,
                    threshold_value: t.threshold_value,
                    schedule_time: t.schedule_time,
                    schedule_until: t.schedule_until,
                    schedule_every_minutes: t.schedule_every_minutes,
                    schedule_days: t.schedule_days,
                    min_interval_sec: t.min_interval_sec,
                  })),
                },
              },
            });
          }
        }

        return { instance, area };
      })
      .catch((err: unknown) => {
        // The unique index on user_device_id is the real "one device, one setup" invariant; the
        // friendly check above races it. Losing that race is a legitimate concurrent-derive outcome,
        // so it becomes the same 409 the user would have seen a moment earlier rather than a 500.
        if (
          err instanceof Prisma.PrismaClientKnownRequestError &&
          err.code === 'P2002' &&
          String(err.meta?.target ?? '').includes('user_device_id')
        ) {
          throw conflict(
            'one of these devices was just bound to another setup — reload and pick again',
          );
        }
        throw err;
      });

    log.info(
      {
        userId,
        blueprint: bp.key,
        version: bp.version,
        instanceId: result.instance.id,
        slots: bindings.length,
      },
      'blueprint derived',
    );

    return {
      instance_id: result.instance.id,
      area_id: result.area.id,
      name: instanceName,
      lifecycle_state: result.instance.lifecycle_state,
      // Null until the user starts it — the wizard's next step, not its side effect.
      current_phase: null,
      /** The phase Start will offer first, so the wizard can name where it is about to begin. */
      first_phase: firstPhase?.key ?? null,
      bindings,
      // Counted per created *entity*, not per template: a per_device template over four bound
      // devices really did create four rules, and the wizard's summary should say so.
      created: {
        scenes: sceneMembers.flat().filter((s) => !s.skip).length,
        rules: ruleData.flat().filter((r) => !r.skip).length,
        pipelines: pipelineData.flat().filter((p) => !p.skip).length,
      },
    };
  },

  // Published blueprints the user can derive, each with its slots already matched against their
  // fleet so the gallery can show "ready" vs "needs a device" without a second round trip.
  async listDerivable(userId: number): Promise<DerivePreview[]> {
    const published = await db.blueprint.findMany({
      where: { status: 'published' },
      include: deriveInclude,
      orderBy: { name: 'asc' },
    });
    const out: DerivePreview[] = [];
    for (const bp of published) {
      const slots = await matchSlots(userId, bp);
      out.push({
        blueprint_id: bp.id,
        key: bp.key,
        name: bp.name,
        version: bp.version,
        slots,
        profiles: bp.profiles.map((pr) => ({ key: pr.key, label: pr.label })),
        fields: fieldPrompts(bp),
        unmet: unmetSlots(slots),
      });
    }
    return out;
  },

  /**
   * Delete a setup, removing what the blueprint owns and keeping what the user made their own —
   * the same line reconcile draws with `skipped_user_modified`.
   *
   * An untouched derived scene/rule/pipeline is the blueprint's output, so it goes with the
   * blueprint's instance; one the user edited is theirs, so it is detached (SET NULL) and left
   * standing. The devices derive grouped are un-grouped, and the Area derive created is dropped
   * once nothing is left in it — without that last step the area name stays taken and setting the
   * same blueprint up again fails on the conflict check above.
   */
  async removeInstance(userId: number, instanceId: number): Promise<void> {
    const instance = await db.blueprintInstance.findUnique({
      where: { id: instanceId },
      select: {
        user_id: true,
        area_id: true,
        name: true,
        bindings: { select: { user_device_id: true } },
        scenes: { select: { id: true, user_modified: true } },
        rules: { select: { id: true, user_modified: true } },
        pipelines: { select: { id: true, user_modified: true } },
      },
    });
    if (!instance) throw notFound('Setup not found');
    if (instance.user_id !== userId) {
      throw Object.assign(new Error('Forbidden'), { statusCode: 403 });
    }

    const untouched = (rows: { id: number; user_modified: boolean }[]): number[] =>
      rows.filter((r) => !r.user_modified).map((r) => r.id);
    const sceneIds = untouched(instance.scenes);
    const ruleIds = untouched(instance.rules);
    const pipelineIds = untouched(instance.pipelines);
    const deviceIds = [...new Set(instance.bindings.map((b) => b.user_device_id))];
    const kept =
      instance.scenes.length +
      instance.rules.length +
      instance.pipelines.length -
      (sceneIds.length + ruleIds.length + pipelineIds.length);

    let areaRemoved = false;
    await db.$transaction(async (tx) => {
      if (sceneIds.length) await tx.scene.deleteMany({ where: { id: { in: sceneIds } } });
      if (ruleIds.length) await tx.userRule.deleteMany({ where: { id: { in: ruleIds } } });
      if (pipelineIds.length) await tx.pipeline.deleteMany({ where: { id: { in: pipelineIds } } });

      // Only the devices this setup put in the area, and only if they are still there — a device
      // the user has since moved elsewhere is not ours to touch.
      if (deviceIds.length) {
        await tx.userDevice.updateMany({
          where: { id: { in: deviceIds }, user_id: userId, area_id: instance.area_id },
          data: { area_id: null, updated_at: new Date() },
        });
      }

      await tx.blueprintInstance.delete({ where: { id: instanceId } });

      // Emptiness is the test, not ownership: a kept edit, a device the user moved in, or an
      // automation of their own all mean the area is now theirs and stays.
      const area = await tx.area.findUnique({
        where: { id: instance.area_id },
        select: {
          _count: {
            select: { devices: true, scenes: true, rules: true, pipelines: true, instances: true },
          },
        },
      });
      if (area && Object.values(area._count).every((n) => n === 0)) {
        await tx.area.delete({ where: { id: instance.area_id } });
        areaRemoved = true;
      }
    });

    log.info(
      {
        userId,
        instanceId,
        instance: instance.name,
        deleted: {
          scenes: sceneIds.length,
          rules: ruleIds.length,
          pipelines: pipelineIds.length,
        },
        keptUserModified: kept,
        devicesUngrouped: deviceIds.length,
        areaRemoved,
      },
      'setup deleted — blueprint-owned entities removed, user-edited ones detached and kept',
    );
  },
};
