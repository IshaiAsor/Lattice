import { Channel } from 'amqplib';
import type { BlueprintPhaseAdvancePayload } from '@lattice/queue';
import { createLogger } from '@lattice/logger';
import { advanceSetupPhase, advanceBindingPhase } from '../services/phases.service';

const log = createLogger('automation-worker');

// A pipeline's model decided the current phase is complete (F11.x). ml-router publishes it; this is
// where it lands, because automation-worker is the single writer of phase columns. Exactly one
// owner moves: the pot named by `bindingId`, or the setup when it is null. The shared advance
// helpers re-check the lifecycle and idempotently no-op if the owner already moved on.
//
// The guard matters more here than on the rule path, not less. ml-router decides whether this
// pipeline may end the phase when it *builds the plan*; the model call, the stages and the queue
// hop all happen after that, so the phase has had far longer to move than a rule evaluation gives
// it. Re-checking on arrival is what stops a stale decision advancing the phase that replaced it.
export function phaseAdvanceConsumer(ch: Channel) {
  return async (payload: BlueprintPhaseAdvancePayload): Promise<void> => {
    const guard = { mode: 'pipeline', refKey: payload.refKey };
    const advanced =
      payload.bindingId != null
        ? await advanceBindingPhase(ch, payload.bindingId, payload.source, guard)
        : await advanceSetupPhase(ch, payload.instanceId, payload.source, guard);
    if (!advanced) {
      log.debug(
        { instanceId: payload.instanceId, bindingId: payload.bindingId, source: payload.source },
        'phase-advance request was a no-op (owner not running, no target, or already advanced)',
      );
    }
  };
}
