import type { Channel } from 'amqplib';
import { publish, RK } from '@lattice/queue';
import type { DeviceStateChangedPayload } from '@lattice/queue';
import type { MqttHandler } from './handler.interface';

export function deviceStatusHandler(ch: Channel): MqttHandler {
  return {
    pattern: 'users/+/devices/+/+/status',
    handle: async ({ parsed, payload }) => {
      const state = payload.toString().trim() === 'online';
      const msg: DeviceStateChangedPayload = {
        userId:     parsed.userId,
        deviceId:   parsed.deviceId,
        actionName: 'status',
        state,
        timestamp:  new Date().toISOString(),
      };
      publish(ch, RK.DEVICE_STATE_CHANGED, msg);
    },
  };
}
