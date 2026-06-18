import type { Channel } from 'amqplib';
import { publish, RK } from '@lattice/queue';
import type { TelemetryArrivedPayload } from '@lattice/queue';
import type { MqttHandler } from './handler.interface';
import { createLogger } from '@lattice/logger';

const log = createLogger('mqtt-service:device-telemetry');

function tryParseJson(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

export function deviceTelemetryHandler(ch: Channel): MqttHandler {
  return {
    pattern: 'users/+/devices/+/+/telemetry/#',
    handle: async ({ parsed, payload }) => {
      const msg: TelemetryArrivedPayload = {
        userId:     parsed.userId,
        deviceId:   parsed.deviceId,
        actionName: parsed.actionName ?? '',
        value:      tryParseJson(payload.toString()),
        timestamp:  new Date().toISOString(),
      };
      publish(ch, RK.TELEMETRY_ARRIVED, msg);
      log.debug({ topic: parsed, msg }, 'telemetry received and forwarded');
    },
  };
}
