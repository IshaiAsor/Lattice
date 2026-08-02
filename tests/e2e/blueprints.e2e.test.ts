// E2E: blueprints domain (F10.2–F10.4) — a blueprint is authored, published, derived against a
// real sealed sim fleet, and then tuned:
//   import → publish gate → slot match → derive (area + bindings + scenes/rules/pipelines)
//   → phase change → override precedence → cleanup.
//
// The load-bearing assertion is that a derived rule stores a *reference*, and that changing the
// phase or setting an override changes what it resolves to **without rewriting the rule row**.
// That is the whole redesign; if it regresses, reconcile and phase advance start clobbering
// each other again.
//
// Storage is only half of it, and this suite used to test only that half. A reference is worth
// nothing unless the code that acts on it resolves it, so the derived entities are also *run*
// here — a scene is executed and asserted at the sim board, and a pipeline trigger is crossed
// with real telemetry. Both of those paths shipped unresolved and neither shape assertion
// noticed, because an unresolved reference does not throw: it is dispatched as text, or
// compared as text, and the failure is a snackbar or a silence.
//
// Mutating (sealed templates, blueprint, instance, devices) with full cleanup. Admin-only
// endpoints are used for authoring, so this suite needs an admin token.

import {
  SimDevice,
  itStack,
  stackUp,
  login,
  apiGet,
  apiPost,
  apiPut,
  apiPatch,
  apiRaw,
  apiDelete,
  simOpts,
  poll,
} from './helpers/stack';

jest.setTimeout(120000);

const SUFFIX = Date.now().toString(36);
const TANK_TEMPLATE = `E2E Tank Board ${SUFFIX}`;
const SOCKET_TEMPLATE = `E2E Socket Board ${SUFFIX}`;
const BLUEPRINT_KEY = `e2e_tank_${SUFFIX}`;
const INSTANCE_NAME = `E2E Tank Loop ${SUFFIX}`;

// Sealed catalog identities that carry the capabilities this vertical needs. Both expose the
// full generic capability set (the catalog is firmware-generated), so the template selects.
const TANK_TYPE = 'HYDRO_FARM_WATER_TANK_MANAGER';
const SOCKET_TYPE = 'MULTI_SOCKET_8_CH';

function blueprintDoc() {
  return {
    key: BLUEPRINT_KEY,
    name: `E2E Tank Loop ${SUFFIX}`,
    slots: [
      { key: 'tank', label: 'Tank monitor', sealed_template: TANK_TEMPLATE },
      { key: 'sockets', label: 'Socket board', sealed_template: SOCKET_TEMPLATE },
    ],
    params: [
      { key: 'level.min', label: 'Refill below', default_value: '20', unit: '%' },
      // Lowercase on purpose. A fixed param's value is dispatched verbatim and checked against
      // the capability's valid_parameters, whose OnOff enum is ["on","off"] and is matched
      // case-sensitively — "ON" here would be a command every device rejects, which is exactly
      // the bug the execution tests below exist to catch.
      { key: 'pump.state', label: 'Pump on value', default_value: 'on', user_tunable: false },
      { key: 'pump.off', label: 'Pump off value', default_value: 'off', user_tunable: false },
    ],
    phases: [
      {
        key: 'commissioning',
        name: 'Commissioning',
        ordinal: 1,
        duration_value: 2,
        duration_unit: 'days',
        auto_advance: true,
        targets: [{ param_key: 'level.min', value: '40' }],
      },
      // No target for level.min ⇒ it must fall through to the blueprint default (20).
      { key: 'steady', name: 'Steady state', ordinal: 2, auto_advance: false },
    ],
    scenes: [
      {
        key: 'stop_all',
        name: `Stop the loop ${SUFFIX}`,
        // One member by reference, one literal — a scene has to dispatch both correctly, and
        // only the reference exercises resolution at execute time.
        members: [
          { slot_key: 'sockets', action_name: 'i2c_socket_8', target_state: '@param.pump.off' },
          { slot_key: 'sockets', action_name: 'i2c_socket_8_2', target_state: 'off' },
        ],
      },
    ],
    rules: [
      {
        key: 'refill_tank',
        name: `Refill the tank ${SUFFIX}`,
        cooldown_seconds: 300,
        conditions: [
          {
            condition_type: 'threshold',
            slot_key: 'tank',
            action_name: 'water_level',
            operator: '<',
            threshold_value: '@phase.level.min',
          },
        ],
        actions: [
          { slot_key: 'sockets', action_name: 'i2c_socket_8', target_state: '@param.pump.state' },
        ],
      },
    ],
    pipelines: [
      {
        key: 'tank_watch',
        name: `Tank watch ${SUFFIX}`,
        sensors: [
          {
            group_name: 'tank',
            description: 'Liquid level in the tank',
            slot_key: 'tank',
            action_name: 'water_level',
            min_value: '@phase.level.min',
          },
        ],
        // enrich-only: no model, so the run is deterministic and needs no LLM on the stack.
        stages: [{ ordinal: 1, kind: 'enrich' }],
        triggers: [
          {
            trigger_type: 'sensor_threshold',
            slot_key: 'tank',
            action_name: 'water_level',
            operator: '<',
            // A reference, not a number. Unresolved, evaluateThreshold parses it to NaN and falls
            // back to string equality against the reading — the trigger then never fires, with no
            // error anywhere. That silence is why this needs an execution test, not a shape one.
            threshold_value: '@phase.level.min',
            min_interval_sec: 1,
          },
        ],
      },
    ],
  };
}

describe('blueprints e2e (F10)', () => {
  let token: string;
  let tankDev: any;
  let socketDev: any;
  let socketDev2: any; // second board of the same sealed type — feeds the multi-device slot test
  const templateIds: number[] = [];
  let blueprintId: number | undefined;
  let instanceId: number | undefined;
  let multiBlueprintId: number | undefined;
  let multiInstanceId: number | undefined;
  let scopeBlueprintId: number | undefined;
  let scopeInstanceId: number | undefined;
  let noPhaseBlueprintId: number | undefined;
  let noPhaseInstanceId: number | undefined;

  beforeAll(async () => {
    if (!(await stackUp())) return;
    token = await login();

    // Two released sealed templates. The socket board deliberately activates the SAME capability
    // twice — that is what makes (slot_key, action_name) addressing necessary and capability_key
    // insufficient, so the fixture has to reproduce it.
    const specs = [
      {
        name: TANK_TEMPLATE,
        targets: [{ device_type: TANK_TYPE, version_min: 'v0.0.1', version_max: 'v99.0.0' }],
        entries: [
          {
            capability_key: 'water_level',
            action_label: 'Tank level',
            pins: [{ pin_slot_key: 'adc', pin_number: 4 }],
            behaviors: [{ behavior: 'interval', interval_ms: 30000 }],
          },
        ],
      },
      {
        name: SOCKET_TEMPLATE,
        targets: [{ device_type: SOCKET_TYPE, version_min: 'v0.0.1', version_max: 'v99.0.0' }],
        entries: [0, 1].map((channel) => ({
          capability_key: 'i2c_socket_8',
          action_label: `Socket ${channel + 1}`,
          sort_order: channel,
          pins: [
            { pin_slot_key: 'sda', pin_number: 8 },
            { pin_slot_key: 'scl', pin_number: 9 },
            { pin_slot_key: 'address', pin_number: 32 },
            { pin_slot_key: 'channel', pin_number: channel },
          ],
          behaviors: [{ behavior: 'command' }],
        })),
      },
    ];

    for (const spec of specs) {
      const created = await apiPost('/api/admin/catalog/sealed/templates', token, {
        name: spec.name,
      });
      templateIds.push(created.id);
      await apiPatch(`/api/admin/catalog/sealed/templates/${created.id}`, token, {
        targets: spec.targets,
        entries: spec.entries,
      });
      await apiPost(`/api/admin/catalog/sealed/templates/${created.id}/release`, token, {});
    }

    // Sealed devices take their whole config from the released template on provision — the sim
    // skips self-activation, so this also proves the materialization path derive depends on.
    tankDev = new SimDevice(
      simOpts({ mac: `SIM-E2E-BP-T-${SUFFIX}`, deviceType: TANK_TYPE, autoTelemetry: false }),
    );
    socketDev = new SimDevice(
      simOpts({ mac: `SIM-E2E-BP-S-${SUFFIX}`, deviceType: SOCKET_TYPE, autoTelemetry: false }),
    );
    socketDev2 = new SimDevice(
      simOpts({ mac: `SIM-E2E-BP-S2-${SUFFIX}`, deviceType: SOCKET_TYPE, autoTelemetry: false }),
    );
    await tankDev.start();
    await socketDev.start();
    await socketDev2.start();
  });

  afterAll(async () => {
    if (!token) return;
    if (noPhaseInstanceId)
      await apiDelete(`/api/blueprints/instances/${noPhaseInstanceId}`, token).catch(() => {});
    if (noPhaseBlueprintId)
      await apiDelete(`/api/admin/blueprints/${noPhaseBlueprintId}`, token).catch(() => {});
    if (scopeInstanceId)
      await apiDelete(`/api/blueprints/instances/${scopeInstanceId}`, token).catch(() => {});
    if (scopeBlueprintId)
      await apiDelete(`/api/admin/blueprints/${scopeBlueprintId}`, token).catch(() => {});
    if (multiInstanceId)
      await apiDelete(`/api/blueprints/instances/${multiInstanceId}`, token).catch(() => {});
    if (multiBlueprintId)
      await apiDelete(`/api/admin/blueprints/${multiBlueprintId}`, token).catch(() => {});
    if (instanceId)
      await apiDelete(`/api/blueprints/instances/${instanceId}`, token).catch(() => {});
    if (blueprintId) await apiDelete(`/api/admin/blueprints/${blueprintId}`, token).catch(() => {});
    // cleanup(), not stop(): the device rows must go too, or a failed run leaves sealed devices
    // behind that make the next run's slots ambiguous.
    await tankDev?.cleanup?.().catch?.(() => {});
    await socketDev?.cleanup?.().catch?.(() => {});
    await socketDev2?.cleanup?.().catch?.(() => {});
    for (const id of templateIds) {
      await apiDelete(`/api/admin/catalog/sealed/templates/${id}`, token).catch(() => {});
    }
  });

  itStack('refuses to publish a blueprint whose action is not on the slot template', async () => {
    const bad = blueprintDoc();
    bad.key = `${BLUEPRINT_KEY}_bad`;
    bad.name = `${bad.name} (bad)`;
    // The tank template provides water_level only — this is the class of typo that used to
    // publish clean and then resolve to nothing at derive time.
    bad.rules[0]!.conditions[0]!.action_name = 'i2c_socket_8';

    const imported = await apiPost('/api/admin/blueprints/import', token, bad);
    const { status, body } = await apiRaw(
      'POST',
      `/api/admin/blueprints/${imported.id}/publish`,
      token,
    );
    expect(status).toBe(400);
    expect(body.details.join('\n')).toContain('which sealed template');
    expect(body.details.join('\n')).toContain('water_level');

    await apiDelete(`/api/admin/blueprints/${imported.id}`, token);
  });

  itStack('imports and publishes a valid blueprint', async () => {
    const imported = await apiPost('/api/admin/blueprints/import', token, blueprintDoc());
    blueprintId = imported.id;
    expect(imported.status).toBe('draft'); // publishing is always an explicit, validated act

    const validation = await apiGet(`/api/admin/blueprints/${blueprintId}/validate`, token);
    expect(validation).toEqual({ valid: true, problems: [] });

    const published = await apiPost(`/api/admin/blueprints/${blueprintId}/publish`, token, {});
    expect(published.status).toBe('published');
  });

  itStack('offers each slot the devices its sealed template covers', async () => {
    const preview = await apiGet(`/api/blueprints/${blueprintId}/preview`, token);
    expect(preview.unmet).toEqual([]);

    // Asserted as membership, not equality: the shared stack may hold other devices of the same
    // sealed type, and a slot matching several of them is a legitimate state (the wizard asks).
    const tank = preview.slots.find((s: any) => s.slot_key === 'tank');
    const sockets = preview.slots.find((s: any) => s.slot_key === 'sockets');
    expect(tank.candidates.map((c: any) => c.user_device_id)).toContain(tankDev.deviceId);
    expect(sockets.candidates.map((c: any) => c.user_device_id)).toContain(socketDev.deviceId);
    // The socket board must not be offered for the tank slot: they target different types.
    expect(tank.candidates.map((c: any) => c.user_device_id)).not.toContain(socketDev.deviceId);

    // auto_bind is the "fill this slot without asking" shortcut: the devices derive would take on
    // its own. For a single-device slot that is the sole candidate, or empty when ambiguous.
    expect(tank.auto_bind).toEqual(tank.candidates.length === 1 ? [tankDev.deviceId] : []);
  });

  itStack('refuses a binding whose device does not match the slot', async () => {
    const { status, body } = await apiRaw('POST', `/api/blueprints/${blueprintId}/derive`, token, {
      name: `${INSTANCE_NAME} (mismatch)`,
      bindings: [
        // The socket board offered for the tank slot — wrong sealed template entirely.
        { slot_key: 'tank', user_device_id: socketDev.deviceId },
        { slot_key: 'sockets', user_device_id: socketDev.deviceId },
      ],
    });
    expect(status).toBe(400);
    expect(body.error).toContain('does not match slot "tank"');
  });

  itStack('derives an instance with an area, bindings and every templated entity', async () => {
    const result = await apiPost(`/api/blueprints/${blueprintId}/derive`, token, {
      name: INSTANCE_NAME,
      // Explicit, so the suite is deterministic whatever else is provisioned on the stack.
      bindings: [
        { slot_key: 'tank', user_device_id: tankDev.deviceId },
        { slot_key: 'sockets', user_device_id: socketDev.deviceId },
      ],
    });
    instanceId = result.instance_id;

    // Deriving builds the setup; it does not start it (F10.13). No phase is entered and no clock
    // runs until the user says the real process has begun.
    expect(result.lifecycle_state).toBe('not_started');
    expect(result.current_phase).toBeNull();
    expect(result.first_phase).toBe('commissioning');
    expect(result.created).toEqual({ scenes: 1, rules: 1, pipelines: 1 });
    // Explicit picks are recorded as such — auto_bound distinguishes "the system chose" from
    // "the user chose", which is what the instance page shows and reconcile respects.
    expect(result.bindings.every((b: any) => b.auto_bound === false)).toBe(true);
    expect(result.bindings.map((b: any) => b.slot_key).sort()).toEqual(['sockets', 'tank']);

    // The devices are grouped, which is the visible half of a derive.
    const devices = await apiGet('/api/devices', token);
    const bound = devices.filter((d: any) => [tankDev.deviceId, socketDev.deviceId].includes(d.id));
    expect(bound).toHaveLength(2);
    expect(bound.every((d: any) => d.area_id === result.area_id)).toBe(true);
  });

  itStack('starts the setup, entering the phase the user names', async () => {
    // Everything below this point exercises a *live* setup, so the suite starts it here — which is
    // itself the first assertion that starting works.
    const instance = await apiPost(`/api/blueprints/instances/${instanceId}/start`, token, {
      phase_key: 'commissioning',
    });
    expect(instance.lifecycle_state).toBe('running');
    expect(instance.current_phase.key).toBe('commissioning');
    expect(instance.phases.find((p: any) => p.key === 'commissioning').started_at).not.toBeNull();
  });

  // ── Reference storage, and the dispatch that must undo it ────────────────
  //
  // These two tests are a pair and must stay one. "Stored verbatim" is only half the contract:
  // on its own it is satisfied by a platform that stores references and then never resolves
  // them — which is exactly what shipped, because every consumer had to opt in to resolution
  // and two of them (scene execution, pipeline trigger matching) never did. Whenever a new
  // reference-bearing field is added here, its dispatch site gets a test below, not just this
  // one.

  itStack('stores references verbatim in every derived entity, not resolved values', async () => {
    const derivedRule = (await apiGet('/api/rules', token)).find(
      (r: any) => r.name === `Refill the tank ${SUFFIX}`,
    );
    expect(derivedRule).toBeDefined();
    expect(derivedRule.conditions[0].threshold_value).toBe('@phase.level.min');
    expect(derivedRule.actions[0].target_state).toBe('@param.pump.state');

    const derivedScene = (await apiGet('/api/scenes', token)).find(
      (s: any) => s.name === `Stop the loop ${SUFFIX}`,
    );
    expect(derivedScene).toBeDefined();
    const byRef = derivedScene.members.find((m: any) => m.target_state.startsWith('@'));
    expect(byRef?.target_state).toBe('@param.pump.off');
    // The literal member is stored as-is, so execution has to handle both shapes.
    expect(derivedScene.members.map((m: any) => m.target_state).sort()).toEqual([
      '@param.pump.off',
      'off',
    ]);
  });

  itStack(
    'runs a derived scene, resolving a @param member into a real device command',
    async () => {
      const scene = (await apiGet('/api/scenes', token)).find(
        (s: any) => s.name === `Stop the loop ${SUFFIX}`,
      );

      // Asserted at the board, not at the API: a 202 is returned before anything is dispatched,
      // so status alone cannot tell a working scene from one whose members are rejected.
      const fromRef = socketDev.waitFor(
        'command',
        (c: any) => c.action === 'i2c_socket_8' && c.value === 'off',
        20000,
      );
      const fromLiteral = socketDev.waitFor(
        'command',
        (c: any) => c.action === 'i2c_socket_8_2' && c.value === 'off',
        20000,
      );

      const run = await apiRaw('POST', `/api/scenes/${scene.id}/execute`, token, {});
      expect(run.status).toBe(202);
      expect(run.body.queued).toBe(2); // both members dispatched — neither dropped as unresolvable

      expect((await fromRef).valid).toBe(true);
      expect((await fromLiteral).valid).toBe(true);

      // …and the device's ack was accepted, which is the half that fails when a resolved value is
      // outside the capability's valid_parameters (e.g. "OFF" against the OnOff enum).
      await poll(
        () => apiGet('/api/actions', token),
        (actions: any[]) =>
          actions.find(
            (a: any) => a.deviceId === socketDev.deviceId && a.mqttName === 'i2c_socket_8',
          )?.state === 'off',
        { timeoutMs: 20000 },
      );
    },
  );

  itStack('fires a pipeline whose trigger threshold is a phase reference', async () => {
    const pipeline = (await apiGet('/api/pipelines', token)).find(
      (p: any) => p.name === `Tank watch ${SUFFIX}`,
    );
    expect(pipeline).toBeDefined();

    const before = (await apiGet(`/api/pipelines/${pipeline.id}/runs`, token)).length;

    // Commissioning sets level.min = 40, so the stored '@phase.level.min' has to resolve to 40
    // for a reading of 10 to be under it.
    tankDev.publishTelemetry('water_level', 10);

    const runs = await poll(
      () => apiGet(`/api/pipelines/${pipeline.id}/runs`, token),
      (rs: any[]) => rs.length > before,
      { timeoutMs: 25000 },
    );
    expect(runs[0].trigger_type).toBe('sensor_threshold');
  });

  itStack('does not fire that pipeline for a reading above the resolved threshold', async () => {
    const pipeline = (await apiGet('/api/pipelines', token)).find(
      (p: any) => p.name === `Tank watch ${SUFFIX}`,
    );
    // Past the 1s cooldown from the previous fire, so a non-fire here is the threshold's doing.
    await new Promise((r) => setTimeout(r, 1500));
    const before = (await apiGet(`/api/pipelines/${pipeline.id}/runs`, token)).length;

    // 80 > 40. Guards the other direction: a resolver that returned something falsy would make
    // the comparison pass for everything, and the positive test alone would not notice.
    tankDev.publishTelemetry('water_level', 80);
    await new Promise((r) => setTimeout(r, 6000));

    const after = (await apiGet(`/api/pipelines/${pipeline.id}/runs`, token)).length;
    expect(after).toBe(before);
  });

  itStack('resolves a param through phase → default → override, in that order', async () => {
    // Commissioning sets level.min = 40.
    let instance = await apiGet(`/api/blueprints/instances/${instanceId}`, token);
    let levelMin = instance.params.find((p: any) => p.key === 'level.min');
    expect(levelMin.value).toBe('40');
    expect(levelMin.source).toBe('phase');

    const ruleBefore = (await apiGet('/api/rules', token)).find(
      (r: any) => r.name === `Refill the tank ${SUFFIX}`,
    );

    // Steady sets no target for level.min, so it falls through to the blueprint default (20).
    instance = await apiPut(`/api/blueprints/instances/${instanceId}/phase`, token, {
      phase_key: 'steady',
    });
    levelMin = instance.params.find((p: any) => p.key === 'level.min');
    expect(instance.current_phase.key).toBe('steady');
    expect(levelMin.value).toBe('20');
    expect(levelMin.source).toBe('default');

    // A user override beats both, in every phase.
    instance = await apiPut(`/api/blueprints/instances/${instanceId}/params/level.min`, token, {
      value: '55',
    });
    levelMin = instance.params.find((p: any) => p.key === 'level.min');
    expect(levelMin.value).toBe('55');
    expect(levelMin.source).toBe('override');

    // …and clearing it restores the blueprint's intent exactly.
    instance = await apiPut(`/api/blueprints/instances/${instanceId}/params/level.min`, token, {
      value: null,
    });
    expect(instance.params.find((p: any) => p.key === 'level.min').value).toBe('20');

    // THE point: three resolution changes, and the rule row was never rewritten.
    const ruleAfter = (await apiGet('/api/rules', token)).find(
      (r: any) => r.name === `Refill the tank ${SUFFIX}`,
    );
    expect(ruleAfter.conditions[0].threshold_value).toBe('@phase.level.min');
    expect(ruleAfter.conditions[0].id).toBe(ruleBefore.conditions[0].id);
    expect(ruleAfter.actions[0].id).toBe(ruleBefore.actions[0].id);
  });

  itStack('refuses to override a param the blueprint marked phase-driven', async () => {
    const { status, body } = await apiRaw(
      'PUT',
      `/api/blueprints/instances/${instanceId}/params/pump.state`,
      token,
      { value: 'OFF' },
    );
    expect(status).toBe(400);
    expect(body.error).toContain('phase-driven');
  });

  // ── Phase timers (F10.12) ────────────────────────────────────────────────
  //
  // Leaving a phase banks the time spent in it, so re-entering can resume rather than restart.
  // Before this, rolling a phase back silently reset it — five days into a seven-day phase became
  // seven days again, with nowhere to record that those days happened.

  itStack('banks the time spent in a phase when the setup leaves it', async () => {
    // The suite has been sitting in `steady` since the resolution test above, so it has a run to
    // bank. One second of sleep makes the bank a number rather than a rounding question.
    await new Promise((r) => setTimeout(r, 1100));

    const instance = await apiPut(`/api/blueprints/instances/${instanceId}/phase`, token, {
      phase_key: 'commissioning',
      timer: 'reset',
    });

    const steady = instance.phases.find((p: any) => p.key === 'steady');
    const commissioning = instance.phases.find((p: any) => p.key === 'commissioning');
    expect(steady.accrued_seconds).toBeGreaterThan(0);
    // Not current, so its elapsed is the bank alone and it stops moving.
    expect(steady.elapsed_seconds).toBe(steady.accrued_seconds);
    expect(steady.started_at).toBeNull();
    // The entered phase was reset, and is the one now running.
    expect(commissioning.accrued_seconds).toBe(0);
    expect(commissioning.is_current).toBe(true);
    expect(commissioning.started_at).not.toBeNull();
  });

  itStack('resumes a phase from its bank rather than restarting it', async () => {
    const before = await apiGet(`/api/blueprints/instances/${instanceId}`, token);
    const banked = before.phases.find((p: any) => p.key === 'steady').accrued_seconds;
    expect(banked).toBeGreaterThan(0);

    const instance = await apiPut(`/api/blueprints/instances/${instanceId}/phase`, token, {
      phase_key: 'steady',
      timer: 'resume',
    });

    const steady = instance.phases.find((p: any) => p.key === 'steady');
    expect(steady.is_current).toBe(true);
    expect(steady.accrued_seconds).toBe(banked); // the bank survived the round trip
    expect(steady.elapsed_seconds).toBeGreaterThanOrEqual(banked); // …and the run continues on top
  });

  itStack('starts a phase at a point the caller names', async () => {
    const instance = await apiPut(`/api/blueprints/instances/${instanceId}/phase`, token, {
      phase_key: 'steady',
      timer: 'at',
      elapsed_seconds: 3600,
    });

    const steady = instance.phases.find((p: any) => p.key === 'steady');
    expect(steady.accrued_seconds).toBe(3600);
    expect(steady.elapsed_seconds).toBeGreaterThanOrEqual(3600);
  });

  itStack('resets a phase to zero, discarding what it had banked', async () => {
    const instance = await apiPut(`/api/blueprints/instances/${instanceId}/phase`, token, {
      phase_key: 'steady',
      timer: 'reset',
    });
    expect(instance.phases.find((p: any) => p.key === 'steady').accrued_seconds).toBe(0);
  });

  itStack('rejects a malformed timer request rather than guessing at it', async () => {
    const bad = await apiRaw('PUT', `/api/blueprints/instances/${instanceId}/phase`, token, {
      phase_key: 'steady',
      timer: 'rewind',
    });
    expect(bad.status).toBe(400);
    expect(bad.body.error).toContain('timer must be');

    const missing = await apiRaw('PUT', `/api/blueprints/instances/${instanceId}/phase`, token, {
      phase_key: 'steady',
      timer: 'at',
    });
    expect(missing.status).toBe(400);
    expect(missing.body.error).toContain('elapsed_seconds');

    // Resuming the phase you are already in has no earlier visit to resume.
    const current = await apiGet(`/api/blueprints/instances/${instanceId}`, token);
    const sameAgain = await apiRaw('PUT', `/api/blueprints/instances/${instanceId}/phase`, token, {
      phase_key: current.current_phase.key,
      timer: 'resume',
    });
    expect(sameAgain.status).toBe(400);
    expect(sameAgain.body.error).toContain('already in');
  });

  // ── Lifecycle: start / stop / reset (F10.13) ─────────────────────────────
  //
  // A stopped setup does *nothing* — not its unscoped rules, not its scenes, not its emergencies.
  // That is the whole point of the switch, and it is the assertion most worth pinning: the phase
  // gate alone would let an unscoped automation keep firing.

  itStack('holds a scene while the setup is stopped, and releases it on start', async () => {
    const sceneName = `Stop the loop ${SUFFIX}`;
    const scene = (await apiGet('/api/scenes', token)).find((s: any) => s.name === sceneName);
    expect(scene).toBeDefined();
    // Unscoped, so the phase gate alone would never hold it — only the lifecycle can.
    expect(scene.phase_scope).toEqual([]);
    expect(scene.in_phase).toBe(true);

    const stopped = await apiPost(`/api/blueprints/instances/${instanceId}/stop`, token, {});
    expect(stopped.lifecycle_state).toBe('stopped');
    // The phase is remembered and its clock parked, so starting again can carry on.
    expect(stopped.current_phase).not.toBeNull();
    expect(stopped.phases.find((p: any) => p.is_current).started_at).toBeNull();

    const held = (await apiGet('/api/scenes', token)).find((s: any) => s.name === sceneName);
    expect(held.in_phase).toBe(false);
    const refused = await apiRaw('POST', `/api/scenes/${scene.id}/execute`, token, {});
    expect(refused.status).toBe(409);
    expect(refused.body.error).toContain('not running');

    const started = await apiPost(`/api/blueprints/instances/${instanceId}/start`, token, {
      timer: 'resume',
    });
    expect(started.lifecycle_state).toBe('running');
    const live = (await apiGet('/api/scenes', token)).find((s: any) => s.name === sceneName);
    expect(live.in_phase).toBe(true);
  });

  itStack('banks the run when stopped, and carries on from it when started again', async () => {
    // Arrive on a clean, running `steady`: the previous test left the setup running elsewhere.
    await apiPut(`/api/blueprints/instances/${instanceId}/phase`, token, {
      phase_key: 'steady',
      timer: 'reset',
    });
    await new Promise((r) => setTimeout(r, 1100));

    const stopped = await apiPost(`/api/blueprints/instances/${instanceId}/stop`, token, {});
    const banked = stopped.phases.find((p: any) => p.key === 'steady').accrued_seconds;
    expect(banked).toBeGreaterThan(0);
    // Parked: elapsed is the bank and nothing more, because no run is in flight.
    expect(stopped.phases.find((p: any) => p.key === 'steady').elapsed_seconds).toBe(banked);

    const resumed = await apiPost(`/api/blueprints/instances/${instanceId}/start`, token, {
      timer: 'resume',
    });
    expect(resumed.current_phase.key).toBe('steady'); // remembered, so no argument was needed
    expect(resumed.phases.find((p: any) => p.key === 'steady').accrued_seconds).toBe(banked);
  });

  itStack('lists a setup with the lifecycle needed to read it without opening it', async () => {
    // The setups list is the page a user lands on, so it has to answer "is this doing anything?"
    // — a list of names alone cannot tell a running setup from a parked one.
    await apiPost(`/api/blueprints/instances/${instanceId}/stop`, token, {});
    let row = (await apiGet('/api/blueprints/instances', token)).find(
      (r: any) => r.id === instanceId,
    );
    expect(row.lifecycle_state).toBe('stopped');
    expect(row.has_phases).toBe(true);
    expect(row.current_phase.key).toBe('steady'); // remembered while parked
    expect(row.started_at).toBeNull(); // …with its clock stopped
    expect(row.elapsed_seconds).toBe(row.accrued_seconds); // frozen at the bank

    await apiPost(`/api/blueprints/instances/${instanceId}/start`, token, { timer: 'resume' });
    row = (await apiGet('/api/blueprints/instances', token)).find((r: any) => r.id === instanceId);
    expect(row.lifecycle_state).toBe('running');
    expect(row.started_at).not.toBeNull();
  });

  itStack('refuses a phase change while the setup is not running', async () => {
    await apiPost(`/api/blueprints/instances/${instanceId}/stop`, token, {});
    const refused = await apiRaw('PUT', `/api/blueprints/instances/${instanceId}/phase`, token, {
      phase_key: 'commissioning',
    });
    expect(refused.status).toBe(400);
    expect(refused.body.error).toContain('not running');

    // …and starting is the way in, taking the same phase and position arguments.
    const started = await apiPost(`/api/blueprints/instances/${instanceId}/start`, token, {
      phase_key: 'commissioning',
      timer: 'at',
      elapsed_seconds: 7200,
    });
    expect(started.current_phase.key).toBe('commissioning');
    expect(started.phases.find((p: any) => p.key === 'commissioning').accrued_seconds).toBe(7200);
  });

  itStack('resets to never-started, discarding the banks but keeping the setup', async () => {
    const reset = await apiPost(
      `/api/blueprints/instances/${instanceId}/reset-lifecycle`,
      token,
      {},
    );
    expect(reset.lifecycle_state).toBe('not_started');
    expect(reset.current_phase).toBeNull();
    expect(reset.phase_started_at).toBeNull();
    expect(reset.phases.every((p: any) => p.accrued_seconds === 0)).toBe(true);
    // Destructive about time and nothing else — the devices and the derived automations remain.
    expect(reset.bindings).toHaveLength(2);
    expect(reset.entities.rules.length).toBeGreaterThan(0);

    // Put the suite back on a running setup for everything that follows.
    const started = await apiPost(`/api/blueprints/instances/${instanceId}/start`, token, {
      phase_key: 'steady',
    });
    expect(started.current_phase.key).toBe('steady');
  });

  itStack('rejects a malformed or contradictory lifecycle request', async () => {
    const already = await apiRaw(
      'POST',
      `/api/blueprints/instances/${instanceId}/start`,
      token,
      {},
    );
    expect(already.status).toBe(400);
    expect(already.body.error).toContain('already running');

    const badPhase = await apiRaw('POST', `/api/blueprints/instances/${instanceId}/start`, token, {
      phase_key: 'harvest',
    });
    expect(badPhase.status).toBe(400);
  });

  itStack('leaves every automation row untouched by a timer change', async () => {
    // The load-bearing invariant, restated for the timer paths: banks are their own rows.
    const rule = (await apiGet('/api/rules', token)).find(
      (r: any) => r.name === `Refill the tank ${SUFFIX}`,
    );
    expect(rule.conditions[0].threshold_value).toBe('@phase.level.min');
  });
  // ── Reconcile (F10.6) ────────────────────────────────────────────────────
  //
  // The acceptance test for the whole redesign: a v2 must reach a live setup without touching
  // what the user changed. If these pass, reconcile and user intent are not fighting.

  itStack('marks a derived rule the user edits as drift', async () => {
    const rule = (await apiGet('/api/rules', token)).find(
      (r: any) => r.name === `Refill the tank ${SUFFIX}`,
    );
    await apiPut(`/api/rules/${rule.id}`, token, {
      name: `Refill the tank ${SUFFIX} (edited)`,
      condition_operator: 'AND',
      cooldown_seconds: 900,
      conditions: rule.conditions.map((c: any) => ({ ...c })),
      actions: rule.actions.map((a: any) => ({
        user_device_action_id: a.user_device_action_id,
        target_state: a.target_state,
        delay_seconds: a.delay_seconds,
      })),
    });

    const drift = await apiGet(`/api/blueprints/instances/${instanceId}/drift`, token);
    expect(drift.entities.map((e: any) => e.name)).toContain(`Refill the tank ${SUFFIX} (edited)`);
  });

  itStack(
    'publishes a v2 into the live setup, keeping the user edit and updating the rest',
    async () => {
      const v2 = blueprintDoc();
      v2.rules[0]!.cooldown_seconds = 42; // the edited rule — must NOT take this
      v2.rules.push({
        key: 'leak_alert',
        name: `Possible leak ${SUFFIX}`,
        cooldown_seconds: 600,
        conditions: [
          {
            condition_type: 'threshold',
            slot_key: 'tank',
            action_name: 'water_level',
            operator: '<',
            threshold_value: '5',
          },
        ],
        actions: [{ slot_key: 'sockets', action_name: 'i2c_socket_8', target_state: 'OFF' }],
      } as any);

      // Re-importing over a blueprint with live instances is the v2 flow, not an error.
      await apiPost('/api/admin/blueprints/import', token, v2);
      await apiPost(`/api/admin/blueprints/${blueprintId}/publish`, token, {});

      const rules = await apiGet('/api/rules', token);
      const edited = rules.find((r: any) => r.name === `Refill the tank ${SUFFIX} (edited)`);
      const added = rules.find((r: any) => r.name === `Possible leak ${SUFFIX}`);

      // The user's edit survived the release, name and cooldown intact.
      expect(edited).toBeDefined();
      expect(edited.cooldown_seconds).toBe(900);
      // …and the new rule arrived.
      expect(added).toBeDefined();

      const instance = await apiGet(`/api/blueprints/instances/${instanceId}`, token);
      expect(instance.blueprint.version).toBe(2);
      expect(instance.blueprint_version_behind).toBe(false);
      // Phases are deleted and recreated by the re-import; the instance must keep its place.
      expect(instance.current_phase.key).toBe('steady');
    },
  );

  itStack('restores an edited rule from the blueprint on reset', async () => {
    const edited = (await apiGet('/api/rules', token)).find(
      (r: any) => r.name === `Refill the tank ${SUFFIX} (edited)`,
    );
    await apiPost(`/api/blueprints/instances/${instanceId}/reset/rule/${edited.id}`, token, {});

    const restored = (await apiGet('/api/rules', token)).find((r: any) => r.id === edited.id);
    expect(restored.name).toBe(`Refill the tank ${SUFFIX}`);
    expect(restored.cooldown_seconds).toBe(42); // now takes the v2 value it had been skipping

    const drift = await apiGet(`/api/blueprints/instances/${instanceId}/drift`, token);
    expect(drift.entities).toHaveLength(0);
  });

  // ── Blueprints with no phases (F10.13) ───────────────────────────────────
  //
  // Plenty of blueprints are not time-dependent and some declare no phases at all. Such a setup has
  // no lifecycle to position — but pausing still means "hold this setup's automations", so it must
  // still pause and resume. Without the phase-less branch in start(), stop() would strand it:
  // accepted on the way in, with no phase to enter on the way back.

  itStack('derives a phase-less blueprint already running, and pauses/resumes it', async () => {
    await releaseInstance(instanceId);
    instanceId = undefined;

    const doc = {
      key: `${BLUEPRINT_KEY}_nophase`,
      name: `E2E No Phases ${SUFFIX}`,
      slots: [
        { key: 'tank', label: 'Tank monitor', sealed_template: TANK_TEMPLATE },
        { key: 'sockets', label: 'Socket board', sealed_template: SOCKET_TEMPLATE },
      ],
      params: [{ key: 'level.min', label: 'Refill below', default_value: '20', unit: '%' }],
      phases: [],
      scenes: [],
      rules: [
        {
          key: 'refill',
          name: `Always-on refill ${SUFFIX}`,
          conditions: [
            {
              condition_type: 'threshold',
              slot_key: 'tank',
              action_name: 'water_level',
              operator: '<',
              // @param, not @phase: with no phases there is no phase layer to resolve against.
              threshold_value: '@param.level.min',
            },
          ],
          actions: [{ slot_key: 'sockets', action_name: 'i2c_socket_8', target_state: 'on' }],
        },
      ],
      pipelines: [],
    };
    const imported = await apiPost('/api/admin/blueprints/import', token, doc);
    noPhaseBlueprintId = imported.id;
    await apiPost(`/api/admin/blueprints/${noPhaseBlueprintId}/publish`, token, {});

    const derived = await apiPost(`/api/blueprints/${noPhaseBlueprintId}/derive`, token, {
      name: `E2E No Phases Setup ${SUFFIX}`,
      bindings: [
        { slot_key: 'tank', user_device_id: tankDev.deviceId },
        { slot_key: 'sockets', user_device_id: socketDev.deviceId },
      ],
    });
    noPhaseInstanceId = derived.instance_id;
    // Born running: there is no lifecycle to start, and holding it inert would make it useless.
    expect(derived.lifecycle_state).toBe('running');
    expect(derived.first_phase).toBeNull();

    const row = (await apiGet('/api/blueprints/instances', token)).find(
      (r: any) => r.id === noPhaseInstanceId,
    );
    expect(row.has_phases).toBe(false);
    expect(row.current_phase).toBeNull();
    expect(row.duration_seconds).toBeNull();

    const paused = await apiPost(`/api/blueprints/instances/${noPhaseInstanceId}/stop`, token, {});
    expect(paused.lifecycle_state).toBe('stopped');

    // The trap this test exists for: resuming with no phase to enter must still work.
    const resumed = await apiPost(
      `/api/blueprints/instances/${noPhaseInstanceId}/start`,
      token,
      {},
    );
    expect(resumed.lifecycle_state).toBe('running');
    expect(resumed.current_phase).toBeNull();

    await releaseInstance(noPhaseInstanceId);
    noPhaseInstanceId = undefined;
  });

  // ── Multi-device slots ─────────────────────────────────────────────────────
  //
  // A slot with max_count > 1 binds several devices, and every template leaf that names it fans
  // out to one derived row per bound device. One socket board became two above; a blueprint whose
  // sockets slot holds both must produce a scene and a rule that act on both, from a single
  // template leaf each.
  //
  // A device belongs to at most one setup (derive refuses a device another instance already
  // holds — blueprints.derive.service `candidate.free`), and this suite only has one fleet, so
  // each section below hands its boards back before the next one binds them.

  async function releaseInstance(id: number | undefined): Promise<void> {
    if (id === undefined) return;
    const { status } = await apiRaw('DELETE', `/api/blueprints/instances/${id}`, token);
    expect(status).toBe(204); // a silent failure here resurfaces as an unrelated 400 on the next derive
  }

  function multiDoc() {
    return {
      key: `${BLUEPRINT_KEY}_multi`,
      name: `E2E Multi Sockets ${SUFFIX}`,
      slots: [
        {
          key: 'sockets',
          label: 'Socket boards',
          sealed_template: SOCKET_TEMPLATE,
          min_count: 1,
          max_count: 4,
        },
      ],
      scenes: [
        {
          key: 'all_off',
          name: `All boards off ${SUFFIX}`,
          // ONE member, referencing the multi slot — must fan out to every bound board.
          members: [{ slot_key: 'sockets', action_name: 'i2c_socket_8', target_state: 'OFF' }],
        },
      ],
      rules: [
        {
          key: 'all_on',
          name: `All boards on ${SUFFIX}`,
          cooldown_seconds: 60,
          // Both the condition and the action name the multi slot: each fans out per board.
          conditions: [
            {
              condition_type: 'threshold',
              slot_key: 'sockets',
              action_name: 'i2c_socket_8',
              operator: '>',
              threshold_value: '0',
            },
          ],
          actions: [{ slot_key: 'sockets', action_name: 'i2c_socket_8', target_state: 'ON' }],
        },
      ],
    };
  }

  itStack('offers both boards as candidates for a multi-device slot', async () => {
    // The tank loop above holds socketDev, and a held device is neither a candidate nor
    // auto-bindable. Hand the whole setup back first, so this section starts from a free fleet.
    await releaseInstance(instanceId);
    instanceId = undefined;

    const imported = await apiPost('/api/admin/blueprints/import', token, multiDoc());
    multiBlueprintId = imported.id;
    await apiPost(`/api/admin/blueprints/${multiBlueprintId}/publish`, token, {});

    const preview = await apiGet(`/api/blueprints/${multiBlueprintId}/preview`, token);
    const sockets = preview.slots.find((s: any) => s.slot_key === 'sockets');
    const ids = sockets.candidates.map((c: any) => c.user_device_id);
    expect(ids).toContain(socketDev.deviceId);
    expect(ids).toContain(socketDev2.deviceId);
    // When the candidates fit under max_count (4), the slot auto-binds them all — no prompt. The
    // shared stack may host other boards of this type, so only assert the shortcut when it applies.
    if (sockets.candidates.length <= 4) {
      expect(sockets.auto_bind).toContain(socketDev.deviceId);
      expect(sockets.auto_bind).toContain(socketDev2.deviceId);
    }
  });

  // Runs before the derive below: a rejection has to come from the *type* check, and once the
  // fan-out test binds the socket boards the first binding in this call would be refused as held,
  // which would pass the status assertion for the wrong reason.
  itStack('still rejects a device that does not match the multi slot', async () => {
    // Multi-binding relaxes "how many", not "which kind": the tank board is the wrong sealed type
    // for the sockets slot and must be refused however many devices the slot accepts.
    const { status, body } = await apiRaw(
      'POST',
      `/api/blueprints/${multiBlueprintId}/derive`,
      token,
      {
        name: `E2E Multi Mismatch ${SUFFIX}`,
        bindings: [
          { slot_key: 'sockets', user_device_id: socketDev.deviceId },
          { slot_key: 'sockets', user_device_id: tankDev.deviceId },
        ],
      },
    );
    expect(status).toBe(400);
    expect(body.error).toContain('does not match slot "sockets"');
  });

  itStack('fans a scene member and a rule action out to every bound board', async () => {
    const result = await apiPost(`/api/blueprints/${multiBlueprintId}/derive`, token, {
      name: `E2E Multi Loop ${SUFFIX}`,
      bindings: [
        { slot_key: 'sockets', user_device_id: socketDev.deviceId },
        { slot_key: 'sockets', user_device_id: socketDev2.deviceId },
      ],
    });
    multiInstanceId = result.instance_id;
    expect(result.created).toEqual({ scenes: 1, rules: 1, pipelines: 0 });
    // One slot, two devices → two binding rows.
    expect(result.bindings.filter((b: any) => b.slot_key === 'sockets')).toHaveLength(2);

    // The scene's single template member became one member per board, on distinct actions.
    const scene = (await apiGet('/api/scenes', token)).find(
      (s: any) => s.name === `All boards off ${SUFFIX}`,
    );
    expect(scene.members).toHaveLength(2);
    expect(new Set(scene.members.map((m: any) => m.user_device_action_id)).size).toBe(2);

    // The rule's single templated condition and action each fanned out the same way.
    const rule = (await apiGet('/api/rules', token)).find(
      (r: any) => r.name === `All boards on ${SUFFIX}`,
    );
    expect(rule.conditions).toHaveLength(2);
    expect(rule.actions).toHaveLength(2);
    expect(new Set(rule.actions.map((a: any) => a.user_device_action_id)).size).toBe(2);
  });

  // ── Phase-scoped automations ───────────────────────────────────────────────
  //
  // A rule / scene / pipeline may declare the phases it is active in (empty = all). The gate is
  // read at evaluation time against the instance's current phase, so it never rewrites a row. Here
  // we prove the scope survives derive and that a scoped scene's execution is refused out of phase
  // and allowed once the phase advances into scope.

  function scopeDoc() {
    return {
      key: `${BLUEPRINT_KEY}_scope`,
      name: `E2E Phase Scope ${SUFFIX}`,
      slots: [
        { key: 'tank', label: 'Tank monitor', sealed_template: TANK_TEMPLATE },
        { key: 'sockets', label: 'Socket board', sealed_template: SOCKET_TEMPLATE },
      ],
      phases: [
        { key: 'commissioning', name: 'Commissioning', ordinal: 1, auto_advance: false },
        { key: 'steady', name: 'Steady state', ordinal: 2, auto_advance: false },
      ],
      scenes: [
        {
          key: 'steady_only',
          name: `Steady-only scene ${SUFFIX}`,
          phase_scope: ['steady'],
          members: [{ slot_key: 'sockets', action_name: 'i2c_socket_8', target_state: 'OFF' }],
        },
        {
          key: 'always',
          name: `Always scene ${SUFFIX}`,
          members: [{ slot_key: 'sockets', action_name: 'i2c_socket_8_2', target_state: 'OFF' }],
        },
      ],
      rules: [
        {
          key: 'commission_only',
          name: `Commission-only rule ${SUFFIX}`,
          phase_scope: ['commissioning'],
          cooldown_seconds: 60,
          conditions: [
            {
              condition_type: 'threshold',
              slot_key: 'tank',
              action_name: 'water_level',
              operator: '<',
              threshold_value: '10',
            },
          ],
          actions: [{ slot_key: 'sockets', action_name: 'i2c_socket_8', target_state: 'ON' }],
        },
      ],
    };
  }

  itStack('refuses to publish an automation scoped to an undeclared phase', async () => {
    const bad = scopeDoc();
    bad.key = `${BLUEPRINT_KEY}_scope_bad`;
    bad.name = `${bad.name} (bad)`;
    bad.rules[0]!.phase_scope = ['harvest']; // no such phase
    const imported = await apiPost('/api/admin/blueprints/import', token, bad);
    const { status, body } = await apiRaw(
      'POST',
      `/api/admin/blueprints/${imported.id}/publish`,
      token,
    );
    expect(status).toBe(400);
    expect(body.details.join('\n')).toContain('not a declared phase');
    await apiDelete(`/api/admin/blueprints/${imported.id}`, token);
  });

  itStack('derives a scoped rule and scene, preserving their phase_scope', async () => {
    // Same one-setup-per-device rule as above: the multi loop holds both socket boards.
    await releaseInstance(multiInstanceId);
    multiInstanceId = undefined;

    const imported = await apiPost('/api/admin/blueprints/import', token, scopeDoc());
    scopeBlueprintId = imported.id;
    await apiPost(`/api/admin/blueprints/${scopeBlueprintId}/publish`, token, {});

    const result = await apiPost(`/api/blueprints/${scopeBlueprintId}/derive`, token, {
      name: `E2E Scope Loop ${SUFFIX}`,
      bindings: [
        { slot_key: 'tank', user_device_id: tankDev.deviceId },
        { slot_key: 'sockets', user_device_id: socketDev.deviceId },
      ],
    });
    scopeInstanceId = result.instance_id;
    // Derive builds it; start puts it in commissioning, so the commission-only rule is in scope
    // from there. The phase gate is only reachable once the lifecycle gate is open (F10.13).
    expect(result.current_phase).toBeNull();
    await apiPost(`/api/blueprints/instances/${scopeInstanceId}/start`, token, {
      phase_key: 'commissioning',
    });

    const rule = (await apiGet('/api/rules', token)).find(
      (r: any) => r.name === `Commission-only rule ${SUFFIX}`,
    );
    expect(rule.phase_scope).toEqual(['commissioning']);

    const scenes = await apiGet('/api/scenes', token);
    const scoped = scenes.find((s: any) => s.name === `Steady-only scene ${SUFFIX}`);
    const always = scenes.find((s: any) => s.name === `Always scene ${SUFFIX}`);
    expect(scoped.phase_scope).toEqual(['steady']);
    expect(always.phase_scope).toEqual([]);
    // Instance is in commissioning: the steady-only scene is out of phase, the plain one is not.
    expect(scoped.in_phase).toBe(false);
    expect(always.in_phase).toBe(true);
  });

  itStack('refuses to run a scene out of its phase, then allows it after advancing', async () => {
    const sceneId = (await apiGet('/api/scenes', token)).find(
      (s: any) => s.name === `Steady-only scene ${SUFFIX}`,
    ).id;

    // In commissioning → 409, and the always-on scene still runs (202).
    const blocked = await apiRaw('POST', `/api/scenes/${sceneId}/execute`, token, {});
    expect(blocked.status).toBe(409);
    expect(blocked.body.error).toContain('not available in the current phase');
    const alwaysId = (await apiGet('/api/scenes', token)).find(
      (s: any) => s.name === `Always scene ${SUFFIX}`,
    ).id;
    const alwaysRun = await apiRaw('POST', `/api/scenes/${alwaysId}/execute`, token, {});
    expect(alwaysRun.status).toBe(202);

    // Advance into steady — one column write, no scene rows touched — and the same scene now runs.
    await apiPut(`/api/blueprints/instances/${scopeInstanceId}/phase`, token, {
      phase_key: 'steady',
    });
    const scoped = (await apiGet('/api/scenes', token)).find((s: any) => s.id === sceneId);
    expect(scoped.in_phase).toBe(true);
    const allowed = await apiRaw('POST', `/api/scenes/${sceneId}/execute`, token, {});
    expect(allowed.status).toBe(202);
  });
});
