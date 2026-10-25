// Unit: the device, sensor and setup Data tabs (F18.20).
//
// Two decisions carry them, and each fails silently if it is wrong:
//
//   describeResolution   what applies, what "Remove list" falls back to, and where every scope
//                        stands. A wrong fallback is a screen promising one list and applying
//                        another the moment the button is pressed.
//   slotActionsOf        which of a bound device's actions a setup shows. A board may carry actions
//                        the blueprint never mentions, and those are not the setup's to edit.

import {
  describeResolution,
  type BucketDef,
  type PlatformTier,
  type Tier,
} from '../../packages/retention/src';
import { slotActionsOf } from '../../services/api/src/services/retention-blueprints.service';

const DEFS: BucketDef[] = [
  { code: 'raw', seconds: 0, label: 'Raw readings', anchorOffsetSeconds: 0 },
  { code: '5m', seconds: 300, label: '5 minutes', anchorOffsetSeconds: 0 },
  { code: '15m', seconds: 900, label: '15 minutes', anchorOffsetSeconds: 0 },
  { code: '1h', seconds: 3600, label: '1 hour', anchorOffsetSeconds: 0 },
  { code: '1d', seconds: 86400, label: '1 day', anchorOffsetSeconds: 0 },
];
const CATALOG = new Map(DEFS.map((d) => [d.code, d]));

const tiers = (...pairs: [string, number][]): Tier[] =>
  pairs.map(([bucket, keepDays], position) => ({ bucket, keepDays, position }));

const PLATFORM: PlatformTier[] = [
  { bucket: 'raw', keepDays: 30, maxKeepDays: null, position: 0 },
  { bucket: '1d', keepDays: 365, maxKeepDays: null, position: 1 },
];

const base = { kind: 'scalar' as const, buckets: CATALOG, platform: PLATFORM };
const reachesBoth = { blueprint: true, sealed: true };
const reachesNeither = { blueprint: false, sealed: false };
const buckets = (t: { tiers: { bucket: string }[] }) => t.tiers.map((x) => x.bucket);
const standing = (d: ReturnType<typeof describeResolution>) =>
  Object.fromEntries(d.scopes.map((s) => [s.scope, s.state]));

describe('describeResolution', () => {
  const deviceList = tiers(['raw', 14], ['1h', 90], ['1d', 0]);
  const sensorList = tiers(['raw', 7], ['15m', 30], ['1h', 90]);

  it("a sensor's own list answers, and removing it falls back to the device's", () => {
    const d = describeResolution(
      { ...base, device: deviceList, action: sensorList },
      reachesNeither,
    );
    expect(d.effective.source).toBe('action');
    expect(buckets(d.effective)).toEqual(['raw', '15m', '1h']);
    expect(d.fallback.source).toBe('device');
    expect(buckets(d.fallback)).toEqual(['raw', '1h', '1d']);
  });

  it("leaves a neighbour on the same device on the device's list", () => {
    // The row's acceptance criterion, at resolver level: a 15m tier on one sensor does not change
    // the sensor beside it.
    const neighbour = describeResolution(
      { ...base, device: deviceList, action: [] },
      reachesNeither,
    );
    expect(neighbour.effective.source).toBe('device');
    expect(buckets(neighbour.effective)).toEqual(['raw', '1h', '1d']);
  });

  it('without an own list, the fallback is what already applies', () => {
    const d = describeResolution({ ...base, sealed: tiers(['raw', 7], ['5m', 30]) }, reachesBoth);
    expect(d.fallback).toEqual(d.effective);
    expect(d.effective.source).toBe('sealed');
  });

  it('marks a scope that cannot reach the action n/a, not empty', () => {
    // "Not in a setup" and "the setup's blueprint has no list" are different answers.
    const unbound = describeResolution({ ...base }, reachesNeither);
    expect(standing(unbound)).toMatchObject({ blueprint: 'n/a', sealed: 'n/a' });

    const bound = describeResolution({ ...base, blueprint: [], sealed: [] }, reachesBoth);
    expect(standing(bound)).toMatchObject({ blueprint: 'empty', sealed: 'empty' });
  });

  it('shows a list below the answering scope as held but not reached', () => {
    const d = describeResolution(
      {
        ...base,
        action: sensorList,
        device: deviceList,
        sealed: tiers(['raw', 7], ['5m', 30]),
        user: tiers(['raw', 14]),
      },
      { blueprint: false, sealed: true },
    );
    expect(standing(d)).toEqual({
      action: 'answering',
      device: 'has-list',
      blueprint: 'n/a',
      sealed: 'has-list',
      user: 'has-list',
      platform: 'has-list',
    });
  });

  it('lets the platform answer when nothing else is configured', () => {
    const d = describeResolution({ ...base }, reachesNeither);
    expect(standing(d)).toEqual({
      action: 'empty',
      device: 'empty',
      blueprint: 'n/a',
      sealed: 'n/a',
      user: 'empty',
      platform: 'answering',
    });
  });

  it('never marks a scope n/a when it answers', () => {
    // `applies` and the input can only disagree through a caller bug, but if they do the screen must
    // not draw the list that is actually applied as unreachable.
    const d = describeResolution({ ...base, blueprint: tiers(['raw', 7]) }, reachesNeither);
    expect(standing(d).blueprint).toBe('answering');
  });
});

describe('slotActionsOf', () => {
  const actions = [
    { id: 1, mqtt_action_name: 'tank_level' },
    { id: 2, mqtt_action_name: 'status_led' },
    { id: 3, mqtt_action_name: 'relay' },
  ];

  it('keeps only the actions the slot addresses, in the device order', () => {
    expect(slotActionsOf(actions, new Set(['relay', 'tank_level'])).map((a) => a.id)).toEqual([
      1, 3,
    ]);
  });

  it('shows nothing for a slot the blueprint no longer has', () => {
    expect(slotActionsOf(actions, undefined)).toEqual([]);
  });
});
