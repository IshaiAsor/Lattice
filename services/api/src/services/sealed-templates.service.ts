import { db, Prisma } from '../db';
import { publish, RK } from '@lattice/queue';
import type { SealedTemplateAppliedPayload } from '@lattice/queue';
import { getChannel } from '../queue';
import { versionInRange, rangesOverlap } from '@lattice/capability-validation';
import {
  findTemplateUsage,
  strandedReferences,
  type TemplateUsage,
} from './sealed-templates.usage';

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
// 409 + `details`: the caller is not malformed, it is in conflict with something already published,
// and the admin needs the full list of what breaks — not one reason per round trip.
function conflict(message: string, details: string[]): Error {
  return Object.assign(new Error(message), { statusCode: 409, details });
}

/**
 * The owner of a sealed device may still *use* it (rename, group, send state), but its pins and
 * action set come from the admin's template — a user edit would be silently reverted the next
 * time the template is applied. Config-changing paths call this so the rule is enforced by the
 * api, not only hidden in the UI.
 */
export function ensureNotSealed(isSealed: boolean): void {
  if (isSealed) {
    throw Object.assign(
      new Error('This device is sealed — its pins and actions are fixed by an admin template'),
      { statusCode: 403 },
    );
  }
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
  // Base MQTT action name of the capability (from the catalog palette). The server suffixes it
  // (_2, _3…) per repeated instance so each entry gets a unique mqtt_action_name. Optional on the
  // wire — falls back to capability_key if omitted.
  mqtt_action_name?: string;
  action_label: string;
  default_trait_value?: string | null;
  sort_order?: number;
  pins?: EntryPinInput[];
  behaviors?: EntryBehaviorInput[];
}

// Assign each entry a unique mqtt_action_name: the capability's base name for the first instance,
// <base>_2/_3/… for repeats — the same scheme deviceMgmtService.activateCapability uses for
// regular devices, so the firmware served-config + MQTT dispatch handle N instances unchanged.
//
// The caller may send an entry's *existing* name as its base, to keep an already-addressed entry
// addressable (the editor does this — see DraftInstance.mqtt_action_name). That mixes bases like
// "socket" and "socket_2" in one list, so a generated suffix can land on a name another entry
// already holds; the loop steps past taken names instead of colliding on the
// (template_id, mqtt_action_name) unique index.
function assignMqttNames(entries: EntryInput[]): (EntryInput & { mqtt_action_name: string })[] {
  const seen = new Map<string, number>();
  const used = new Set<string>();
  return entries.map((e) => {
    const base = e.mqtt_action_name?.trim() || e.capability_key;
    let n = seen.get(base) ?? 0;
    let name = n === 0 ? base : `${base}_${n + 1}`;
    while (used.has(name)) {
      n += 1;
      name = `${base}_${n + 1}`;
    }
    seen.set(base, n + 1);
    used.add(name);
    return { ...e, mqtt_action_name: name };
  });
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

  // ─── Reverse dependency: which blueprints this template holds up (F10.10) ─────
  getUsage(id: number): Promise<TemplateUsage[]> {
    return findTemplateUsage(id);
  }

  /**
   * Refuse an entry edit that would strand a published blueprint's action reference.
   *
   * Only *published* blueprints block: a draft is still held by the publish gate, which validates
   * against the template as it will be by then, so blocking on a draft would forbid editing a
   * template while anyone has an unfinished blueprint mentioning it.
   *
   * `force` is the deliberate escape hatch — an admin retiring an action on purpose will fix the
   * blueprints next, and this must not become a deadlock between two edits that need each other.
   * What it must never be is the *default*, which is exactly the state this item was filed about.
   */
  private async assertNoStrandedBlueprints(id: number, names: Set<string>): Promise<void> {
    const usage = await findTemplateUsage(id);
    const problems = usage
      .filter((u) => u.status === 'published')
      .flatMap((u) => strandedReferences(u, names));
    if (problems.length === 0) return;
    throw conflict(
      `this edit strands ${problems.length} reference(s) in ${
        new Set(problems.map((p) => p.split(' — ')[0])).size
      } published blueprint(s) — add a replacement entry and retire the old one rather than renaming, or re-send with force to proceed anyway`,
      problems,
    );
  }

  // Full authoring update: name and/or a bulk replace of targets/entries. Editing does not
  // affect live devices until `release` is called.
  async updateTemplate(
    id: number,
    body: { name?: string; targets?: TargetInput[]; entries?: EntryInput[]; force?: boolean },
  ): Promise<FullTemplate> {
    await this.getTemplate(id);
    if (body.targets) body.targets.forEach(assertValidTarget);
    if (body.entries) assertValidEntries(body.entries);

    // Names are assigned here, before the write, because the guard has to compare the name set the
    // save WOULD produce: the suffixes are positional, so removing one entry renames its siblings.
    const named = body.entries ? assignMqttNames(body.entries) : null;
    if (named && !body.force) {
      await this.assertNoStrandedBlueprints(id, new Set(named.map((e) => e.mqtt_action_name)));
    }

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
      if (named) {
        // Replace the whole entry set (cascades pins/behaviors), under the names assigned above so
        // each instance of a repeated capability gets a unique mqtt_action_name.
        await tx.sealedTemplateEntry.deleteMany({ where: { template_id: id } });
        for (const [i, e] of named.entries()) {
          await tx.sealedTemplateEntry.create({
            data: {
              template_id: id,
              capability_key: e.capability_key,
              mqtt_action_name: e.mqtt_action_name,
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
    // BlueprintSlot.sealed_template_id is onDelete: Restrict, so the database would refuse this
    // anyway — as an opaque 500. Name the dependents instead. No force here: unlike an entry edit,
    // there is no state the admin could reach by pushing through.
    const usage = await this.getUsage(id);
    if (usage.length > 0) {
      throw conflict(
        `sealed template fills slots in ${usage.length} blueprint(s) — delete or re-point those first`,
        usage.map((u) => `"${u.name}" (${u.status}) — slot ${u.slot_keys.join(', ')}`),
      );
    }
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

    // No cross-entry pin-collision check: multi-instance actions legitimately share bus pins
    // (e.g. 8 i2c_socket_8 channels share SDA/SCL/address), and regular device-config trusts the
    // admin's pin assignments too — so pin sanity is the composer's responsibility, not a gate.

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
  // A capability may repeat (multi-instance) — uniqueness is on the generated mqtt_action_name,
  // not capability_key — so we only validate each entry is individually well-formed.
  for (const e of entries) {
    if (!e.capability_key?.trim()) throw badRequest('entry.capability_key is required');
    if (!e.action_label?.trim()) throw badRequest('entry.action_label is required');
    for (const p of e.pins ?? []) {
      if (!p.pin_slot_key?.trim() || !Number.isInteger(p.pin_number)) {
        throw badRequest('each pin needs pin_slot_key and an integer pin_number');
      }
    }
  }
}

export const sealedTemplatesService = new SealedTemplatesService();
