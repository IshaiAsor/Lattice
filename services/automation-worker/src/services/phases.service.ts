import { Channel } from 'amqplib';
import { publish, RK } from '@lattice/queue';
import type { NotificationSendPayload } from '@lattice/queue';
import { createLogger } from '@lattice/logger';
import { isPhaseDue, secondsBetween } from '@lattice/params';
import { db } from '../db/client';
import { nextPhase } from './phases-logic';

const log = createLogger('automation-worker');

// Phase auto-advance (F10.4). A blueprint instance moves to its next phase once the current
// phase's duration has elapsed.
//
// The whole advance is the two phase columns plus the phases' time banks. Every `@phase.x`
// reference in the instance's rules, scenes and pipelines retunes at the next evaluation because
// those rows store the reference, not the value — no automation row is rewritten, so a user's
// edits and any pending reconcile cannot be clobbered by the clock.
//
// On the banks (F10.12) the cron takes a deliberately narrow line:
//   - it *reads* the current phase's bank, so a phase the user resumed 3 days in has 11 days left
//     rather than a fresh 14 — the countdown the instance page draws is the one that fires here;
//   - it *credits* the phase it leaves, so a later rollback has something to resume;
//   - it always **resets** the phase it enters. Spending a bank stays an explicit human act; the
//     clock alone must never resurrect time from an earlier visit, which would silently shorten a
//     phase the user never chose to shorten.
//
// Rides the existing 10s cron rather than adding a service: the query is one indexed read over
// instances that have an auto-advancing current phase, which is nothing at this scale.

export async function advanceDuePhases(ch: Channel): Promise<number> {
  try {
    const candidates = await db.blueprintInstance.findMany({
      // A parked setup has no `phase_started_at`, so isPhaseDue would refuse it anyway (F10.13) —
      // stating it in the query makes the intent legible and keeps stopped setups out of the scan.
      where: { lifecycle_state: 'running', current_phase: { auto_advance: true } },
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
        phase_state: { select: { phase_key: true, accrued_seconds: true } },
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
      const accrued =
        instance.phase_state.find((s) => s.phase_key === current.key)?.accrued_seconds ?? 0;
      const due = isPhaseDue({
        auto_advance: current.auto_advance,
        duration_value: current.duration_value,
        duration_unit: current.duration_unit,
        phase_started_at: instance.phase_started_at,
        accrued_seconds: accrued,
        hasNextPhase: next !== null,
      });
      log.debug(
        {
          instanceId: instance.id,
          phase: current.key,
          startedAt: instance.phase_started_at,
          accrued,
          duration: current.duration_value
            ? `${current.duration_value} ${current.duration_unit}`
            : null,
          next: next?.key ?? null,
          due,
        },
        'phase cron: evaluated',
      );
      if (!due || !next) continue;

      const now = new Date();
      const banked = instance.phase_started_at ? secondsBetween(instance.phase_started_at, now) : 0;
      await db.$transaction([
        // Credit the phase being left, so a rollback later has something to resume.
        db.blueprintInstancePhaseState.upsert({
          where: {
            instance_id_phase_key: { instance_id: instance.id, phase_key: current.key },
          },
          create: {
            instance_id: instance.id,
            phase_key: current.key,
            accrued_seconds: accrued + banked,
            last_exited_at: now,
          },
          update: { accrued_seconds: { increment: banked }, last_exited_at: now, updated_at: now },
        }),
        // The entered phase always starts from zero — see the note at the top of this file.
        db.blueprintInstancePhaseState.upsert({
          where: { instance_id_phase_key: { instance_id: instance.id, phase_key: next.key } },
          create: { instance_id: instance.id, phase_key: next.key, accrued_seconds: 0 },
          update: { accrued_seconds: 0, updated_at: now },
        }),
        db.blueprintInstance.update({
          where: { id: instance.id },
          data: { current_phase_id: next.id, phase_started_at: now, updated_at: now },
        }),
      ]);
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
