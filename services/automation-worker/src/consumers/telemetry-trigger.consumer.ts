import type { Channel } from 'amqplib';
import type { TelemetryArrivedPayload } from '@lattice/queue';
import { matchPipelineTriggers } from '../services/pipeline-triggers';

// Second consumer of telemetry.arrived (digest-service is the first, for authoritative state).
// This one owns pipeline sensor_threshold matching — the pipeline sibling of rules evaluation.
export function telemetryTriggerConsumer(ch: Channel) {
  return async (payload: TelemetryArrivedPayload): Promise<void> => {
    await matchPipelineTriggers(ch, payload);
  };
}
