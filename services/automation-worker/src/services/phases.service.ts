import { Channel } from 'amqplib';
import { publish, RK } from '@lattice/queue';
import type { NotificationSendPayload } from '@lattice/queue';
import { createLogger } from '@lattice/logger';
import { db } from '../db/client';
import { isPhaseDue, nextPhase } from './phases-logic';

const log = createLogger('automation-worker');

// Phase auto-advance (F10.4). A blueprint instance moves to its next phase once the current
// phase's duration has elapsed.
//
// The whole advance is **one column write** (`current_phase_id`, plus a fresh `phase_started_at`).
// Every `@phase.x` reference in the instance's rules, scenes and pipelines retunes at the next
// evaluation because those rows store the reference, not the value — no automation row is
// rewritten, so a user's edits and any pending reconcile cannot be clobbered by the clock.
//
// Rides the existing 10s cron rather than adding a service: the query is one indexed read over
// instances that have an auto-advancing current phase, which is nothing at this scale.

export async function advanceDuePhases(ch: Channel): Promise<number> {
  try {
    const candidates = await db.blueprintInstance.findMany({
      where: { current_phase: { auto_advance: true } },
      select: {
        id: true,
        user_id: true,
        name: true,
        phase_started_at: true,
        current_phase: {
          select: {
            id: true,
            key: true,
            name: true,
            ordinal: true,
            auto_advance: true,
            duration_value: true,
            duration_unit: true,
          },
        },
        blueprint: {
          select: { phases: { select: { id: true, key: true, name: true, ordinal: true } } },
        },
        area: { select: { id: true, name: true } },
      },
    });

    if (candidates.length > 0) {
      log.debug(
        { candidates: candidates.length },
        'phase cron: instances on an auto-advancing phase',
      );
    }

    let advanced = 0;
    for (const instance of candidates) {
      const current = instance.current_phase;
      if (!current) continue;

      const next = nextPhase(instance.blueprint.phases, current.ordinal);
      const due = isPhaseDue({
        auto_advance: current.auto_advance,
        duration_value: current.duration_value,
        duration_unit: current.duration_unit,
        phase_started_at: instance.phase_started_at,
        hasNextPhase: next !== null,
      });
      log.debug(
        {
          instanceId: instance.id,
          phase: current.key,
          startedAt: instance.phase_started_at,
          duration: current.duration_value
            ? `${current.duration_value} ${current.duration_unit}`
            : null,
          next: next?.key ?? null,
          due,
        },
        'phase cron: evaluated',
      );
      if (!due || !next) continue;

      await db.blueprintInstance.update({
        where: { id: instance.id },
        data: { current_phase_id: next.id, phase_started_at: new Date(), updated_at: new Date() },
      });
      advanced++;

      log.info(
        { instanceId: instance.id, from: current.key, to: next.key },
        'blueprint phase auto-advanced',
      );
      notifyPhaseAdvanced(
        ch,
        instance.user_id,
        instance.name,
        current.name,
        next.name,
        instance.area,
      );
    }
    return advanced;
  } catch (err) {
    log.error({ err }, 'error advancing blueprint phases');
    return 0;
  }
}

// Best-effort, same contract as notifyRuleFired: a missing notification-service must not break
// the advance, which has already been committed.
function notifyPhaseAdvanced(
  ch: Channel,
  userId: number,
  instanceName: string,
  from: string,
  to: string,
  area: { id: number; name: string } | null,
): void {
  try {
    publish(ch, RK.NOTIFICATION_SEND, {
      userId: String(userId),
      eventType: 'blueprint_phase_advanced',
      data: { instanceName, fromPhase: from, toPhase: to },
      // Instance-scoped so two setups advancing in the same window don't suppress each other.
      dedupeKey: `blueprint-phase:${instanceName}:${to}`,
      ...(area ? { context: { area_id: area.id, area_name: area.name } } : {}),
    } satisfies NotificationSendPayload);
  } catch (err) {
    log.warn({ err, instanceName }, 'failed to publish phase-advanced notification — skipped');
  }
}
