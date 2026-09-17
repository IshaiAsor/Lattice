// Unit: sealed templates as a retention scope (F18.21).
//
// Three small pure decisions carry the scope, and each one fails silently if it is wrong:
//
//   releasedTemplateFor   which template covers a device. It must agree with materialization, or
//                         a device gets one template's actions and another's retention.
//   isActionScopedKind    which kinds a sealed list may govern. A `command` list would be stored
//                         and shown, and never applied — command windows are resolved per user.
//   staleSealedLists      what a template save strands. A list left behind for a removed entry
//                         attaches itself to whichever entry a later save gives that name.

import { releasedTemplateFor, type TemplateTarget } from '../../packages/capability-validation/src';
import { isActionScopedKind, DATA_KINDS } from '../../packages/retention/src';
import { staleSealedLists } from '../../services/api/src/services/retention-sealed.service';

describe('releasedTemplateFor', () => {
  const targets: TemplateTarget[] = [
    { template_id: 1, device_type: 'TANK_BOARD', version_min: 'v2.0.0', version_max: 'v2.4.9' },
    { template_id: 2, device_type: 'TANK_BOARD', version_min: 'v2.5.0', version_max: 'v2.9.9' },
    { template_id: 3, device_type: 'SOCKET_BOARD', version_min: 'v1.0.0', version_max: 'v9.9.9' },
  ];

  it('finds the template whose range holds the version', () => {
    expect(releasedTemplateFor('TANK_BOARD', 'v2.3.1', targets)).toBe(1);
    expect(releasedTemplateFor('TANK_BOARD', 'v2.7.0', targets)).toBe(2);
  });

  it('treats both ends of a range as inside it', () => {
    expect(releasedTemplateFor('TANK_BOARD', 'v2.0.0', targets)).toBe(1);
    expect(releasedTemplateFor('TANK_BOARD', 'v2.4.9', targets)).toBe(1);
    expect(releasedTemplateFor('TANK_BOARD', 'v2.5.0', targets)).toBe(2);
  });

  it('compares versions numerically, not as strings', () => {
    // 'v2.10.0' sorts before 'v2.5.0' as a string; as a version it is past both tank ranges.
    expect(releasedTemplateFor('TANK_BOARD', 'v2.10.0', targets)).toBeNull();
  });

  it('never matches a target for another device type', () => {
    expect(releasedTemplateFor('SOCKET_BOARD', 'v2.3.1', targets)).toBe(3);
    expect(releasedTemplateFor('OTHER_BOARD', 'v2.3.1', targets)).toBeNull();
  });

  it('answers null when no target covers the version', () => {
    expect(releasedTemplateFor('TANK_BOARD', 'v1.9.9', targets)).toBeNull();
    expect(releasedTemplateFor('TANK_BOARD', 'v2.3.1', [])).toBeNull();
  });
});

describe('isActionScopedKind', () => {
  it('admits only the kinds whose history belongs to an action', () => {
    expect(DATA_KINDS.filter(isActionScopedKind)).toEqual(['scalar', 'frame']);
  });
});

describe('staleSealedLists', () => {
  const row = (action_name: string, data_kind: string, bucket: string, position: number) => ({
    action_name,
    data_kind,
    bucket,
    keep_days: bucket === 'raw' ? 14 : 30,
    position,
  });
  const rows = [
    row('tank_level', 'scalar', 'raw', 0),
    row('tank_level', 'scalar', '5m', 1),
    row('camera', 'frame', 'raw', 0),
    row('pump', 'scalar', 'raw', 0),
  ];

  it('keeps every list whose entry is still in the template', () => {
    expect(staleSealedLists(rows, new Set(['tank_level', 'camera', 'pump']))).toEqual([]);
  });

  it('returns the whole list of a removed entry, tiers in order, per kind', () => {
    const stale = staleSealedLists(rows, new Set(['camera', 'pump']));
    expect(stale).toEqual([
      {
        actionName: 'tank_level',
        dataKind: 'scalar',
        tiers: [
          { bucket: 'raw', keepDays: 14, position: 0 },
          { bucket: '5m', keepDays: 30, position: 1 },
        ],
      },
    ]);
  });

  it('treats a renamed entry as removed', () => {
    // `tank_level` → `tank_level_2`: the name is the identity, so the old list must not follow.
    const stale = staleSealedLists(rows, new Set(['tank_level_2', 'camera', 'pump']));
    expect(stale.map((l) => l.actionName)).toEqual(['tank_level']);
  });

  it('returns every list when the template is deleted', () => {
    const stale = staleSealedLists(rows, null);
    expect(stale.map((l) => `${l.actionName}/${l.dataKind}`)).toEqual([
      'tank_level/scalar',
      'camera/frame',
      'pump/scalar',
    ]);
  });
});
