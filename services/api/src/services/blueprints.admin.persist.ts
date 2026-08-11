import { positionalText } from '@lattice/params';
import {
  DEFAULT_PROFILE_KEY,
  type BlueprintDoc,
  type BlueprintProfileDoc,
  type FanOutDoc,
} from './blueprints.admin.types';

// Doc → Prisma nested-create payload for a blueprint's children. Pure data-shaping: name
// resolution (sealed template + ml model → row id) and the version bump are decided by the caller
// (importBlueprint, which owns the transaction and the resolve-before-write ordering) and passed
// in, so this stays a deterministic mapping with no DB access of its own.

export interface PersistContext {
  /** sealed_template name → row id, pre-resolved (a missing name is a caller error). */
  templateByName: Map<string, number>;
  /** `${kind}/${name}/${version}` → ml_models.id, pre-resolved. */
  modelIds: Map<string, number>;
  /** The version this write lands as — bumped only when replacing a published definition. */
  version: number;
}

/**
 * The profiles a document declares, normalising the single-lifecycle shorthand.
 *
 * `profiles` wins when present; otherwise a bare `phases` list becomes one implicit profile — the
 * same `default` key the F11 migration back-filled, so a blueprint authored either way and a
 * blueprint that predates profiles are indistinguishable downstream. A document with neither
 * declares no profiles at all, which is a blueprint with no lifecycle.
 */
export function profileDocs(doc: BlueprintDoc): BlueprintProfileDoc[] {
  if (doc.profiles?.length) return doc.profiles;
  if (!doc.phases?.length) return [];
  return [{ key: DEFAULT_PROFILE_KEY, label: 'Default', sort_order: 0, phases: doc.phases }];
}

/**
 * Fan-out columns, normalised (F11.2). `combined` is the default everywhere, and a combined
 * template carries no slot key — keeping a stale one would make the reconcile identity of an entity
 * depend on a column nothing reads.
 */
function fanOut(t: FanOutDoc): {
  fan_out: string;
  fan_out_slot_key: string | null;
  fan_out_profiles: string[];
} {
  const mode = t.fan_out === 'per_device' ? 'per_device' : 'combined';
  const profiles = [...new Set((t.fan_out_profiles ?? []).map((p) => p.trim()).filter(Boolean))];
  // A combined template keeps its slot key only when something still reads it — which since F11.9
  // includes a profile selector narrowing the devices the single entity covers, not just per_device.
  const keepsSlot = mode === 'per_device' || profiles.length > 0;
  return {
    fan_out: mode,
    fan_out_slot_key: keepsSlot ? (t.fan_out_slot_key ?? null) : null,
    // Kept verbatim even when no slot key names them, so publish validation sees — and rejects —
    // the same contradiction the builder does rather than having it normalised away in one path.
    fan_out_profiles: profiles,
  };
}

export function buildBlueprintDefinition(doc: BlueprintDoc, ctx: PersistContext) {
  const { templateByName, modelIds, version } = ctx;
  return {
    name: doc.name,
    description: doc.description ?? null,
    is_static: doc.is_static ?? false,
    context_notes: doc.context_notes ?? null,
    // A re-import always lands as a draft: publishing is an explicit, validated act.
    status: 'draft',
    version,
    slots: {
      create: doc.slots.map((s, i) => ({
        key: s.key,
        label: s.label,
        required: s.required ?? true,
        min_count: s.min_count ?? 1,
        max_count: s.max_count ?? 1,
        profiled: s.profiled ?? false,
        sealed_template_id: templateByName.get(s.sealed_template)!,
        sort_order: s.sort_order ?? i,
      })),
    },
    params: {
      create: (doc.params ?? []).map((p, i) => ({
        key: p.key,
        label: p.label,
        default_value: p.default_value,
        unit: p.unit ?? null,
        user_tunable: p.user_tunable ?? true,
        sort_order: p.sort_order ?? i,
      })),
    },
    // The dynamic form (F11.6): what the user is asked when they derive this. An option carrying
    // `profile_key` is what lets one answer both state a fact and choose that binding's lifecycle.
    fields: {
      create: (doc.fields ?? []).map((f, i) => ({
        key: f.key,
        label: f.label,
        help_text: f.help_text ?? null,
        input_type: f.input_type ?? 'text',
        scope: f.scope ?? 'setup',
        slot_key: f.scope === 'binding' ? (f.slot_key ?? null) : null,
        required: f.required ?? false,
        default_value: f.default_value ?? null,
        sort_order: f.sort_order ?? i,
        options: {
          create: (f.options ?? []).map((o, j) => ({
            value: o.value,
            label: o.label,
            profile_key: o.profile_key ?? null,
            sort_order: o.sort_order ?? j,
          })),
        },
      })),
    },
    // Phases live under a profile (F11). A document that declares only `phases` is the
    // single-lifecycle shape and gets one implicit profile, so both authoring styles land in the
    // same tables and nothing downstream has to know which was written.
    profiles: {
      create: profileDocs(doc).map((pr, i) => ({
        key: pr.key,
        label: pr.label,
        sort_order: pr.sort_order ?? i,
        phases: {
          create: pr.phases.map((ph) => ({
            key: ph.key,
            name: ph.name,
            ordinal: ph.ordinal,
            // Stored as text so a reference survives to evaluation time; a number written by an
            // older document (or the builder's number input) is the same value spelled differently.
            duration_value:
              ph.duration_value === null ||
              ph.duration_value === undefined ||
              ph.duration_value === ''
                ? null
                : String(ph.duration_value),
            duration_unit: ph.duration_unit ?? null,
            // `auto_advance` is the pre-F11.x spelling of `schedule`, still honoured rather than
            // ignored: a document written against the old shape would otherwise publish clean —
            // validation only checks a duration once the mode IS 'schedule' — and then sit in
            // `manual` forever, which looks identical to a phase nobody has got round to advancing.
            advance_mode: ph.advance_mode ?? (ph.auto_advance ? 'schedule' : 'manual'),
            advance_ref_key: ph.advance_ref_key ?? null,
            advance_to_key: ph.advance_to_key ?? null,
            context_notes: ph.context_notes ?? null,
            targets: {
              create: (ph.targets ?? []).map((t) => ({
                param_key: t.param_key,
                value: t.value,
              })),
            },
          })),
        },
      })),
    },
    scenes: {
      create: (doc.scenes ?? []).map((sc, i) => ({
        key: sc.key,
        name: sc.name,
        sort_order: sc.sort_order ?? i,
        phase_scope: sc.phase_scope ?? [],
        ...fanOut(sc),
        members: {
          create: sc.members.map((m, j) => ({
            slot_key: m.slot_key,
            action_name: m.action_name,
            target_state: m.target_state,
            sort_order: m.sort_order ?? j,
            delay_seconds: positionalText(m.delay_seconds),
            duration_seconds: positionalText(m.duration_seconds),
          })),
        },
      })),
    },
    rules: {
      create: (doc.rules ?? []).map((r) => ({
        key: r.key,
        name: r.name,
        is_emergency: r.is_emergency ?? false,
        condition_operator: r.condition_operator ?? 'AND',
        cooldown_seconds: r.cooldown_seconds ?? 60,
        phase_scope: r.phase_scope ?? [],
        ...fanOut(r),
        conditions: {
          create: r.conditions.map((c) => ({
            condition_type: c.condition_type,
            slot_key: c.slot_key ?? null,
            action_name: c.action_name ?? null,
            operator: c.operator ?? null,
            threshold_value: c.threshold_value ?? null,
            status_value: c.status_value ?? null,
            schedule_time: c.schedule_time ?? null,
            schedule_until: c.schedule_until ?? null,
            schedule_every_minutes: c.schedule_every_minutes ?? null,
            schedule_days: c.schedule_days ?? [],
          })),
        },
        actions: {
          create: r.actions.map((a) => ({
            slot_key: a.slot_key,
            action_name: a.action_name,
            target_state: a.target_state,
            delay_seconds: positionalText(a.delay_seconds),
            duration_seconds: positionalText(a.duration_seconds),
          })),
        },
      })),
    },
    pipelines: {
      create: (doc.pipelines ?? []).map((p) => ({
        key: p.key,
        name: p.name,
        enabled: p.enabled ?? true,
        phase_scope: p.phase_scope ?? [],
        ...fanOut(p),
        sensors: {
          create: p.sensors.map((s) => ({
            group_name: s.group_name,
            description: s.description,
            slot_key: s.slot_key,
            action_name: s.action_name,
            inject_as_sensor: s.inject_as_sensor ?? true,
            inject_as_action: s.inject_as_action ?? false,
            min_value: s.min_value ?? null,
            max_value: s.max_value ?? null,
            compression: s.compression ?? 'average',
            window_minutes: s.window_minutes ?? 60,
            n: s.n ?? null,
          })),
        },
        stages: {
          create: p.stages.map((s) => ({
            ordinal: s.ordinal,
            kind: s.kind,
            ml_model_id: s.ml_model
              ? (modelIds.get(`${s.ml_model.kind}/${s.ml_model.name}/${s.ml_model.version}`) ??
                null)
              : null,
            prompt_template: s.prompt_template ?? null,
            notify: s.notify ?? null,
            execute_condition: s.execute_condition ?? null,
          })),
        },
        triggers: {
          create: p.triggers.map((t) => ({
            trigger_type: t.trigger_type,
            slot_key: t.slot_key ?? null,
            action_name: t.action_name ?? null,
            operator: t.operator ?? null,
            threshold_value: t.threshold_value ?? null,
            schedule_time: t.schedule_time ?? null,
            schedule_until: t.schedule_until ?? null,
            schedule_every_minutes: t.schedule_every_minutes ?? null,
            schedule_days: t.schedule_days ?? [],
            min_interval_sec: t.min_interval_sec ?? null,
          })),
        },
      })),
    },
  };
}
