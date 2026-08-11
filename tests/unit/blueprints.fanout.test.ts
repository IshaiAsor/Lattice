// Blueprints (F11.2 / F11.9): how one template becomes one automation or several, and over which
// devices.
//
// Both derive and reconcile ask the same two questions of a template — how many entities does it
// produce, and which binding does each belong to — and they must answer identically, or a publish
// would create duplicates of what the derive already made. That is why the rule lives in one module
// and is pinned here rather than in either service's own tests.
//
// The other half is addressing: a per-device entity has to resolve its fan-out slot to *its own*
// device while every other slot still resolves to all of theirs. Getting that backwards would give
// each device the whole setup's actions, which no integration test would obviously catch.
//
// F11.9 adds a second, orthogonal question — WHICH of the slot's devices take part, selected by
// lifecycle. The two combine into "all" (combined, no selection), "one each" (per_device), and
// "some" (either, with a selection), so the matrix below pins all four corners rather than only
// the two modes.

import {
  fanTargets,
  fannedName,
  COMBINED_TARGET,
} from '../../services/api/src/services/blueprints.fanout';
import { buildResolverFrom } from '../../services/api/src/services/blueprints.addressing';

const bindings = [
  { slot_key: 'tank', user_device_id: 10, label: null, profile_key: null },
  { slot_key: 'loops', user_device_id: 20, label: 'Loop A', profile_key: 'fast' },
  { slot_key: 'loops', user_device_id: 21, label: null, profile_key: 'slow' },
];
const deviceNames = new Map([
  [10, 'Tank board'],
  [20, 'Socket board'],
  [21, 'Socket board'],
]);

const combined = { fan_out: 'combined', fan_out_slot_key: null };
const perDevice = { fan_out: 'per_device', fan_out_slot_key: 'loops' };

describe('fanTargets', () => {
  it('produces exactly one entity for a combined template', () => {
    expect(fanTargets(combined, bindings, deviceNames)).toEqual([COMBINED_TARGET]);
  });

  it('produces one entity per bound device of the fan-out slot', () => {
    const targets = fanTargets(perDevice, bindings, deviceNames);
    expect(targets.map((t) => t.deviceId)).toEqual([20, 21]);
  });

  it('produces nothing when the fan-out slot has no bound device', () => {
    // The per-device analog of the `skip` a combined template takes for an unbound optional slot:
    // no devices, no entities — rather than one entity wired to nothing.
    expect(fanTargets(perDevice, [bindings[0]!], deviceNames)).toEqual([]);
  });

  it('ignores the fan-out slot key when the mode is combined', () => {
    // A stale key left behind by switching the mode back must not quietly re-enable fan-out.
    const stale = { fan_out: 'combined', fan_out_slot_key: 'loops' };
    expect(fanTargets(stale, bindings, deviceNames)).toEqual([COMBINED_TARGET]);
  });

  it("names each entity after the device's label", () => {
    const targets = fanTargets(perDevice, bindings, deviceNames);
    expect(fannedName('Water low', targets[0]!)).toBe('Water low · Loop A');
  });

  it("falls back to the device's own name when the binding has no label", () => {
    const targets = fanTargets(perDevice, bindings, deviceNames);
    expect(fannedName('Water low', targets[1]!)).toBe('Water low · Socket board');
  });

  it("leaves a combined entity's name untouched", () => {
    expect(fannedName('Water low', COMBINED_TARGET)).toBe('Water low');
  });

  // ── The device selector (F11.9) ─────────────────────────────────────────────────────────
  //
  // "Some of them" was the missing shape: before this, an automation meant for two of three
  // devices had to be per_device over all three and gated by phase, which still materialised a
  // permanently inert copy on the third.

  it('fans out per device over only the selected lifecycles', () => {
    const t = { fan_out: 'per_device', fan_out_slot_key: 'loops', fan_out_profiles: ['fast'] };
    expect(fanTargets(t, bindings, deviceNames).map((x) => x.deviceId)).toEqual([20]);
  });

  it('covers only the selected devices in one combined entity', () => {
    // One entity, still belonging to no single binding — but narrowed, so it addresses the chosen
    // devices only. That pair (no deviceId, some deviceIds) is the whole point of the two fields.
    const t = { fan_out: 'combined', fan_out_slot_key: 'loops', fan_out_profiles: ['slow'] };
    expect(fanTargets(t, bindings, deviceNames)).toEqual([
      { deviceId: null, deviceIds: [21], suffix: null },
    ]);
  });

  it("leaves a selected combined entity's name untouched", () => {
    // There is only ever one of it, so nothing needs telling apart — the author's name stands.
    const t = { fan_out: 'combined', fan_out_slot_key: 'loops', fan_out_profiles: ['slow'] };
    expect(fannedName('Water low', fanTargets(t, bindings, deviceNames)[0]!)).toBe('Water low');
  });

  it('produces nothing when no bound device follows a selected lifecycle', () => {
    const t = { fan_out: 'combined', fan_out_slot_key: 'loops', fan_out_profiles: ['unused'] };
    expect(fanTargets(t, bindings, deviceNames)).toEqual([]);
  });

  it('ignores an unprofiled device when a lifecycle is selected', () => {
    // A shared device has no lifecycle, so it can never match a selection — it must not fall
    // through as "no profile, therefore everything".
    const t = { fan_out: 'per_device', fan_out_slot_key: 'tank', fan_out_profiles: ['fast'] };
    expect(fanTargets(t, bindings, deviceNames)).toEqual([]);
  });

  it('covers every device when the selection is empty', () => {
    const t = { fan_out: 'per_device', fan_out_slot_key: 'loops', fan_out_profiles: [] };
    expect(fanTargets(t, bindings, deviceNames).map((x) => x.deviceId)).toEqual([20, 21]);
  });

  it('keeps binding order when the selection is given out of order', () => {
    const t = {
      fan_out: 'per_device',
      fan_out_slot_key: 'loops',
      fan_out_profiles: ['slow', 'fast'],
    };
    expect(fanTargets(t, bindings, deviceNames).map((x) => x.deviceId)).toEqual([20, 21]);
  });
});

describe('SlotActionResolver.scopedTo', () => {
  // Two loops and a shared tank, each device carrying the same action names — which is exactly the
  // case where addressing by (slot, action) alone stops being enough.
  const resolver = buildResolverFrom(
    new Map([
      ['tank', [10]],
      ['loops', [20, 21]],
    ]),
    new Map([
      ['10:water_level', 100],
      ['20:moisture', 200],
      ['20:valve', 201],
      ['21:moisture', 210],
      ['21:valve', 211],
    ]),
  );

  it('narrows only the named slot, leaving every other slot on all of its devices', () => {
    const scoped = resolver.scopedTo('loops', [20]);
    expect(scoped.devicesInSlot('loops')).toEqual([20]);
    expect(scoped.devicesInSlot('tank')).toEqual([10]);
    expect(scoped.deviceCount('loops')).toBe(1);
  });

  it("resolves the narrowed slot to that one device's action", () => {
    const scoped = resolver.scopedTo('loops', [21]);
    expect(scoped.actionIds('loops', 'moisture')).toEqual([210]);
    // The shared device is still fully addressable — a per-device rule reads its own sensor but
    // still commands the setup's shared actuator.
    expect(scoped.actionIds('tank', 'water_level')).toEqual([100]);
  });

  it('leaves an unscoped resolver resolving every device', () => {
    expect(resolver.actionIds('loops', 'moisture')).toEqual([200, 210]);
    expect(resolver.deviceCount('loops')).toBe(2);
  });

  it('narrows a combined resolver to the selected devices only', () => {
    // The F11.9 shape: several devices, but not all of them. Order follows the binding order
    // rather than the caller's list, so actionIds stays aligned with devicesInSlot.
    const scoped = resolver.scopedTo('loops', [21, 20]);
    expect(scoped.devicesInSlot('loops')).toEqual([20, 21]);
    expect(scoped.actionIds('loops', 'valve')).toEqual([201, 211]);
  });
});
