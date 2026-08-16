import { publish, RK } from '@lattice/queue';
import type { ActionDispatchPayload } from '@lattice/queue';
import { db } from '../db';
import { getChannel } from '../queue';

// Device lifecycle command dispatch (restart / reprovision / soft-reset / hard-reset).
//
// Split out of device.mgmt.service so the config-reload debouncer can reuse it: user.actions
// and device.mgmt both need to ask a device to reload, and routing that through the service
// class would make config-reload.ts and device.mgmt.service.ts import each other.
//
// actionName is the mqtt_action_name the firmware listens for; these four all take no
// parameters, so the command body is empty.
export async function dispatchDeviceCommand(
  userId: number,
  deviceId: number,
  actionName: string,
): Promise<void> {
  const device = await db.userDevice.findUnique({
    where: { id: deviceId },
    select: {
      user_id: true,
      current_firmware_version: true,
      device: { select: { version: true } },
    },
  });
  if (!device) throw Object.assign(new Error('Device not found'), { statusCode: 404 });
  if (device.user_id !== userId) throw Object.assign(new Error('Forbidden'), { statusCode: 403 });

  const payload: ActionDispatchPayload = {
    userId: String(userId),
    deviceId: String(deviceId),
    actionName,
    command: '',
    // The command topic carries the firmware's version segment, and firmware builds it from
    // its own compile-time DEVICE_VERSION. After an OTA that is the version the device
    // reported, not the catalog row it is still pointed at — addressing the catalog row would
    // publish to a topic nothing subscribes to and the command would vanish silently.
    firmwareVersion: device.current_firmware_version ?? device.device.version,
    // A device-level command from the management UI — no UserDeviceAction behind it, so the
    // history row records the device and the verb (F11.12).
    source: { kind: 'manual', label: `device ${actionName}` },
  };
  const ch = await getChannel();
  publish(ch, RK.ACTION_DISPATCH, payload);
}
