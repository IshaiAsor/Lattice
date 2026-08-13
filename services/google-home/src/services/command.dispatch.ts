import { Channel } from 'amqplib';
import { publish, RK } from '@lattice/queue';
import type { ActionDispatchPayload } from '@lattice/queue';
import { createLogger } from '@lattice/logger';
import { db } from '@lattice/prisma-client';

const log = createLogger('google-home:dispatch');

export async function dispatchAction(
  ch: Channel,
  userId: number,
  actionId: number,
  state: string,
): Promise<void> {
  log.info({ userId, actionId, state }, 'dispatchAction started');
  const action = await db.userDeviceAction.findUnique({
    where: { id: actionId },
    include: { user_device: { include: { device: true } } },
  });
  if (!action) {
    log.warn({ actionId }, 'action not found');
    return;
  }

  let firmwareVersion: string | undefined;
  try {
    // The device subscribes on the version it actually booted — after an OTA that is the version
    // it reported, not the catalog row it is still pointed at. Addressing the catalog row would
    // publish to a topic nothing subscribes to, and the EXECUTE would silently do nothing.
    firmwareVersion =
      action.user_device.current_firmware_version ?? action.user_device.device.version ?? undefined;
  } catch (err) {
    log.error({ userDeviceId: action.user_device_id, err }, 'could not resolve firmware version');
  }

  const payload: ActionDispatchPayload = {
    userId: String(userId),
    deviceId: String(action.user_device_id),
    actionName: action.mqtt_action_name,
    command: { value: state, duration: '*' },
    firmwareVersion,
    // A person, speaking to Assistant rather than pressing the dashboard — same kind, and the
    // label is what tells the two apart in the command history (F11.12).
    source: { kind: 'manual', label: 'Google Home' },
    actionId,
  };

  publish(ch, RK.ACTION_DISPATCH, payload);
  log.info(
    { userDeviceId: action.user_device_id, actionName: action.mqtt_action_name },
    'action.dispatch published',
  );
}
