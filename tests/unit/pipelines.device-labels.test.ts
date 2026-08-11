// Pipeline context labelling (F11.7). What the model reads for a multi-device group is nested under
// each device's label, so two devices sharing one label do not merely read oddly — one of them
// disappears from the context entirely, which is the exact silent-overwrite bug the per-device block
// was built to fix.
//
// The collision is the common case rather than an edge one: a binding's label is optional, and an
// unlabelled one falls back to the *device's* name — which for two boards of the same sealed type is
// the same string. A garden of three identical socket boards would show the model one of them.
//
// Pure map-in, map-out, so the rule is pinned here rather than inside a pipeline run.

import { uniqueLabels } from '../../services/ml-router/src/pipeline/registry';

describe('uniqueLabels', () => {
  it('keeps distinct labels exactly as they are', () => {
    const out = uniqueLabels([
      { deviceId: 41, label: 'Pot 1' },
      { deviceId: 44, label: 'Pot 2' },
    ]);
    expect([...out.entries()]).toEqual([
      [41, 'Pot 1'],
      [44, 'Pot 2'],
    ]);
  });

  it('disambiguates two devices that share a label', () => {
    // Both unlabelled, both the same sealed type — so both fell back to the same device name.
    const out = uniqueLabels([
      { deviceId: 41, label: 'MULTI_SOCKET_8_CH' },
      { deviceId: 44, label: 'MULTI_SOCKET_8_CH' },
    ]);
    expect(out.get(41)).toBe('MULTI_SOCKET_8_CH #41');
    expect(out.get(44)).toBe('MULTI_SOCKET_8_CH #44');
    expect(new Set(out.values()).size).toBe(2);
  });

  it('leaves a single device alone even when it repeats across sensors', () => {
    // One device contributes several sensors to a group; that is not a collision, and suffixing it
    // would make the context noisier for the overwhelmingly common single-device case.
    const out = uniqueLabels([
      { deviceId: 41, label: 'Tank board' },
      { deviceId: 41, label: 'Tank board' },
    ]);
    expect([...out.entries()]).toEqual([[41, 'Tank board']]);
  });

  it('disambiguates every member of a three-way collision', () => {
    const out = uniqueLabels([
      { deviceId: 1, label: 'Board' },
      { deviceId: 2, label: 'Board' },
      { deviceId: 3, label: 'Board' },
    ]);
    expect([...out.values()]).toEqual(['Board #1', 'Board #2', 'Board #3']);
  });

  it('handles an empty sensor list', () => {
    expect(uniqueLabels([]).size).toBe(0);
  });
});
