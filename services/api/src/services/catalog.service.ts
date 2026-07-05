import { db, Prisma } from '../db';
import type { Device, DeviceCapability } from '@lattice/prisma-client';

// Explicit return types below: the Json valid_parameters field makes the query results'
// inferred type unnameable across the monorepo's per-package Prisma client (TS2742).
type DeviceWithCapabilities = Device & {
  capabilities: (DeviceCapability &
    Prisma.DeviceCapabilityGetPayload<{
      include: { pins: true; traits: true; google_type: true };
    }>)[];
};

class CatalogService {
  // ─── Device catalog ───────────────────────────────────────────────────
  listDevices(): Promise<Device[]> {
    return db.device.findMany({ orderBy: [{ type: 'asc' }, { version: 'asc' }] });
  }

  async getDevice(id: number): Promise<DeviceWithCapabilities> {
    const device = await db.device.findUnique({
      where: { id },
      include: {
        capabilities: {
          orderBy: { id: 'asc' },
          include: { pins: true, traits: true, google_type: true },
        },
      },
    });
    if (!device) throw Object.assign(new Error('Device not found'), { statusCode: 404 });
    return device;
  }

  async deleteDevice(id: number): Promise<void> {
    await this.ensureExists('device', id);
    await db.device.delete({ where: { id } }); // cascades capabilities/pins/traits
  }

  listCapabilities(
    deviceId: number,
  ): Promise<
    Prisma.DeviceCapabilityGetPayload<{
      include: { pins: true; traits: true; google_type: true };
    }>[]
  > {
    return db.deviceCapability.findMany({
      where: { device_id: deviceId },
      orderBy: { id: 'asc' },
      include: { pins: true, traits: true, google_type: true },
    });
  }

  async listActions(deviceId: number) {
    const capabilities = await db.deviceCapability.findMany({
      where: { device_id: deviceId },
      include: { pins: true, traits: { include: { google_trait: true } }, google_type: true },
    });
    return capabilities.map((c) => ({
      id: c.id,
      device_id: c.device_id,
      default_name: c.label,
      mqtt_action_type: c.mqtt_action_type,
      mqtt_action_name: c.mqtt_action_name,
      implementation_type: c.implementation_type,
      pins: c.pins.map((p) => ({ key: p.key, label: p.label, mode: p.mode })),
      telemetry_interval_ms: c.min_telemetry_interval_ms ?? null,
      google_action_type: c.google_type?.name ?? null,
      google_traits: c.traits.map((t) => ({
        id: t.google_trait_id,
        value: t.google_trait.value,
        is_default: t.is_default,
      })),
    }));
  }

  async setDefaultTrait(capabilityId: number, traitId: number): Promise<void> {
    await db.$transaction(async (tx) => {
      await tx.deviceCapabilityTrait.updateMany({
        where: { capability_id: capabilityId },
        data: { is_default: false },
      });
      await tx.deviceCapabilityTrait.updateMany({
        where: { capability_id: capabilityId, google_trait_id: traitId },
        data: { is_default: true },
      });
    });
  }

  private async ensureExists(model: 'device', id: number): Promise<void> {
    const found = await (db as any)[model].findUnique({ where: { id } });
    if (!found) throw Object.assign(new Error('Not found'), { statusCode: 404 });
  }
}

export const catalogService = new CatalogService();
