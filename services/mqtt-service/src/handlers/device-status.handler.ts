import type { Channel } from 'amqplib';
import { publish, RK } from '@lattice/queue';
import type { DeviceStateChangedPayload } from '@lattice/queue';
import type { MqttHandler } from './handler.interface';
import { createLogger } from '@lattice/logger';

const log = createLogger('mqtt-service:device-status');

export function deviceStatusHandler(ch: Channel): MqttHandler {
  return {
    pattern: 'users/+/devices/+/+/status',
    handle: async ({ parsed, payload }) => {
      const state = payload.toString().trim() === 'online';
      const msg: DeviceStateChangedPayload = {
        userId: parsed.userId,
        deviceId: parsed.deviceId,
        actionName: 'status',
        state,
        timestamp: new Date().toISOString(),
        version: parsed.version,
        // The broker delivered this one, Last-Will included — as opposed to the liveness reaper
        // inferring it. The device timeline records the difference (F18.1).
        source: 'broker',
      };
      publish(ch, RK.DEVICE_STATE_CHANGED, msg);
      log.info({ topic: parsed, msg }, 'device status received and forwarded');
    },
  };
}
