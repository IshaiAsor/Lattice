import { createLogger } from '@lattice/logger';
import { db } from './db/client';
import { socket } from './socket/emitter';

const log = createLogger('digest-service:ota-confirm');

/**
 * Settle a pending OTA against the version a device reports it is actually running.
 *
 * A device proves an update landed by talking to us from the new version's topic path — its
 * status publish on reconnect, or any ack. Both are the same evidence, so both funnel here
 * rather than only the status path: an OTA that is confirmed by exactly one message is an
 * OTA that a lost or out-of-order message strands forever (see `rejected:not-newer` in
 * action-result.consumer).
 *
 * Confirming flips the staged action set live and repoints the device at the new catalog
 * row. That repoint is what keeps the device addressable: every command dispatcher builds
 * its MQTT topic from `devices.version`, so a device left on the old catalog row is
 * published at on a topic it no longer subscribes to — online, heartbeating, and deaf.
 *
 * Idempotent and safe to call on every status/ack: it is a no-op unless there is a pending
 * OTA whose version matches what the device reports.
 */
export async function confirmOtaIfPending(
  userDeviceId: number,
  reportedVersion: string,
): Promise<boolean> {
  const userDevice = await db.userDevice.findUnique({
    where: { id: userDeviceId },
    select: { pending_firmware_version: true, pending_device_type_id: true, user_id: true },
  });

  if (
    userDevice == null ||
    userDevice.pending_firmware_version !== reportedVersion ||
    userDevice.pending_device_type_id == null
  ) {
    return false;
  }

  const pendingDeviceTypeId = userDevice.pending_device_type_id;

  // An action carried across a firmware version is the SAME action, so it must keep its row id.
  // Promoting the staged row and retiring the old one instead minted a new id for every channel
  // on every update, which (a) left a full set of dead duplicate cards behind and (b) silently
  // broke every reference to the old id — scenes, rules, pipeline sensors — because those point
  // at an action row, not at a device+name. `mqtt_action_name` is the stable address across
  // versions (it is what the device itself routes on), so it is the key we re-identify by.
  const staged = await db.userDeviceAction.findMany({
    where: { user_device_id: userDeviceId, status: 'staged_active' },
    include: { pins: true, configurations: true },
  });
  // Both migration paths are covered: the sealed upgrade parks the outgoing rows as
  // staged_deprecated, while the per-action path leaves a compatible one 'active'.
  const existing = await db.userDeviceAction.findMany({
    where: {
      user_device_id: userDeviceId,
      status: { in: ['active', 'staged_deprecated'] },
    },
    select: { id: true, mqtt_action_name: true },
    orderBy: { id: 'asc' },
  });
  const survivorByName = new Map<string, number>();
  for (const a of existing) {
    if (!survivorByName.has(a.mqtt_action_name)) survivorByName.set(a.mqtt_action_name, a.id);
  }

  await db.$transaction(async (tx) => {
    for (const s of staged) {
      const survivorId = survivorByName.get(s.mqtt_action_name);
      if (survivorId == null) {
        // Genuinely new in this version — nothing to carry, so the staged row becomes the action.
        await tx.userDeviceAction.update({ where: { id: s.id }, data: { status: 'active' } });
        continue;
      }

      // Move the version-specific wiring onto the surviving row. Its capability, pins and
      // behaviors belong to the new catalog version; its name and grouping belong to the user,
      // so those are left alone rather than being reset from the template on every update.
      await tx.userDeviceActionPin.deleteMany({ where: { user_device_action_id: survivorId } });
      await tx.userActionConfiguration.deleteMany({
        where: { user_device_action_id: survivorId },
      });
      await tx.userDeviceAction.update({
        where: { id: survivorId },
        data: {
          status: 'active',
          capability_id: s.capability_id,
          default_trait_id: s.default_trait_id,
          sort_order: s.sort_order,
          telemetry_interval_ms: s.telemetry_interval_ms,
          camera_resolution: s.camera_resolution,
          camera_transport: s.camera_transport,
          pins: {
            create: s.pins.map((p) => ({
              capability_pin_id: p.capability_pin_id,
              pin_number: p.pin_number,
            })),
          },
          configurations: {
            create: s.configurations.map((c) => ({
              capability_configuration_id: c.capability_configuration_id,
              behavior: c.behavior,
              interval_ms: c.interval_ms,
              camera_resolution: c.camera_resolution,
              camera_transport: c.camera_transport,
            })),
          },
        },
      });
      survivorByName.delete(s.mqtt_action_name);
      await tx.userDeviceAction.delete({ where: { id: s.id } });
    }

    // Whatever is still parked has no counterpart in the new version — the capability really is
    // gone, which is the one case where deprecating a row is the right answer.
    await tx.userDeviceAction.updateMany({
      where: { user_device_id: userDeviceId, status: 'staged_deprecated' },
      data: { status: 'deprecated' },
    });

    await tx.userDevice.update({
      where: { id: userDeviceId },
      data: {
        current_firmware_version: reportedVersion,
        device_type_id: pendingDeviceTypeId,
        pending_firmware_version: null,
        pending_device_type_id: null,
        pending_since: null,
      },
    });
  });

  // Best-effort: the OTA is settled either way, and the page recovers on its next load.
  try {
    socket.emitDeviceUpdateState(userDevice.user_id, userDeviceId, 'confirmed', reportedVersion);
  } catch (err) {
    log.warn({ err, userDeviceId }, 'OTA confirm socket emit failed');
  }

  log.info(
    { userDeviceId, version: reportedVersion, carried: staged.length },
    'OTA confirmed — actions carried to the new version, firmware version updated',
  );
  return true;
}
