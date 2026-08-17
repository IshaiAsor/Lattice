// Blueprints (F10.10): the reverse lookup that stops a sealed-template edit stranding a published
// blueprint's action reference.
//
// The collector is pinned here rather than only through the API because its failure mode is an
// omission, not a wrong answer: a place that can address an action but is not collected produces a
// guard that passes, a save that succeeds, and a blueprint that quietly stops working at the next
// derive. Adding an addressing site (a new template entity, a new column pair) means adding it
// here and to `checkTarget`'s call sites in blueprints.admin.validation — this matrix is what says
// so out loud.

import {
  collectActionRefs,
  strandedReferences,
  type AddressingBlueprint,
  type TemplateUsage,
} from '../../services/api/src/services/sealed-templates.usage';

const blueprint: AddressingBlueprint = {
  scenes: [
    {
      key: 'stop_all',
      members: [
        { slot_key: 'sockets', action_name: 'i2c_socket_8' },
        { slot_key: 'sockets', action_name: 'i2c_socket_8_2' },
      ],
    },
  ],
  rules: [
    {
      key: 'refill',
      conditions: [
        { slot_key: 'tank', action_name: 'water_level' },
        // A schedule condition: no device, no action — nothing an entry edit can strand.
        { slot_key: null, action_name: null },
      ],
      actions: [{ slot_key: 'sockets', action_name: 'i2c_socket_8' }],
    },
  ],
  pipelines: [
    {
      key: 'watch',
      sensors: [{ slot_key: 'tank', action_name: 'water_level' }],
      triggers: [{ slot_key: 'tank', action_name: 'water_level' }],
    },
  ],
};

const usage = (refs = collectActionRefs(blueprint)): TemplateUsage => ({
  blueprint_id: 1,
  key: 'tank_loop',
  name: 'Tank Loop',
  status: 'published',
  slot_keys: ['sockets', 'tank'],
  refs,
  stranded: [],
});

describe('collectActionRefs', () => {
  it('collects an action reference from every place a blueprint can hold one', () => {
    expect(collectActionRefs(blueprint).map((r) => r.where)).toEqual([
      'scene "stop_all" member',
      'scene "stop_all" member',
      'rule "refill" condition',
      'rule "refill" action',
      'pipeline "watch" sensor',
      'pipeline "watch" trigger',
    ]);
  });

  it('ignores a row that addresses no action, like a schedule condition', () => {
    expect(collectActionRefs(blueprint).filter((r) => r.where.includes('condition'))).toEqual([
      { slot_key: 'tank', action_name: 'water_level', where: 'rule "refill" condition' },
    ]);
  });

  it('carries the slot and action of each reference, not just where it came from', () => {
    expect(collectActionRefs(blueprint)[0]).toEqual({
      slot_key: 'sockets',
      action_name: 'i2c_socket_8',
      where: 'scene "stop_all" member',
    });
  });
});

describe('strandedReferences', () => {
  const names = (...n: string[]) => new Set(n);

  it('says nothing when the entry set still provides every referenced action', () => {
    expect(
      strandedReferences(usage(), names('i2c_socket_8', 'i2c_socket_8_2', 'water_level')),
    ).toEqual([]);
  });

  it('reports every reference the entry set no longer provides', () => {
    // Dropping one socket entry: the scene member that named it is the only casualty, and the
    // three water_level references are untouched.
    const problems = strandedReferences(usage(), names('i2c_socket_8', 'water_level'));
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('i2c_socket_8_2');
  });

  it('names the blueprint, its status and the exact place, so the admin can go and fix it', () => {
    const [problem] = strandedReferences(usage(), names('i2c_socket_8', 'i2c_socket_8_2'));
    expect(problem).toBe(
      '"Tank Loop" (published) — rule "refill" condition addresses "water_level" on slot "tank"',
    );
  });

  it('reports a renamed action once per place that addresses it', () => {
    // water_level appears in a rule condition, a pipeline sensor and a pipeline trigger. A rename
    // breaks all three, and naming only the first would send the admin back for the other two.
    expect(strandedReferences(usage(), names('i2c_socket_8', 'i2c_socket_8_2'))).toHaveLength(3);
  });
});
