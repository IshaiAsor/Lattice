import { db } from '../db';
import { createLogger } from '@lattice/logger';
import { blueprintsReconcileService } from './blueprints.reconcile.service';
import {
  blueprintInclude,
  badRequest,
  notFound,
  conflict,
  type FullBlueprint,
  type BlueprintRow,
  type BlueprintDoc,
} from './blueprints.admin.types';
import { collectProblems, collectDocumentProblems } from './blueprints.admin.validation';
import { buildBlueprintDefinition } from './blueprints.admin.persist';

const log = createLogger('api:blueprints-admin');

// Blueprint authoring (admin only). A blueprint describes a whole multi-device setup: which
// devices it needs (slots, qualified by a released sealed template), what is tunable (params),
// how it changes over time (phases), and the scenes/rules/pipelines to materialize (templates).
//
// This file is the thin service (CRUD + import + publish). The document shape and Prisma include
// live in blueprints.admin.types; the publish/validate gate in blueprints.admin.validation; the
// doc→rows mapping in blueprints.admin.persist.

export type { FullBlueprint, BlueprintRow, BlueprintDoc } from './blueprints.admin.types';

export interface BlueprintSummary {
  id: number;
  key: string;
  name: string;
  description: string | null;
  version: number;
  status: string;
  slot_count: number;
  instance_count: number;
  updated_at: Date;
}

/** How a template fans out over a multi-device slot (F11.2). */
export const FAN_OUT_MODES = ['combined', 'per_device'] as const;

/** Where a phase sits now that phases hang off profiles: the pair that identifies one (F11). */
interface PhaseRef {
  profile: string;
  phase: string;
}

export const blueprintsAdminService = {
  async listBlueprints(): Promise<BlueprintSummary[]> {
    const rows = await db.blueprint.findMany({
      orderBy: { name: 'asc' },
      include: { _count: { select: { slots: true, instances: true } } },
    });
    return rows.map((b) => ({
      id: b.id,
      key: b.key,
      name: b.name,
      description: b.description,
      version: b.version,
      status: b.status,
      slot_count: b._count.slots,
      instance_count: b._count.instances,
      updated_at: b.updated_at,
    }));
  },

  async getBlueprint(id: number): Promise<FullBlueprint> {
    const bp = await db.blueprint.findUnique({ where: { id }, include: blueprintInclude });
    if (!bp) throw notFound();
    return bp;
  },

  validateBlueprint(id: number): Promise<string[]> {
    return collectProblems(id);
  },

  /** Validate an unsaved document — the builder's Validate button. Persists nothing. */
  validateDocument(doc: BlueprintDoc): Promise<string[]> {
    return collectDocumentProblems(doc);
  },

  // Idempotent by `key`: re-importing replaces the definition wholesale.
  //
  // The blueprint ROW is kept and only its children are replaced, even when live instances exist —
  // authoring a v2 over a deployed blueprint is the whole point of reconcile (F10.6), and
  // `BlueprintInstance.blueprint_id` is Restrict anyway, so delete-and-recreate could not work.
  // Instances keep their bindings and overrides and simply fall a version behind until the new
  // definition is published, which is what reconciles them.
  async importBlueprint(doc: BlueprintDoc): Promise<BlueprintRow> {
    if (!doc?.key || !doc.name) throw badRequest('key and name are required');
    if (!Array.isArray(doc.slots) || doc.slots.length === 0) {
      throw badRequest('at least one slot is required');
    }

    const existing = await db.blueprint.findUnique({
      where: { key: doc.key },
      include: {
        _count: { select: { instances: true } },
        // Phases are deleted and recreated below, and `current_phase_id` is SetNull — so an
        // instance would silently lose its place in the lifecycle. Capture the phase KEY now and
        // re-point after, which is also the only sane semantics: "still in commissioning".
        instances: {
          select: {
            id: true,
            current_phase_id: true,
            // Bindings hold a phase of their own now (F11) — each has its own place in a
            // lifecycle, and a re-import must not lose theirs either.
            bindings: { select: { id: true, current_phase_id: true } },
          },
        },
        profiles: { select: { key: true, phases: { select: { id: true, key: true } } } },
      },
    });

    // A phase is identified by (profile, key) now, so re-pointing carries both: two profiles may
    // declare the same phase key, and putting a binding back into the wrong one would be worse
    // than dropping it.
    const phaseRefByInstance = new Map<number, PhaseRef>();
    const phaseRefByBinding = new Map<number, PhaseRef>();
    if (existing) {
      const refById = new Map<number, PhaseRef>();
      for (const profile of existing.profiles) {
        for (const ph of profile.phases)
          refById.set(ph.id, { profile: profile.key, phase: ph.key });
      }
      for (const instance of existing.instances) {
        const ref =
          instance.current_phase_id !== null ? refById.get(instance.current_phase_id) : undefined;
        if (ref) phaseRefByInstance.set(instance.id, ref);
        for (const binding of instance.bindings) {
          const bref =
            binding.current_phase_id !== null ? refById.get(binding.current_phase_id) : undefined;
          if (bref) phaseRefByBinding.set(binding.id, bref);
        }
      }
    }

    // Resolve portable names → row ids up front so a bad reference fails before any write.
    const templateNames = [...new Set(doc.slots.map((s) => s.sealed_template))];
    const templates = await db.sealedTemplate.findMany({
      where: { name: { in: templateNames } },
      select: { id: true, name: true },
    });
    const templateByName = new Map(templates.map((t) => [t.name, t.id]));
    for (const name of templateNames) {
      if (!templateByName.has(name)) throw badRequest(`unknown sealed template "${name}"`);
    }

    const modelRefs = (doc.pipelines ?? []).flatMap((p) =>
      p.stages.filter((s) => s.ml_model).map((s) => s.ml_model!),
    );
    const modelIds = new Map<string, number>();
    for (const ref of modelRefs) {
      const key = `${ref.kind}/${ref.name}/${ref.version}`;
      if (modelIds.has(key)) continue;
      const model = await db.mlModel.findUnique({
        where: {
          kind_name_version: { kind: ref.kind, name: ref.name, version: ref.version },
        },
        select: { id: true },
      });
      if (!model) throw badRequest(`unknown ml model "${key}"`);
      modelIds.set(key, model.id);
    }

    // The version identifies what an instance was derived from, so it advances when a *published*
    // definition is replaced — not on every edit of a draft.
    const version = existing
      ? existing.status === 'published'
        ? existing.version + 1
        : existing.version
      : 1;
    const definition = buildBlueprintDefinition(doc, { templateByName, modelIds, version });

    return db.$transaction(async (tx) => {
      // Replace the children, keep the row. Every child collection cascades from `blueprint_id`,
      // so deleting the top four clears the whole definition without touching instances.
      if (existing) {
        await tx.blueprintSlot.deleteMany({ where: { blueprint_id: existing.id } });
        await tx.blueprintParam.deleteMany({ where: { blueprint_id: existing.id } });
        // Cascades to options. The user's *answers* live on the instance keyed by field key, so a
        // v2 that keeps a field keeps its answers (F11.6).
        await tx.blueprintField.deleteMany({ where: { blueprint_id: existing.id } });
        // Cascades to phases and their targets — blueprint_phases hangs off a profile now.
        await tx.blueprintProfile.deleteMany({ where: { blueprint_id: existing.id } });
        await tx.blueprintSceneTemplate.deleteMany({ where: { blueprint_id: existing.id } });
        await tx.blueprintRuleTemplate.deleteMany({ where: { blueprint_id: existing.id } });
        await tx.blueprintPipelineTemplate.deleteMany({ where: { blueprint_id: existing.id } });
      }

      const bp = existing
        ? await tx.blueprint.update({
            where: { id: existing.id },
            data: { ...definition, updated_at: new Date() },
          })
        : await tx.blueprint.create({ data: { key: doc.key, ...definition } });

      // Re-point every instance at the phase it was in, matched by key. A phase the v2 removed
      // leaves the instance with none — reported as such rather than silently jumped to phase 1,
      // because guessing where a running setup belongs is worse than saying "pick one".
      if (phaseRefByInstance.size > 0 || phaseRefByBinding.size > 0) {
        const newProfiles = await tx.blueprintProfile.findMany({
          where: { blueprint_id: bp.id },
          select: { key: true, phases: { select: { id: true, key: true } } },
        });
        // "::" cannot appear in either key (both are validated to [A-Za-z0-9_.]), so this pair
        // cannot collide with a differently-split pair.
        const refKey = (profile: string, phase: string): string => `${profile}::${phase}`;
        const idByRef = new Map<string, number>();
        for (const profile of newProfiles) {
          for (const ph of profile.phases) idByRef.set(refKey(profile.key, ph.key), ph.id);
        }
        const lookup = (ref: PhaseRef): number | null =>
          idByRef.get(refKey(ref.profile, ref.phase)) ?? null;

        for (const [bindingId, ref] of phaseRefByBinding) {
          await tx.blueprintSlotBinding.update({
            where: { id: bindingId },
            data: { current_phase_id: lookup(ref) },
          });
        }
        for (const [instanceId, ref] of phaseRefByInstance) {
          await tx.blueprintInstance.update({
            where: { id: instanceId },
            data: { current_phase_id: lookup(ref) },
          });
        }
      }

      return bp;
    });
  },

  // The gate. Validation runs against the persisted rows (not the import document) so a
  // blueprint edited by any path — import, future builder UI — is held to the same bar.
  async publishBlueprint(id: number): Promise<BlueprintRow> {
    const problems = await collectProblems(id);
    if (problems.length > 0) {
      throw Object.assign(new Error('Blueprint cannot be published'), {
        statusCode: 400,
        details: problems,
      });
    }
    // Publishing only flips the gate — the version was already settled when the definition was
    // written (see importBlueprint), so republishing is idempotent.
    const published = await db.blueprint.update({
      where: { id },
      data: { status: 'published', updated_at: new Date() },
    });

    // A blueprint is desired state, so publishing must reach the setups already derived from it
    // (F10.6). Deliberately after the status flip and non-fatal: the definition is published
    // either way, and reconcile is re-runnable per instance if this pass has trouble.
    try {
      const results = await blueprintsReconcileService.reconcileBlueprint(id);
      if (results.length > 0) {
        log.info({ blueprintId: id, instances: results.length }, 'published version reconciled');
      }
    } catch (err) {
      log.error({ err, blueprintId: id }, 'publish succeeded but reconcile pass failed');
    }
    return published;
  },

  async deleteBlueprint(id: number): Promise<void> {
    const bp = await db.blueprint.findUnique({
      where: { id },
      include: { _count: { select: { instances: true } } },
    });
    if (!bp) throw notFound();
    if (bp._count.instances > 0) {
      throw conflict(`blueprint has ${bp._count.instances} live instance(s)`);
    }
    await db.blueprint.delete({ where: { id } });
  },
};
