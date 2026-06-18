import type { Channel } from 'amqplib';
import { publish, RK } from '@lattice/queue';
import type { ActionResultPayload } from '@lattice/queue';
import { createLogger } from '@lattice/logger';
import type { MqttHandler } from './handler.interface';

const log = createLogger('mqtt-service:device-ack');

interface RawAck {
  commandId?: unknown;
  status?: unknown;
  value?: unknown;
}

// A device's command acknowledgement on .../ack/{actionName}. The body is
// { commandId?, status: "ok"|"error", value? }. We forward it to digest as
// ACTION_RESULT; digest writes the authoritative state (on ok) and resolves the
// in-flight request. A malformed body is dropped (no requeue) — there is nothing to
// retry, and we must not treat a bad ack as a successful execution.
export function deviceAckHandler(ch: Channel): MqttHandler {
  return {
    pattern: 'users/+/devices/+/+/ack/#',
    handle: async ({ parsed, payload }) => {
      let raw: RawAck;
      try {
        raw = JSON.parse(payload.toString()) as RawAck;
      } catch {
        log.warn({ topic: parsed }, 'unparseable ack body — dropping');
        return;
      }

      const status = raw.status === 'error' ? 'error' : raw.status === 'ok' ? 'ok' : null;
      if (status === null) {
        log.warn({ status: raw.status }, 'ack with unknown status — dropping');
        return;
      }

      const msg: ActionResultPayload = {
        userId:     parsed.userId,
        deviceId:   parsed.deviceId,
        actionName: parsed.actionName ?? '',
        commandId:  typeof raw.commandId === 'string' && raw.commandId.length > 0 ? raw.commandId : undefined,
        status,
        value:      raw.value,
        timestamp:  new Date().toISOString(),
      };
      publish(ch, RK.ACTION_RESULT, msg);
      log.trace({ topic: parsed, msg }, 'ack received and forwarded as action.result');
    },
  };
}
