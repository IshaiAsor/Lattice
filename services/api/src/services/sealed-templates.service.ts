import { db, Prisma } from '../db';
import { publish, RK } from '@lattice/queue';
import type { SealedTemplateAppliedPayload } from '@lattice/queue';
import { getChannel } from '../queue';
import { versionInRange, rangesOverlap } from '@lattice/capability-validation';

// Sealed-device template authoring (admin only). A sealed template is the admin's SELECTION from
// the shared catalog: which capabilities (by capability_key) to activate on a factory-soldered
// device, the fixed GPIO per pin slot, and which behaviors — targeting a set of (device type,
// firmware version range). Only `released` templates materialize; releasing publishes
// SEALED_TEMPLATE_APPLIED so device-gateway re-applies to every already-provisioned match.
//
// The catalog itself stays append-only; these tables + user instances are the only mutable parts.

function badRequest(message: string): Error {
  return Object.assign(new Error(message), { statusCode: 400 });
}
function notFound(message = 'Sealed template not found'): Error {
  return Object.assign(new Error(message), { statusCode: 404 });
}

export interface TargetInput {
  device_type: string;
  version_min: string;
  version_max: string;
}
export interface EntryPinInput {
  pin_slot_key: string;
  pin_number: number;
}
export interface EntryBehaviorInput {
  behavior: string;
  interval_ms?: number | null;
  camera_resolution?: string | null;
  camera_transport?: string | null;
}
export interface EntryInput {
  capability_key: string;
  action_label: string;
  default_trait_value?: string | null;
  sort_order?: number;
  pins?: EntryPinInput[];
  behaviors?: EntryBehaviorInput[];
}

const templateInclude = {
  targets: true,
  entries: { include: { pins: true, behaviors: true }, orderBy: { sort_order: 'asc' } },
} satisfies Prisma.SealedTemplateInclude;

type FullTemplate = Prisma.SealedTemplateGetPayload<{ include: typeof templateInclude }>;

class SealedTemplatesService {
  // ─── Palette: sealed catalog identities the admin composes from ──────────
  listSealedIdentities() {
    return db.device.findMany({
      where: { is_sealed: true },
      orderBy: [{ type: 'asc' }, { version: 'asc' }],
      select: { id: true, type: true, version: true, default_name: true },
    });
  }

  // ─── Template CRUD ──────────────────────────────────────────────────────
  listTemplates() {
    return db.sealedTemplate.findMany({
      orderBy: { name: 'asc' },
      include: { targets: true, _count: { select: { entries: true } } },
    });
  }

  async getTemplate(id: number): Promise<FullTemplate> {
    const t = await db.sealedTemplate.findUnique({ where: { id }, include: templateInclude });
    if (!t) throw notFound();
    return t;
  }

  async createTemplate(name: string): Promise<FullTemplate> {
    if (typeof name !== 'string' || !name.trim()) throw badRequest('name is required');
    const created = await db.sealedTemplate.create({
      data: { name: name.trim(), status: 'draft' },
      include: templateInclude,
    });
    return created;
  }

  // Full authoring update: name and/or a bulk replace of targets/entries. Editing does not
  // affect live devices until `release` is called.
  async updateTemplate(
    id: number,
    body: { name?: string; targets?: TargetInput[]; entries?: EntryInput[] },
  ): Promise<FullTemplate> {
    await this.getTemplate(id);
    if (body.targets) body.targets.forEach(assertValidTarget);
    if (body.entries) assertValidEntries(body.entries);

    await db.$transaction(async (tx) => {
      if (body.name !== undefined) {
        if (!body.name.trim()) throw badRequest('name cannot be empty');
        await tx.sealedTemplate.update({
          where: { id },
          data: { name: body.name.trim(), updated_at: new Date() },
        });
      }
      if (body.targets) {
        await tx.sealedTemplateTarget.deleteMany({ where: { template_id: id } });
        await tx.sealedTemplateTarget.createMany({
          data: body.targets.map((t) => ({
            template_id: id,
            device_type: t.device_type,
            version_min: t.version_min,
            version_max: t.version_max,
          })),
        });
      }
      if (body.entries) {
        // Replace the whole entry set (cascades pins/behaviors).
        await tx.sealedTemplateEntry.deleteMany({ where: { template_id: id } });
        for (const [i, e] of body.entries.entries()) {
          await tx.sealedTemplateEntry.create({
            data: {
              template_id: id,
              capability_key: e.capability_key,
              action_label: e.action_label,
              default_trait_value: e.default_trait_value ?? null,
              sort_order: e.sort_order ?? i,
              pins: {
                create: (e.pins ?? []).map((p) => ({
                  pin_slot_key: p.pin_slot_key,
                  pin_number: p.pin_number,
                })),
              },
              behaviors: {
                create: (e.behaviors ?? []).map((b) => ({
                  behavior: b.behavior,
                  interval_ms: b.interval_ms ?? null,
                  camera_resolution: b.camera_resolution ?? null,
                  camera_transport: b.camera_transport ?? null,
                })),
              },
            },
          });
        }
      }
      await tx.sealedTemplate.update({ where: { id }, data: { updated_at: new Date() } });
    });
    return this.getTemplate(id);
  }

  async deleteTemplate(id: number): Promise<void> {
    await this.getTemplate(id);
    await db.sealedTemplate.delete({ where: { id } }); // cascades targets/entries/pins/behaviors
  }

  // ─── Release: validate, mark released, re-apply to live devices ──────────
  async releaseTemplate(id: number): Promise<{ status: string; affected: number }> {
    const template = await this.getTemplate(id);
    await this.validateReleasable(template);

    const affected = await this.countMatchingDevices(template);

    await db.sealedTemplate.update({
      where: { id },
      data: { status: 'released', updated_at: new Date() },
    });

    // device-gateway owns user_device_actions materialization: re-apply to every provisioned
    // match + push a config reload. Best-effort — a queue hiccup shouldn't fail the release
    // (the next provision/reconnect still materializes from the released template).
    try {
      const payload: SealedTemplateAppliedPayload = {
        templateId: id,
        timestamp: new Date().toISOString(),
      };
      publish(await getChannel(), RK.SEALED_TEMPLATE_APPLIED, payload);
    } catch {
      // swallow — status is already released; re-apply can be retried by re-releasing.
    }

    return { status: 'released', affected };
  }

  // Provisioned devices this template currently matches (for the "affects N devices" prompt).
  private async countMatchingDevices(template: FullTemplate): Promise<number> {
    const devices = await db.userDevice.findMany({
      where: { device: { is_sealed: true } },
      select: { id: true, device: { select: { type: true, version: true } } },
    });
    return devices.filter((d) =>
      template.targets.some(
        (t) =>
          t.device_type === d.device.type &&
          versionInRange(d.device.version, t.version_min, t.version_max),
      ),
    ).length;
  }

  // Release gate: non-empty; every entry (capability_key + pin slots + behaviors) exists in EVERY
  // covered catalog version; pin numbers unique per device; no overlap with other released targets.
  private async validateReleasable(template: FullTemplate): Promise<void> {
    if (template.targets.length === 0) throw badRequest('template has no targets');
    if (template.entries.length === 0) throw badRequest('template has no entries');

    // Pin numbers must not collide across the actions materialized onto one device.
    const pinNumbers = template.entries.flatMap((e) => e.pins.map((p) => p.pin_number));
    if (new Set(pinNumbers).size !== pinNumbers.length) {
      throw badRequest(
        'duplicate pin_number across template entries — pins would collide on the device',
      );
    }

    // Reject overlapping released targets for the same device type (a device must resolve to one).
    const otherTargets = await db.sealedTemplateTarget.findMany({
      where: {
        template: { status: 'released', id: { not: template.id } },
        device_type: { in: template.targets.map((t) => t.device_type) },
      },
    });
    for (const mine of template.targets) {
      for (const other of otherTargets) {
        if (
          other.device_type === mine.device_type &&
          rangesOverlap(mine.version_min, mine.version_max, other.version_min, other.version_max)
        ) {
          throw badRequest(
            `target ${mine.device_type} ${mine.version_min}–${mine.version_max} overlaps an already-released template`,
          );
        }
      }
    }

    // Each covered catalog version must actually expose every referenced capability/pin/behavior.
    for (const t of template.targets) {
      const versions = await db.device.findMany({
        where: { type: t.device_type, is_sealed: true },
        include: { capabilities: { include: { pins: true, configurations: true } } },
      });
      const covered = versions.filter((v) =>
        versionInRange(v.version, t.version_min, t.version_max),
      );
      if (covered.length === 0) {
        throw badRequest(
          `no sealed catalog version for ${t.device_type} in ${t.version_min}–${t.version_max}`,
        );
      }
      for (const v of covered) {
        const capByKey = new Map(v.capabilities.map((c) => [c.capability_key, c]));
        for (const e of template.entries) {
          const cap = capByKey.get(e.capability_key);
          if (!cap) {
            throw badRequest(
              `capability "${e.capability_key}" missing in ${t.device_type} ${v.version}`,
            );
          }
          const pinKeys = new Set(cap.pins.map((p) => p.key));
          for (const p of e.pins) {
            if (!pinKeys.has(p.pin_slot_key)) {
              throw badRequest(
                `pin slot "${p.pin_slot_key}" not on "${e.capability_key}" in ${t.device_type} ${v.version}`,
              );
            }
          }
          const behaviors = new Set(cap.configurations.map((c) => c.behavior));
          for (const b of e.behaviors) {
            if (!behaviors.has(b.behavior)) {
              throw badRequest(
                `behavior "${b.behavior}" not supported by "${e.capability_key}" in ${t.device_type} ${v.version}`,
              );
            }
          }
        }
      }
    }
  }
}

function assertValidTarget(t: TargetInput): void {
  if (!t.device_type?.trim()) throw badRequest('target.device_type is required');
  if (!t.version_min?.trim() || !t.version_max?.trim()) {
    throw badRequest('target.version_min and version_max are required');
  }
}
function assertValidEntries(entries: EntryInput[]): void {
  const keys = new Set<string>();
  for (const e of entries) {
    if (!e.capability_key?.trim()) throw badRequest('entry.capability_key is required');
    if (!e.action_label?.trim()) throw badRequest('entry.action_label is required');
    if (keys.has(e.capability_key))
      throw badRequest(`duplicate capability_key "${e.capability_key}"`);
    keys.add(e.capability_key);
    for (const p of e.pins ?? []) {
      if (!p.pin_slot_key?.trim() || !Number.isInteger(p.pin_number)) {
        throw badRequest('each pin needs pin_slot_key and an integer pin_number');
      }
    }
  }
}

export const sealedTemplatesService = new SealedTemplatesService();
