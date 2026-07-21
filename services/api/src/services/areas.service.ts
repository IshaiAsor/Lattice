import type { Area } from '@lattice/prisma-client';
import { db } from '../db';

// Areas (F10.0) are a standalone "these devices belong together" grouping, independent of
// blueprints. A user creates one by hand; a blueprint derive (later) creates one and fills it.
// Devices carry a nullable area_id (SetNull on delete); the automations that act on them
// (scenes/rules/pipelines) carry the same tag for area-scoped notifications and sectioning.
// Deleting an area only un-groups — it never deletes a device or an automation.

export type AreaWithCounts = Area & { device_count: number };

function badRequest(message: string): Error {
  return Object.assign(new Error(message), { statusCode: 400 });
}

class AreasService {
  async listAreas(userId: number): Promise<AreaWithCounts[]> {
    const areas = await db.area.findMany({
      where: { user_id: userId },
      orderBy: [{ sort_order: 'asc' }, { id: 'asc' }],
      include: { _count: { select: { devices: true } } },
    });
    return areas.map(({ _count, ...area }) => ({ ...area, device_count: _count.devices }));
  }

  async createArea(userId: number, name: string, sortOrder?: number): Promise<Area> {
    const trimmed = this.requireName(name);
    const conflict = await db.area.findUnique({
      where: { user_id_name: { user_id: userId, name: trimmed } },
      select: { id: true },
    });
    if (conflict) {
      throw Object.assign(new Error('An area with this name already exists'), { statusCode: 409 });
    }
    return db.area.create({
      data: { user_id: userId, name: trimmed, sort_order: sortOrder ?? 0 },
    });
  }

  async updateArea(
    userId: number,
    id: number,
    patch: { name?: string; sort_order?: number },
  ): Promise<Area> {
    await this.ensureOwned(userId, id);
    if (patch.name !== undefined) {
      const trimmed = this.requireName(patch.name);
      const conflict = await db.area.findUnique({
        where: { user_id_name: { user_id: userId, name: trimmed } },
        select: { id: true },
      });
      if (conflict && conflict.id !== id) {
        throw Object.assign(new Error('An area with this name already exists'), {
          statusCode: 409,
        });
      }
    }
    return db.area.update({
      where: { id },
      data: {
        name: patch.name?.trim(),
        sort_order: patch.sort_order,
        updated_at: new Date(),
      },
    });
  }

  async reorderAreas(userId: number, orderedIds: number[]): Promise<void> {
    const owned = new Set(
      (
        await db.area.findMany({
          where: { user_id: userId },
          select: { id: true },
        })
      ).map((a) => a.id),
    );
    if (orderedIds.some((id) => !owned.has(id))) {
      throw Object.assign(new Error('Forbidden'), { statusCode: 403 });
    }
    await db.$transaction(async (tx) => {
      for (const [index, id] of orderedIds.entries()) {
        await tx.area.update({ where: { id }, data: { sort_order: index } });
      }
    });
  }

  // Move devices into an area, or out of any area when areaId is null. All devices must belong
  // to the user; a null areaId clears the tag (SetNull equivalent, chosen explicitly here).
  async assignDevices(userId: number, areaId: number | null, deviceIds: number[]): Promise<void> {
    if (!Array.isArray(deviceIds) || deviceIds.length === 0) {
      throw badRequest('deviceIds must be a non-empty array');
    }
    if (areaId !== null) await this.ensureOwned(userId, areaId);

    const owned = await db.userDevice.findMany({
      where: { id: { in: deviceIds }, user_id: userId },
      select: { id: true },
    });
    if (owned.length !== new Set(deviceIds).size) {
      throw Object.assign(new Error('Forbidden'), { statusCode: 403 });
    }

    await db.userDevice.updateMany({
      where: { id: { in: deviceIds }, user_id: userId },
      data: { area_id: areaId, updated_at: new Date() },
    });
  }

  async deleteArea(userId: number, id: number): Promise<void> {
    await this.ensureOwned(userId, id);
    await db.area.delete({ where: { id } }); // devices/scenes/rules/pipelines → area_id null
  }

  private requireName(name: unknown): string {
    if (typeof name !== 'string' || !name.trim()) throw badRequest('name is required');
    return name.trim();
  }

  private async ensureOwned(userId: number, id: number): Promise<void> {
    const area = await db.area.findUnique({ where: { id }, select: { user_id: true } });
    if (!area) throw Object.assign(new Error('Area not found'), { statusCode: 404 });
    if (area.user_id !== userId) throw Object.assign(new Error('Forbidden'), { statusCode: 403 });
  }
}

export const areasService = new AreasService();
