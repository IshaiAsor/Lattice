import { Channel } from 'amqplib';
import { publish, RK } from '@lattice/queue';
import type { ActionDispatchPayload } from '@lattice/queue';
import { createLogger } from '@lattice/logger';
import { userDevicesActionsRepository } from '../dal/user.devices.actions.repository';
import { userDevicesRepository } from '../dal/user.devices.repository';

const log = createLogger('google-home:dispatch');

export async function dispatchAction(
  ch: Channel,
  userId: number,
  actionId: number,
  state: string,
): Promise<void> {
  const action = await userDevicesActionsRepository.getById(actionId);
  if (!action) {
    log.warn({ actionId }, 'action not found');
    return;
  }

  let firmwareVersion: string | undefined;
  try {
    const userDevice = await userDevicesRepository.getById(action.user_device_id);
    firmwareVersion = userDevice.device.version ?? undefined;
  } catch (err) {
    log.error({ userDeviceId: action.user_device_id, err }, 'could not resolve firmware version');
  }

  const payload: ActionDispatchPayload = {
    userId:   String(userId),
    deviceId: String(action.user_device_id),
    actionName: action.mqtt_action_name,
    command: { value: state, duration: '*' },
    firmwareVersion,
  };

  publish(ch, RK.ACTION_DISPATCH, payload);
  log.info({ userDeviceId: action.user_device_id, actionName: action.mqtt_action_name }, 'action.dispatch published');
}
