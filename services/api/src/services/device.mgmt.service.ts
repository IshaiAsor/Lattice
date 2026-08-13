import { db } from '../db';
import { publish, RK } from '@lattice/queue';
import type { ActionDispatchPayload } from '@lattice/queue';
import { createLogger } from '@lattice/logger';
import { getChannel } from '../queue';
import { ensureNotSealed } from './sealed-templates.service';

const log = createLogger('api:device-mgmt');

// User-facing device management (F2.5).
//
// Device *registration* is owned by device-gateway provisioning (device-driven, upsert
// by MAC — see project_provisioning_redesign), so the api does not create user_devices.
// It owns the rest of the lifecycle: list, rename, delete — always scoped to the owner.

export interface DeviceView {
  id: number;
  deviceName: string;
  online: boolean;
  lastOnlineDate: Date | null;
  type: string;
  version: string;
  // Sealed = factory-soldered: config is admin-composed, so the device-config page is read-only.
  is_sealed: boolean;
  // 'provisioning' = registered but never configured, so the list offers "Finish setup".
  // 'active' = set up. See the UserDevice.status comment in schema.prisma.
  status: string;
  current_firmware_version: string | null;
  update_available: boolean;
  // Latest WiFi RSSI (dBm) from the device heartbeat — only while online (null otherwise, so
  // the UI never shows a stale signal for an offline device).
  rssi: number | null;
  // The Area this device belongs to (F10.0), or null when unassigned.
  area_id: number | null;
}

export interface PinSlotView {
  id: number;
  key: string;
  label: string;
  mode: string;
}
export interface BehaviorSelectionView {
  behavior: string;
  intervalMs: number | null;
  cameraResolution: string | null;
  cameraTransport: string | null;
}
export interface UserActionView {
  id: number;
  name: string;
  mqttName: string;
  pins: { pinNumber: number; pinMode: string }[];
  intervalMs: number | null;
  status: string;
  // CameraAction only — null for every other implementation_type.
  cameraResolution: string | null;
  cameraTransport: string | null;
  // Behaviors the user has enabled on this instance (unified action model, 6d).
  enabledBehaviors: BehaviorSelectionView[];
}
export interface CapabilityView {
  id: number; // DeviceCapability id
  capability_key: string;
  label: string;
  implementation_type: string;
  mqtt_action_type: string;
  mqtt_action_name: string;
  min_telemetry_interval_ms: number | null;
  configurable_pins: PinSlotView[];
  // Behaviors this capability supports (catalog-declared); the UI renders a toggle per entry.
  available_behaviors: { behavior: string; min_interval_ms: number | null }[];
  instances: UserActionView[];
}
export interface PinInput {
  capability_pin_id: number;
  pin_number: number;
}

class DeviceMgmtService {
  async listUserDevices(userId: number): Promise<DeviceView[]> {
    const devices = await db.userDevice.findMany({
      where: { user_id: userId },
      include: { device: true },
      orderBy: { id: 'asc' },
    });

    // Latest catalog version per device type (one query per unique type) → update badge.
    const uniqueTypes = [...new Set(devices.map((d) => d.device.type))];
    const latestVersions = new Map<string, string>();
    await Promise.all(
      uniqueTypes.map(async (type) => {
        const latest = await db.device.findFirst({
          where: { type },
          orderBy: { created_at: 'desc' },
        });
        if (latest) latestVersions.set(type, latest.version);
      }),
    );

    return devices.map((d) => {
      const latestVersion = latestVersions.get(d.device.type) ?? d.device.version;
      return {
        id: d.id,
        deviceName: d.name,
        online: d.online,
        lastOnlineDate: d.last_online_date,
        type: d.device.type,
        version: d.device.version,
        is_sealed: d.device.is_sealed,
        status: d.status,
        current_firmware_version: d.current_firmware_version,
        update_available: d.device.version !== latestVersion,
        rssi: d.online ? d.rssi : null,
        area_id: d.area_id,
      };
    });
  }

  async renameDevice(userId: number, deviceId: number, name: string): Promise<DeviceView> {
    if (typeof name !== 'string' || !name.trim()) {
      throw Object.assign(new Error('name is required'), { statusCode: 400 });
    }
    await this.ensureOwned(userId, deviceId);
    await db.userDevice.update({
      where: { id: deviceId },
      data: { name: name.trim(), updated_at: new Date() },
    });
    const [view] = (await this.listUserDevices(userId)).filter((d) => d.id === deviceId);
    return view;
  }

  async deleteDevice(userId: number, deviceId: number): Promise<void> {
    await this.ensureOwned(userId, deviceId);
    // Cascades user_device_actions (and their pins) via the schema.
    await db.userDevice.delete({ where: { id: deviceId } });
  }

  // ─── Capability activation ────────────────────────────────────────────
  async listCapabilities(userId: number, deviceId: number): Promise<CapabilityView[]> {
    const device = await this.getOwnedDevice(userId, deviceId);
    const [caps, actions] = await Promise.all([
      db.deviceCapability.findMany({
        where: { device_id: device.device_type_id },
        include: { pins: true, configurations: true },
        orderBy: { id: 'asc' },
      }),
      db.userDeviceAction.findMany({
        where: { user_device_id: deviceId },
        include: { pins: true, configurations: true },
      }),
    ]);

    return caps.map((cap) => {
      const modeByPinId = new Map(cap.pins.map((p) => [p.id, p.mode]));
      return {
        id: cap.id,
        capability_key: cap.capability_key,
        label: cap.label,
        implementation_type: cap.implementation_type,
        mqtt_action_type: cap.mqtt_action_type,
        mqtt_action_name: cap.mqtt_action_name,
        min_telemetry_interval_ms: cap.min_telemetry_interval_ms,
        configurable_pins: cap.pins.map((p) => ({
          id: p.id,
          key: p.key,
          label: p.label,
          mode: p.mode,
        })),
        available_behaviors: cap.configurations.map((c) => ({
          behavior: c.behavior,
          min_interval_ms: c.min_interval_ms,
        })),
        instances: actions
          .filter((a) => a.capability_id === cap.id)
          .map((a) => ({
            id: a.id,
            name: a.action_name,
            mqttName: a.mqtt_action_name,
            pins: a.pins.map((p) => ({
              pinNumber: p.pin_number,
              pinMode: modeByPinId.get(p.capability_pin_id) ?? 'OUTPUT',
            })),
            intervalMs: a.telemetry_interval_ms,
            status: a.status,
            cameraResolution: a.camera_resolution,
            cameraTransport: a.camera_transport,
            enabledBehaviors: a.configurations.map((uc) => ({
              behavior: uc.behavior,
              intervalMs: uc.interval_ms,
              cameraResolution: uc.camera_resolution,
              cameraTransport: uc.camera_transport,
            })),
          })),
      };
    });
  }

  async activateCapability(
    userId: number,
    deviceId: number,
    body: {
      capability_id: number;
      telemetry_interval_ms?: number | null;
      pins?: PinInput[];
      camera_resolution?: string | null;
      camera_transport?: string | null;
    },
  ): Promise<{ id: number }> {
    const device = await this.getOwnedDevice(userId, deviceId);
    ensureNotSealed(device.is_sealed);
    const cap = await db.deviceCapability.findUnique({ where: { id: body.capability_id } });
    if (!cap || cap.device_id !== device.device_type_id) {
      throw Object.assign(new Error('Capability not valid for this device'), { statusCode: 400 });
    }

    // Unique mqtt_action_name per instance (first uses the base name).
    const existing = await db.userDeviceAction.count({
      where: { user_device_id: deviceId, capability_id: cap.id },
    });
    const mqttName =
      existing === 0 ? cap.mqtt_action_name : `${cap.mqtt_action_name}_${existing + 1}`;

    const action = await db.userDeviceAction.create({
      data: {
        user_device_id: deviceId,
        capability_id: cap.id,
        action_name: cap.label,
        mqtt_action_name: mqttName,
        status: 'active',
        telemetry_interval_ms: body.telemetry_interval_ms ?? null,
        camera_resolution: body.camera_resolution ?? null,
        camera_transport: body.camera_transport ?? null,
        pins: {
          create: (body.pins ?? []).map((p) => ({
            capability_pin_id: p.capability_pin_id,
            pin_number: p.pin_number,
          })),
        },
      },
    });
    return { id: action.id };
  }

  async updateActivatedAction(
    userId: number,
    deviceId: number,
    actionId: number,
    body: {
      name?: string;
      telemetry_interval_ms?: number | null;
      pins?: PinInput[];
      camera_resolution?: string | null;
      camera_transport?: string | null;
    },
  ): Promise<void> {
    const device = await this.getOwnedDevice(userId, deviceId);
    ensureNotSealed(device.is_sealed);
    const action = await db.userDeviceAction.findUnique({
      where: { id: actionId },
      select: { user_device_id: true },
    });
    if (!action || action.user_device_id !== deviceId) {
      throw Object.assign(new Error('Action not found'), { statusCode: 404 });
    }

    await db.$transaction(async (tx) => {
      await tx.userDeviceAction.update({
        where: { id: actionId },
        data: {
          action_name: body.name?.trim(),
          telemetry_interval_ms: body.telemetry_interval_ms,
          camera_resolution: body.camera_resolution,
          camera_transport: body.camera_transport,
          updated_at: new Date(),
        },
      });
      if (body.pins !== undefined) {
        await tx.userDeviceActionPin.deleteMany({ where: { user_device_action_id: actionId } });
        if (body.pins.length) {
          await tx.userDeviceActionPin.createMany({
            data: body.pins.map((p) => ({
              user_device_action_id: actionId,
              capability_pin_id: p.capability_pin_id,
              pin_number: p.pin_number,
            })),
          });
        }
      }
    });
  }

  // ─── Setup completion ──────────────────────────────────────────────────
  /**
   * Finish first-run setup: activate the capabilities the user picked, mark the device set up,
   * and tell it to load the config it now has.
   *
   * The device has no way to be told about config over MQTT — it subscribes to exactly two
   * topics, command and OTA, and re-reads GET /device/configuration on boot. So "apply" means
   * restart. It must be `restart` and never `reprovision`: firmware aliases reprovision to
   * soft-reset and wipes the device's credentials, which drops real hardware into BLE
   * provisioning mode (see dispatchConfigReload in device-gateway's sealed-materialization).
   */
  async applySetup(
    userId: number,
    deviceId: number,
    selections: {
      capability_id: number;
      telemetry_interval_ms?: number | null;
      pins?: PinInput[];
      camera_resolution?: string | null;
      camera_transport?: string | null;
    }[],
  ): Promise<{ activated: number; skipped: number }> {
    const device = await this.getOwnedDevice(userId, deviceId);

    let activated = 0;
    let skipped = 0;

    // A sealed device's actions come from the admin template at provision time, so there is
    // nothing for the user to activate — applying setup only settles its status.
    if (!device.is_sealed) {
      // One instance per capability is the setup sheet's whole model (a checkbox per row), so a
      // capability that already has one is a re-submit — of a resumed wizard, or a double tap —
      // not a request for a second instance. Adding further instances is device-config's job.
      const already = await db.userDeviceAction.groupBy({
        by: ['capability_id'],
        where: { user_device_id: deviceId },
      });
      const taken = new Set(already.map((a) => a.capability_id));

      for (const sel of selections) {
        if (taken.has(sel.capability_id)) {
          skipped++;
          continue;
        }
        await this.activateCapability(userId, deviceId, sel);
        activated++;
      }
    }

    await db.userDevice.update({ where: { id: deviceId }, data: { status: 'active' } });

    // Best-effort, exactly like the sealed path: an offline device picks the config up on its
    // next boot anyway, so a failed dispatch must not fail the whole setup.
    try {
      await this.dispatchCommand(userId, deviceId, 'restart');
    } catch (err) {
      log.warn({ err, deviceId }, 'config-reload dispatch failed — device reloads on next boot');
    }

    return { activated, skipped };
  }

  // ─── Lifecycle commands (reprovision/reset/restart) ───────────────────
  // actionName is the mqtt_action_name the device firmware listens for; command is the
  // message body sent as-is (these 4 all take no parameters).
  async dispatchCommand(userId: number, deviceId: number, actionName: string): Promise<void> {
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

  private async ensureOwned(userId: number, deviceId: number): Promise<void> {
    await this.getOwnedDevice(userId, deviceId);
  }

  private async getOwnedDevice(
    userId: number,
    deviceId: number,
  ): Promise<{ id: number; device_type_id: number; is_sealed: boolean }> {
    const device = await db.userDevice.findUnique({
      where: { id: deviceId },
      select: {
        id: true,
        user_id: true,
        device_type_id: true,
        device: { select: { is_sealed: true } },
      },
    });
    if (!device) throw Object.assign(new Error('Device not found'), { statusCode: 404 });
    if (device.user_id !== userId) throw Object.assign(new Error('Forbidden'), { statusCode: 403 });
    return {
      id: device.id,
      device_type_id: device.device_type_id,
      is_sealed: device.device.is_sealed,
    };
  }
}

export const deviceMgmtService = new DeviceMgmtService();
