import { db, Prisma } from '../db';
import { publish, RK } from '@lattice/queue';
import type { NotificationSendPayload } from '@lattice/queue';
import { getChannel } from '../queue';
import { createLogger } from '@lattice/logger';
import { buildSlotActionResolver } from './blueprints.addressing';
import {
  reconcileSceneTemplate,
  reconcileRuleTemplate,
  reconcilePipelineTemplate,
  type ReconcileChange,
  type DiffContext,
} from './blueprints.reconcile.diff';

export type { ReconcileChange } from './blueprints.reconcile.diff';

const log = createLogger('api:blueprints-reconcile');

// Reconcile (F10.6) — flow a new blueprint version into the instances already derived from it.
//
// A blueprint is *desired state*, not a one-time stamp. Publishing v2 should reach live setups,
// but a user who tuned a derived rule must not lose that. The three rules that make both true:
//
//   1. Match by `blueprint_key`, never by row id. The key is the reconcile identity — it survives
//      a template being rewritten, and it is how "this rule came from that template" is known.
//   2. Skip anything `user_modified`. That flag is set by the ordinary update paths, so an edited
//      entity is left exactly as the user left it and reported as drift instead.
//   3. Never delete. An entity dropped from the template is *disabled* (scenes, which have no
//      enabled column, are left alone and simply reported) — a user may still want it, and
//      deleting would take their edits with it.
//
// What reconcile does NOT touch: `blueprint_param_overrides`. Structure is the blueprint's to
// own; values are the user's. Keeping those in disjoint tables is what lets a v2 release be
// non-destructive by construction rather than by careful diffing.

function notFound(message = 'Setup not found'): Error {
  return Object.assign(new Error(message), { statusCode: 404 });
}

const instanceInclude = {
  bindings: true,
  blueprint: {
    include: {
      scenes: { include: { members: { orderBy: { sort_order: 'asc' } } } },
      rules: { include: { conditions: true, actions: true } },
      pipelines: {
        include: { sensors: true, stages: { orderBy: { ordinal: 'asc' } }, triggers: true },
      },
    },
  },
  scenes: true,
  rules: true,
  pipelines: true,
} satisfies Prisma.BlueprintInstanceInclude;

export interface ReconcileResult {
  instance_id: number;
  name: string;
  from_version: number;
  to_version: number;
  changes: ReconcileChange[];
}

export interface DriftEntity {
  kind: 'scene' | 'rule' | 'pipeline';
  id: number;
  name: string;
  blueprint_key: string | null;
  /** True when the user edited the entity itself; reconcile skips it until reset. */
  user_modified: boolean;
}

export interface DriftReport {
  instance_id: number;
  entities: DriftEntity[];
  /** Params the user has pinned. Not "wrong" — just no longer following the blueprint/phase. */
  overridden_params: { param_key: string; value: string }[];
  blueprint_version_behind: boolean;
}

class BlueprintsReconcileService {
  /**
   * Bring one instance up to its blueprint's current definition.
   *
   * Idempotent: running it twice changes nothing the second time, because every decision is a
   * comparison against the template rather than a replay of a delta.
   */
  async reconcileInstance(instanceId: number): Promise<ReconcileResult> {
    const instance = await db.blueprintInstance.findUnique({
      where: { id: instanceId },
      include: instanceInclude,
    });
    if (!instance) throw notFound();

    const bp = instance.blueprint;
    // Re-resolve slot actions each pass: a v2 template may reference actions the first derive never
    // touched, or the user may have added/removed a device in a multi-device slot.
    const resolver = await buildSlotActionResolver(instance.bindings);
    const changes: ReconcileChange[] = [];

    log.debug(
      {
        instanceId: instance.id,
        instance: instance.name,
        fromVersion: instance.blueprint_version,
        toVersion: bp.version,
        templates: {
          scenes: bp.scenes.map((x) => x.key),
          rules: bp.rules.map((x) => x.key),
          pipelines: bp.pipelines.map((x) => x.key),
        },
        derived: {
          scenes: instance.scenes.map((x) => `${x.blueprint_key}${x.user_modified ? '*' : ''}`),
          rules: instance.rules.map((x) => `${x.blueprint_key}${x.user_modified ? '*' : ''}`),
          pipelines: instance.pipelines.map(
            (x) => `${x.blueprint_key}${x.user_modified ? '*' : ''}`,
          ),
        },
      },
      'reconcile: starting (* = user_modified, will be skipped)',
    );

    // Fan a (slot, action) reference out to the action id on every device bound to the slot.
    // Returns null when the reference is not fully resolvable — the slot is unbound, or its action
    // is missing on at least one bound device — in which case the whole entity is left as-is and
    // reported, never written half-wired.
    const resolveAll = (slotKey: string, actionName: string): number[] | null => {
      const n = resolver.deviceCount(slotKey);
      const ids = resolver.actionIds(slotKey, actionName);
      return n > 0 && ids.length === n ? ids : null;
    };

    // Per-entity diff lives in blueprints.reconcile.diff; each call reconciles one template
    // against its derived counterpart (matched by blueprint_key) and returns what it did.
    const diffCtx: DiffContext = {
      userId: instance.user_id,
      areaId: instance.area_id,
      instanceId: instance.id,
      instanceName: instance.name,
      resolveAll,
    };

    // ─── Scenes ──────────────────────────────────────────────────────────────
    for (const template of bp.scenes) {
      const existing = instance.scenes.find((s) => s.blueprint_key === template.key);
      changes.push(await reconcileSceneTemplate(template, existing, diffCtx));
    }

    // ─── Rules ───────────────────────────────────────────────────────────────
    for (const template of bp.rules) {
      const existing = instance.rules.find((r) => r.blueprint_key === template.key);
      changes.push(await reconcileRuleTemplate(template, existing, diffCtx));
    }

    // ─── Pipelines ───────────────────────────────────────────────────────────
    for (const template of bp.pipelines) {
      const existing = instance.pipelines.find((p) => p.blueprint_key === template.key);
      changes.push(await reconcilePipelineTemplate(template, existing, diffCtx));
    }

    // ─── Removed from the template — disable, never delete ───────────────────
    const liveKeys = {
      scene: new Set(bp.scenes.map((s) => s.key)),
      rule: new Set(bp.rules.map((r) => r.key)),
      pipeline: new Set(bp.pipelines.map((p) => p.key)),
    };
    for (const rule of instance.rules) {
      if (rule.blueprint_key && !liveKeys.rule.has(rule.blueprint_key) && rule.enabled) {
        await db.userRule.update({
          where: { id: rule.id },
          data: { enabled: false, updated_at: new Date() },
        });
        changes.push({
          kind: 'rule',
          blueprint_key: rule.blueprint_key,
          name: rule.name,
          action: 'disabled',
          detail: 'no longer part of the blueprint',
        });
      }
    }
    for (const pipeline of instance.pipelines) {
      if (
        pipeline.blueprint_key &&
        !liveKeys.pipeline.has(pipeline.blueprint_key) &&
        pipeline.enabled
      ) {
        await db.pipeline.update({
          where: { id: pipeline.id },
          data: { enabled: false, updated_at: new Date() },
        });
        changes.push({
          kind: 'pipeline',
          blueprint_key: pipeline.blueprint_key,
          name: pipeline.name,
          action: 'disabled',
          detail: 'no longer part of the blueprint',
        });
      }
    }
    // Scenes have no `enabled` column — a scene only ever runs when a user presses it, so an
    // orphaned one is harmless. Reported, not touched.
    for (const scene of instance.scenes) {
      if (scene.blueprint_key && !liveKeys.scene.has(scene.blueprint_key)) {
        changes.push({
          kind: 'scene',
          blueprint_key: scene.blueprint_key,
          name: scene.name,
          action: 'disabled',
          detail: 'no longer part of the blueprint; kept because a scene only runs on demand',
        });
      }
    }

    for (const change of changes) {
      log.debug(
        { instanceId: instance.id, ...change },
        `reconcile: ${change.kind} "${change.blueprint_key}" → ${change.action}`,
      );
    }

    const fromVersion = instance.blueprint_version;
    await db.blueprintInstance.update({
      where: { id: instance.id },
      data: { blueprint_version: bp.version, updated_at: new Date() },
    });

    log.info(
      { instanceId: instance.id, from: fromVersion, to: bp.version, changes: changes.length },
      'blueprint instance reconciled',
    );

    return {
      instance_id: instance.id,
      name: instance.name,
      from_version: fromVersion,
      to_version: bp.version,
      changes,
    };
  }

  /**
   * Reconcile every instance of a blueprint — what a publish triggers.
   *
   * Failures are per-instance: one user's unresolvable binding must not stop another user's
   * setup from receiving the new version.
   */
  async reconcileBlueprint(blueprintId: number): Promise<ReconcileResult[]> {
    log.debug({ blueprintId }, 'reconcile: sweeping every instance of this blueprint');
    const instances = await db.blueprintInstance.findMany({
      where: { blueprint_id: blueprintId },
      select: { id: true, user_id: true, area: { select: { id: true, name: true } } },
    });
    const results: ReconcileResult[] = [];
    for (const { id, user_id, area } of instances) {
      try {
        const result = await this.reconcileInstance(id);
        results.push(result);
        this.notifyReconciled(user_id, result, area);
        log.debug(
          {
            instanceId: id,
            userId: user_id,
            applied: result.changes.filter((c) => c.action !== 'skipped_user_modified').length,
            skipped: result.changes.filter((c) => c.action === 'skipped_user_modified').length,
          },
          'reconcile: instance done',
        );
      } catch (err) {
        log.error({ err, instanceId: id }, 'failed to reconcile instance — others continue');
      }
    }
    return results;
  }

  /** What the instance page shows: which entities have diverged, and which params are pinned. */
  async driftReport(userId: number, instanceId: number): Promise<DriftReport> {
    const instance = await db.blueprintInstance.findUnique({
      where: { id: instanceId },
      select: {
        user_id: true,
        blueprint_version: true,
        blueprint: { select: { version: true } },
        overrides: { select: { param_key: true, value: true } },
        scenes: { select: { id: true, name: true, blueprint_key: true, user_modified: true } },
        rules: { select: { id: true, name: true, blueprint_key: true, user_modified: true } },
        pipelines: { select: { id: true, name: true, blueprint_key: true, user_modified: true } },
      },
    });
    if (!instance) throw notFound();
    if (instance.user_id !== userId) {
      throw Object.assign(new Error('Forbidden'), { statusCode: 403 });
    }

    const entities: DriftEntity[] = [
      ...instance.scenes.map((s) => ({ kind: 'scene' as const, ...s })),
      ...instance.rules.map((r) => ({ kind: 'rule' as const, ...r })),
      ...instance.pipelines.map((p) => ({ kind: 'pipeline' as const, ...p })),
    ].filter((e) => e.user_modified);

    return {
      instance_id: instanceId,
      entities,
      overridden_params: instance.overrides,
      blueprint_version_behind: instance.blueprint.version > instance.blueprint_version,
    };
  }

  /**
   * Give one edited entity back to the blueprint: clear the flag, then reconcile the instance so
   * the entity is rewritten from its template. Clearing without reconciling would leave the user's
   * edit in place but no longer flagged — the one state that is genuinely wrong.
   */
  async resetEntity(
    userId: number,
    instanceId: number,
    kind: DriftEntity['kind'],
    entityId: number,
  ): Promise<ReconcileResult> {
    const instance = await db.blueprintInstance.findUnique({
      where: { id: instanceId },
      select: { user_id: true },
    });
    if (!instance) throw notFound();
    if (instance.user_id !== userId) {
      throw Object.assign(new Error('Forbidden'), { statusCode: 403 });
    }

    const where = { id: entityId, blueprint_instance_id: instanceId };
    const data = { user_modified: false, updated_at: new Date() };
    const cleared =
      kind === 'scene'
        ? await db.scene.updateMany({ where, data })
        : kind === 'rule'
          ? await db.userRule.updateMany({ where, data })
          : await db.pipeline.updateMany({ where, data });
    if (cleared.count === 0) throw notFound(`${kind} ${entityId} is not part of this setup`);
    log.info(
      { instanceId, kind, entityId, userId },
      'reset: user_modified cleared — the entity will be rewritten from its template',
    );

    return this.reconcileInstance(instanceId);
  }

  // Best-effort: the reconcile is already committed, so a queue hiccup must not fail it.
  private notifyReconciled(
    userId: number,
    result: ReconcileResult,
    area: { id: number; name: string } | null,
  ): void {
    const applied = result.changes.filter(
      (c) => c.action === 'created' || c.action === 'updated' || c.action === 'disabled',
    ).length;
    const skipped = result.changes.filter((c) => c.action === 'skipped_user_modified').length;
    if (applied === 0 && skipped === 0) return;
    void (async () => {
      try {
        publish(await getChannel(), RK.NOTIFICATION_SEND, {
          userId: String(userId),
          eventType: 'blueprint_updated',
          data: {
            instanceName: result.name,
            version: result.to_version,
            applied,
            skipped,
          },
          dedupeKey: `blueprint-reconcile:${result.instance_id}:${result.to_version}`,
          ...(area ? { context: { area_id: area.id, area_name: area.name } } : {}),
        } satisfies NotificationSendPayload);
      } catch (err) {
        log.warn({ err, instanceId: result.instance_id }, 'reconcile notification skipped');
      }
    })();
  }
}

export const blueprintsReconcileService = new BlueprintsReconcileService();
