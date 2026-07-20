import { db } from '../db';
import { publish, consume, RK, QUEUES } from '@lattice/queue';
import type { ActionDispatchPayload, SealedTemplateAppliedPayload } from '@lattice/queue';
import { getChannel } from '../queue';
import { versionInRange } from '@lattice/capability-validation';
import { createLogger } from '@lattice/logger';

const log = createLogger('device-gateway:sealed');

// Sealed devices are factory-soldered: their config is composed by an admin as a SealedTemplate
// (which catalog capabilities to activate, the fixed GPIO per pin slot, which behaviors), not
// chosen per-user. This service turns that template into the same user_device_actions a regular
// device gets from the device-config page — so config pull, Google Home, rules and OTA all work
// unchanged downstream. It runs on provision (bind) and when an admin releases/changes a template.

// The released template covering a sealed device's (type, version), or null. Overlapping released
// targets are rejected at release time, so at most one matches; we take the first defensively.
export async function resolveTemplateForDevice(type: string, version: string) {
  const targets = await db.sealedTemplateTarget.findMany({
    where: { device_type: type, template: { status: 'released' } },
    include: {
      template: { include: { entries: { include: { pins: true, behaviors: true } } } },
    },
  });
  const match = targets.find((t) => versionInRange(version, t.version_min, t.version_max));
  return match?.template ?? null;
}

// Idempotently make a sealed device's active actions equal its template. Upserts by
// mqtt_action_name (stable), replaces pins/behaviors, and deprecates actions no longer in the
// template (non-destructive — config pull ignores non-active, and rule bindings survive).
export async function materializeForUserDevice(userDeviceId: number): Promise<boolean> {
  const userDevice = await db.userDevice.findUnique({
    where: { id: userDeviceId },
    include: { device: true },
  });
  if (!userDevice || !userDevice.device.is_sealed) return false;

  const template = await resolveTemplateForDevice(
    userDevice.device.type,
    userDevice.device.version,
  );
  if (!template) {
    log.info(
      { userDeviceId, type: userDevice.device.type, version: userDevice.device.version },
      'sealed device has no released template yet — no actions materialized',
    );
    return false;
  }

  // The device's own version catalog: resolves capability_key → capability, pin_slot_key → pin id,
  // behavior → configuration id, and the default trait value → GoogleDeviceTrait id.
  const capabilities = await db.deviceCapability.findMany({
    where: { device_id: userDevice.device_type_id },
    include: { pins: true, configurations: true },
  });
  const capByKey = new Map(capabilities.map((c) => [c.capability_key, c]));

  const materializedMqttNames: string[] = [];

  await db.$transaction(async (tx) => {
    for (const entry of template.entries) {
      const cap = capByKey.get(entry.capability_key);
      if (!cap) {
        log.warn(
          {
            userDeviceId,
            capability_key: entry.capability_key,
            version: userDevice.device.version,
          },
          'template capability not in this version catalog — skipped',
        );
        continue;
      }
      // Per-instance name (base or <base>_N) — NOT cap.mqtt_action_name, which is shared across
      // instances of the same capability and would collapse them onto one action.
      const mqttName = entry.mqtt_action_name;
      materializedMqttNames.push(mqttName);

      const defaultTraitId = entry.default_trait_value
        ? ((await tx.googleDeviceTrait.findUnique({ where: { value: entry.default_trait_value } }))
            ?.id ?? null)
        : null;

      const pinIdByKey = new Map(cap.pins.map((p) => [p.key, p.id]));
      const configIdByBehavior = new Map(cap.configurations.map((c) => [c.behavior, c.id]));

      const pinData = entry.pins
        .filter((p) => pinIdByKey.has(p.pin_slot_key))
        .map((p) => ({
          capability_pin_id: pinIdByKey.get(p.pin_slot_key)!,
          pin_number: p.pin_number,
        }));

      const behaviorData = entry.behaviors
        .filter((b) => configIdByBehavior.has(b.behavior))
        .map((b) => ({
          capability_configuration_id: configIdByBehavior.get(b.behavior)!,
          behavior: b.behavior,
          interval_ms: b.interval_ms ?? null,
          camera_resolution: b.camera_resolution ?? null,
          camera_transport: b.camera_transport ?? null,
        }));

      const existing = await tx.userDeviceAction.findFirst({
        where: { user_device_id: userDeviceId, mqtt_action_name: mqttName },
        select: { id: true },
      });

      if (existing) {
        await tx.userDeviceAction.update({
          where: { id: existing.id },
          data: {
            capability_id: cap.id,
            action_name: entry.action_label,
            default_trait_id: defaultTraitId,
            status: 'active',
            sort_order: entry.sort_order,
            updated_at: new Date(),
          },
        });
        await tx.userDeviceActionPin.deleteMany({ where: { user_device_action_id: existing.id } });
        await tx.userActionConfiguration.deleteMany({
          where: { user_device_action_id: existing.id },
        });
        if (pinData.length) {
          await tx.userDeviceActionPin.createMany({
            data: pinData.map((p) => ({ ...p, user_device_action_id: existing.id })),
          });
        }
        if (behaviorData.length) {
          await tx.userActionConfiguration.createMany({
            data: behaviorData.map((b) => ({ ...b, user_device_action_id: existing.id })),
          });
        }
      } else {
        await tx.userDeviceAction.create({
          data: {
            user_device_id: userDeviceId,
            capability_id: cap.id,
            action_name: entry.action_label,
            mqtt_action_name: mqttName,
            default_trait_id: defaultTraitId,
            status: 'active',
            sort_order: entry.sort_order,
            pins: { create: pinData },
            configurations: { create: behaviorData },
          },
        });
      }
    }

    // Deprecate any active action no longer in the template (non-destructive: config pull only
    // serves `active`, and rule bindings survive since we don't delete).
    await tx.userDeviceAction.updateMany({
      where: {
        user_device_id: userDeviceId,
        status: 'active',
        mqtt_action_name: { notIn: materializedMqttNames.length ? materializedMqttNames : ['\0'] },
      },
      data: { status: 'deprecated' },
    });
  });

  log.info(
    { userDeviceId, template: template.name, actions: materializedMqttNames.length },
    'sealed device materialized from template',
  );
  return true;
}

// Firmware version-update path for sealed devices: stage the TARGET version's template as
// staged_active (current actions → staged_deprecated) so the shared OTA-confirm flow
// (digest-service device-status consumer) promotes them once the device boots the new firmware.
// Returns false if the target version has no released template (caller skips staging).
export async function stageSealedUpgrade(
  userDeviceId: number,
  target: { id: number; type: string; version: string },
): Promise<boolean> {
  const template = await resolveTemplateForDevice(target.type, target.version);
  if (!template) {
    log.warn(
      { userDeviceId, target },
      'sealed upgrade target has no released template — not staged',
    );
    return false;
  }
  const capabilities = await db.deviceCapability.findMany({
    where: { device_id: target.id },
    include: { pins: true, configurations: true },
  });
  const capByKey = new Map(capabilities.map((c) => [c.capability_key, c]));

  await db.$transaction(async (tx) => {
    // Reset any prior in-flight staging, then stage current live actions for deprecation.
    await tx.userDeviceAction.deleteMany({
      where: { user_device_id: userDeviceId, status: 'staged_active' },
    });
    await tx.userDeviceAction.updateMany({
      where: { user_device_id: userDeviceId, status: 'staged_deprecated' },
      data: { status: 'active' },
    });
    await tx.userDeviceAction.updateMany({
      where: { user_device_id: userDeviceId, status: 'active' },
      data: { status: 'staged_deprecated' },
    });

    for (const entry of template.entries) {
      const cap = capByKey.get(entry.capability_key);
      if (!cap) continue;
      const defaultTraitId = entry.default_trait_value
        ? ((await tx.googleDeviceTrait.findUnique({ where: { value: entry.default_trait_value } }))
            ?.id ?? null)
        : null;
      const pinIdByKey = new Map(cap.pins.map((p) => [p.key, p.id]));
      const configIdByBehavior = new Map(cap.configurations.map((c) => [c.behavior, c.id]));
      await tx.userDeviceAction.create({
        data: {
          user_device_id: userDeviceId,
          capability_id: cap.id,
          action_name: entry.action_label,
          mqtt_action_name: entry.mqtt_action_name,
          default_trait_id: defaultTraitId,
          status: 'staged_active',
          sort_order: entry.sort_order,
          pins: {
            create: entry.pins
              .filter((p) => pinIdByKey.has(p.pin_slot_key))
              .map((p) => ({
                capability_pin_id: pinIdByKey.get(p.pin_slot_key)!,
                pin_number: p.pin_number,
              })),
          },
          configurations: {
            create: entry.behaviors
              .filter((b) => configIdByBehavior.has(b.behavior))
              .map((b) => ({
                capability_configuration_id: configIdByBehavior.get(b.behavior)!,
                behavior: b.behavior,
                interval_ms: b.interval_ms ?? null,
                camera_resolution: b.camera_resolution ?? null,
                camera_transport: b.camera_transport ?? null,
              })),
          },
        },
      });
    }
  });
  log.info(
    { userDeviceId, target: target.version, template: template.name },
    'sealed upgrade staged',
  );
  return true;
}

// Re-apply a template to every already-provisioned device it matches, then push a config reload
// (restart command) so live devices pick up the new actions — the "apply migration" for
// sealed devices. Invoked by the SEALED_TEMPLATE_APPLIED consumer.
export async function reMaterializeMatchingDevices(templateId: number): Promise<number> {
  const template = await db.sealedTemplate.findUnique({
    where: { id: templateId },
    include: { targets: true },
  });
  if (!template || template.status !== 'released') return 0;

  const sealedDevices = await db.userDevice.findMany({
    where: { device: { is_sealed: true } },
    include: { device: { select: { type: true, version: true } } },
  });
  const matching = sealedDevices.filter((d) =>
    template.targets.some(
      (t) =>
        t.device_type === d.device.type &&
        versionInRange(d.device.version, t.version_min, t.version_max),
    ),
  );

  for (const dev of matching) {
    await materializeForUserDevice(dev.id);
    dispatchConfigReload(dev.id, dev.user_id, dev.device.version);
  }
  log.info({ templateId, applied: matching.length }, 'sealed template re-applied to live devices');
  return matching.length;
}

// Subscribe to admin template releases (published by the api service) and re-apply them.
export async function startSealedTemplateConsumer(): Promise<void> {
  await consume<SealedTemplateAppliedPayload>(
    getChannel(),
    QUEUES.SEALED_TEMPLATE_APPLIED,
    async (payload) => {
      await reMaterializeMatchingDevices(payload.templateId);
    },
  );
  log.info('subscribed to sealed template releases');
}

// A device reloads its served config by rebooting on `restart` — it re-fetches /device/configuration
// on every boot. Must NOT be `reprovision`: the firmware aliases that to `soft-reset` and wipes the
// device's IoT credentials, dropping real hardware into BLE provisioning mode (the sim hides this by
// silently re-provisioning itself). Best-effort — an offline device re-pulls config on next reconnect.
function dispatchConfigReload(deviceId: number, userId: number, firmwareVersion: string): void {
  try {
    const payload: ActionDispatchPayload = {
      userId: String(userId),
      deviceId: String(deviceId),
      actionName: 'restart',
      command: '',
      firmwareVersion,
    };
    publish(getChannel(), RK.ACTION_DISPATCH, payload);
  } catch (err) {
    log.warn({ err, deviceId }, 'config-reload dispatch failed — device reloads on next reconnect');
  }
}
