// Unit: the blueprint scope as something an author can actually manage (F18.20).
//
// Two decisions carry it, and each fails silently if it is wrong:
//
//   assertActionScoped    which kinds a blueprint (or sealed) list may govern. A `command` list
//                         there was accepted, stored and shown — and never applied, because command
//                         windows resolve per user.
//   staleBlueprintLists   what a blueprint save, a blueprint delete or a sealed-template save
//                         strands. A list left behind for a slot or action that no longer exists
//                         attaches itself to whatever a later save gives that name.

import { DATA_KINDS } from '../../packages/retention/src';
import { assertActionScoped } from '../../services/api/src/services/retention-tiers.shared';
import {
  slotActionNames,
  staleBlueprintLists,
} from '../../services/api/src/services/retention-blueprints.service';

describe('assertActionScoped', () => {
  it('refuses the kinds that are kept per user', () => {
    for (const kind of ['command', 'device_event'] as const) {
      expect(() => assertActionScoped(kind)).toThrow(/kept per user/);
      try {
        assertActionScoped(kind);
      } catch (err) {
        expect((err as { statusCode?: number }).statusCode).toBe(400);
      }
    }
  });

  it('admits the kinds whose history belongs to an action', () => {
    const admitted = DATA_KINDS.filter((k) => {
      try {
        assertActionScoped(k);
        return true;
      } catch {
        return false;
      }
    });
    expect(admitted).toEqual(['scalar', 'frame']);
  });
});

describe('slotActionNames', () => {
  it("maps each slot key to its template's entry names", () => {
    const names = slotActionNames([
      {
        key: 'tank_board',
        sealed_template: {
          entries: [{ mqtt_action_name: 'tank_level' }, { mqtt_action_name: 'relay' }],
        },
      },
      { key: 'wall_display', sealed_template: { entries: [] } },
    ]);
    expect([...names.keys()]).toEqual(['tank_board', 'wall_display']);
    expect([...names.get('tank_board')!]).toEqual(['tank_level', 'relay']);
    expect(names.get('wall_display')!.size).toBe(0);
  });
});

describe('staleBlueprintLists', () => {
  const row = (
    slot_key: string,
    action_name: string,
    data_kind: string,
    bucket: string,
    position: number,
  ) => ({
    slot_key,
    action_name,
    data_kind,
    bucket,
    keep_days: bucket === 'raw' ? 14 : 30,
    position,
  });
  const rows = [
    row('tank_board', 'tank_level', 'scalar', 'raw', 0),
    row('tank_board', 'tank_level', 'scalar', '5m', 1),
    row('tank_board', 'relay', 'scalar', 'raw', 0),
    row('cam_board', 'camera', 'frame', 'raw', 0),
  ];
  const keep = (entries: Record<string, string[]>) =>
    new Map(Object.entries(entries).map(([slot, names]) => [slot, new Set(names)]));

  it('keeps every list whose slot still addresses its action', () => {
    const k = keep({ tank_board: ['tank_level', 'relay'], cam_board: ['camera'] });
    expect(staleBlueprintLists(rows, k)).toEqual([]);
  });

  it("returns the whole list of an action the slot's template no longer carries", () => {
    // The slot was pointed at a template without `tank_level`.
    const k = keep({ tank_board: ['relay', 'humidity'], cam_board: ['camera'] });
    expect(staleBlueprintLists(rows, k)).toEqual([
      {
        slotKey: 'tank_board',
        actionName: 'tank_level',
        dataKind: 'scalar',
        tiers: [
          { bucket: 'raw', keepDays: 14, position: 0 },
          { bucket: '5m', keepDays: 30, position: 1 },
        ],
      },
    ]);
  });

  it('strands every list on a removed slot, per action and kind', () => {
    const stale = staleBlueprintLists(rows, keep({ cam_board: ['camera'] }));
    expect(stale.map((l) => `${l.slotKey}/${l.actionName}/${l.dataKind}`)).toEqual([
      'tank_board/tank_level/scalar',
      'tank_board/relay/scalar',
    ]);
  });

  it('treats a renamed slot key as removed', () => {
    // The key is the identity: a list written for `tank_board` must not follow it to `tank_main`.
    const k = keep({ tank_main: ['tank_level', 'relay'], cam_board: ['camera'] });
    expect(staleBlueprintLists(rows, k).map((l) => l.slotKey)).toEqual([
      'tank_board',
      'tank_board',
    ]);
  });

  it('returns every list when the blueprint is deleted', () => {
    expect(staleBlueprintLists(rows, null)).toHaveLength(3);
  });
});
