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
// F10.10's own pair — see the group at the end of the file for why it is not the shared fixture.
const GUARD_KEY = `e2e_guard_${SUFFIX}`;

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
        advance_mode: 'schedule',
        targets: [{ param_key: 'level.min', value: '40' }],
      },
      // No target for level.min ⇒ it must fall through to the blueprint default (20).
      { key: 'steady', name: 'Steady state', ordinal: 2, advance_mode: 'manual' },
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
  let guardTemplateId: number | undefined;
  let guardBlueprintId: number | undefined;

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
    // Blueprints before templates, throughout: a sealed template a blueprint still fills a slot
    // from now refuses to be deleted (F10.10), so the template sweep at the end would fail.
    // guardTemplateId is the SHARED socket template, deleted with the others below — not here.
    if (guardBlueprintId)
      await apiDelete(`/api/admin/blueprints/${guardBlueprintId}`, token).catch(() => {});
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

  // `user_tunable = false` means "not the OWNER's dial", not "unchangeable" — an admin may pin a
  // fixed param on a live setup, which is the only route to one short of republishing the blueprint
  // to every setup derived from it (see setOverride's `isAdmin`). This suite holds an admin token,
  // so it pins the admin half. **The owner-refused half is not covered anywhere** — it needs a
  // non-admin user this suite does not have.
  itStack('lets an admin pin a param the blueprint marked phase-driven', async () => {
    let instance = await apiPut(
      `/api/blueprints/instances/${instanceId}/params/pump.state`,
      token,
      { value: 'off' },
    );
    let pump = instance.params.find((p: any) => p.key === 'pump.state');
    expect(pump.value).toBe('off');
    expect(pump.source).toBe('override');

    // Clear it again: later cases dispatch this param at a real board, and 'off' would make the
    // scene execution assertions read the wrong state.
    instance = await apiPut(`/api/blueprints/instances/${instanceId}/params/pump.state`, token, {
      value: null,
    });
    pump = instance.params.find((p: any) => p.key === 'pump.state');
    expect(pump.value).toBe('on');
    expect(pump.source).toBe('default');
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

    // The whole track rides along, so the card can show how far through the lifecycle this is
    // rather than only how far through one phase (F11.4).
    expect(row.phases.map((p: any) => p.key)).toEqual(['commissioning', 'steady']);
    expect(row.phases.find((p: any) => p.is_current).key).toBe('steady');
    // A parked track does not move: elapsed is the bank, in every phase.
    expect(row.phases.every((p: any) => p.elapsed_seconds === p.accrued_seconds)).toBe(true);

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
      phase_key: 'winddown',
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

  // ── Static setups: no slot has phases (F10.13 / F11.8) ───────────────────
  //
  // Plenty of blueprints are not time-dependent, and some schedule nothing at all. Such a setup has
  // no lifecycle to position — but pausing still means "hold this setup's automations", so it must
  // still pause and resume. Without the phase-less branch in start(), stop() would strand it:
  // accepted on the way in, with no phase to enter on the way back.
  //
  // Since F11.8 that is *declared* (`is_static`) rather than inferred, so a draft whose author has
  // not written the phases yet is not mistaken for a setup that deliberately has none.

  itStack('derives a static blueprint already running, and pauses/resumes it', async () => {
    await releaseInstance(instanceId);
    instanceId = undefined;

    const doc = {
      key: `${BLUEPRINT_KEY}_nophase`,
      name: `E2E No Phases ${SUFFIX}`,
      is_static: true,
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

  // The flag and the content must agree, both ways — a blueprint that says one thing and does
  // another would either show a phase track it denies having, or silently publish an unfinished
  // draft as though the omission were deliberate.

  itStack('refuses to publish a static blueprint that still declares phases', async () => {
    const bad = {
      key: `${BLUEPRINT_KEY}_static_bad`,
      name: `E2E Static Contradiction ${SUFFIX}`,
      is_static: true,
      slots: [{ key: 'tank', label: 'Tank monitor', sealed_template: TANK_TEMPLATE }],
      phases: [{ key: 'run', name: 'Run', ordinal: 1, advance_mode: 'manual' }],
      scenes: [],
      rules: [],
      pipelines: [],
    };
    const imported = await apiPost('/api/admin/blueprints/import', token, bad);
    const { status, body } = await apiRaw(
      'POST',
      `/api/admin/blueprints/${imported.id}/publish`,
      token,
    );
    expect(status).toBe(400);
    expect(body.details.join('\n')).toContain('marked static');
    await apiDelete(`/api/admin/blueprints/${imported.id}`, token);
  });

  itStack('refuses to publish a blueprint with no phases that is not marked static', async () => {
    // The case the flag exists for: indistinguishable from an unfinished draft without it.
    const bad = {
      key: `${BLUEPRINT_KEY}_static_missing`,
      name: `E2E Static Undeclared ${SUFFIX}`,
      slots: [{ key: 'tank', label: 'Tank monitor', sealed_template: TANK_TEMPLATE }],
      phases: [],
      scenes: [],
      rules: [],
      pipelines: [],
    };
    const imported = await apiPost('/api/admin/blueprints/import', token, bad);
    const { status, body } = await apiRaw(
      'POST',
      `/api/admin/blueprints/${imported.id}/publish`,
      token,
    );
    expect(status).toBe(400);
    expect(body.details.join('\n')).toContain('mark it static');
    await apiDelete(`/api/admin/blueprints/${imported.id}`, token);
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
      // Nothing here is scheduled — the point of this fixture is fan-out, not phases (F11.8).
      is_static: true,
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
        { key: 'commissioning', name: 'Commissioning', ordinal: 1, advance_mode: 'manual' },
        { key: 'steady', name: 'Steady state', ordinal: 2, advance_mode: 'manual' },
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
    bad.rules[0]!.phase_scope = ['winddown']; // no such phase
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

  // ── Per-device lifecycles and fan-out (F11) ────────────────────────────────
  //
  // One setup, several devices, each on its own schedule. Everything below turns on one idea: a
  // binding of a *profiled* slot is the thing that has a lifecycle, not the setup — so two devices
  // in the same setup are legitimately in different phases at the same moment, and an automation
  // that reads `@phase.` has to belong to one of them.
  //
  // The blueprint asks which schedule through its own form (F11.6): a select option names a
  // profile, so answering "what is this handling?" both records the answer and puts the device on
  // the matching lifecycle. That is the shape a real blueprint uses, and it is what is exercised
  // here rather than passing profile_key by hand.

  let deviceBlueprintId: number | undefined;
  let deviceInstanceId: number | undefined;

  function perDeviceDoc() {
    return {
      key: `${BLUEPRINT_KEY}_devices`,
      name: `E2E Per-device ${SUFFIX}`,
      slots: [
        { key: 'tank', label: 'Tank monitor', sealed_template: TANK_TEMPLATE },
        {
          key: 'loops',
          label: 'Loops',
          sealed_template: SOCKET_TEMPLATE,
          min_count: 1,
          max_count: 4,
          // The load-bearing flag: each bound device follows its own profile.
          profiled: true,
        },
      ],
      params: [{ key: 'level.min', label: 'Level floor', default_value: '10' }],
      fields: [
        {
          key: 'duty',
          label: 'What is this loop handling?',
          input_type: 'select',
          scope: 'binding',
          slot_key: 'loops',
          required: true,
          options: [
            { value: 'quick_run', label: 'Quick run', profile_key: 'fast_cycle' },
            { value: 'long_soak', label: 'Long soak', profile_key: 'slow_cycle' },
          ],
        },
      ],
      profiles: [
        {
          key: 'fast_cycle',
          label: 'Fast cycle',
          phases: [
            {
              key: 'fill',
              name: 'Fill',
              ordinal: 1,
              advance_mode: 'manual',
              targets: [{ param_key: 'level.min', value: '40' }],
            },
            {
              key: 'hold',
              name: 'Hold',
              ordinal: 2,
              advance_mode: 'manual',
              targets: [{ param_key: 'level.min', value: '20' }],
            },
          ],
        },
        {
          key: 'slow_cycle',
          label: 'Slow cycle',
          phases: [
            {
              key: 'fill',
              name: 'Fill',
              ordinal: 1,
              advance_mode: 'manual',
              targets: [{ param_key: 'level.min', value: '70' }],
            },
            {
              key: 'flush',
              name: 'Flush',
              ordinal: 2,
              advance_mode: 'manual',
              targets: [{ param_key: 'level.min', value: '5' }],
            },
          ],
        },
      ],
      rules: [
        {
          key: 'per_loop',
          name: `Loop low ${SUFFIX}`,
          cooldown_seconds: 60,
          // One rule per bound device, each resolving @phase against its OWN device's phase.
          fan_out: 'per_device',
          fan_out_slot_key: 'loops',
          conditions: [
            {
              condition_type: 'threshold',
              slot_key: 'loops',
              action_name: 'i2c_socket_8',
              operator: '<',
              threshold_value: '@phase.level.min',
            },
          ],
          actions: [{ slot_key: 'loops', action_name: 'i2c_socket_8', target_state: 'ON' }],
        },
        {
          key: 'fast_only',
          name: `Fast loop top-up ${SUFFIX}`,
          cooldown_seconds: 60,
          // "One each, but only for some" (F11.9): one rule per device on the fast lifecycle, and
          // none at all on the others — where before F11.9 this had to be a rule on every device
          // gated by phase, leaving a permanently inert copy on the slow ones.
          fan_out: 'per_device',
          fan_out_slot_key: 'loops',
          fan_out_profiles: ['fast_cycle'],
          conditions: [
            {
              condition_type: 'threshold',
              slot_key: 'loops',
              action_name: 'i2c_socket_8',
              operator: '<',
              threshold_value: '@phase.level.min',
            },
          ],
          actions: [{ slot_key: 'loops', action_name: 'i2c_socket_8', target_state: 'ON' }],
        },
      ],
      scenes: [
        {
          key: 'slow_group',
          name: `Slow loops off ${SUFFIX}`,
          // "Some, together": ONE scene, but covering only the devices on the slow lifecycle.
          // No `@phase.` anywhere in it — a combined entity still has a single context, and the
          // selector narrows which devices it acts on, not how many phases it can read.
          fan_out: 'combined',
          fan_out_slot_key: 'loops',
          fan_out_profiles: ['slow_cycle'],
          members: [{ slot_key: 'loops', action_name: 'i2c_socket_8', target_state: 'OFF' }],
        },
      ],
    };
  }

  itStack(
    'refuses to publish a combined template that reads @phase over a profiled slot',
    async () => {
      // The case that genuinely cannot resolve: one entity, one context, several devices each in
      // their own phase. Caught at publish because at evaluation time it would just pick one.
      const bad = perDeviceDoc();
      bad.key = `${BLUEPRINT_KEY}_devices_bad`;
      bad.name = `${bad.name} (bad)`;
      bad.rules[0]!.fan_out = 'combined';
      delete (bad.rules[0] as { fan_out_slot_key?: string }).fan_out_slot_key;
      const imported = await apiPost('/api/admin/blueprints/import', token, bad);
      const { status, body } = await apiRaw(
        'POST',
        `/api/admin/blueprints/${imported.id}/publish`,
        token,
      );
      expect(status).toBe(400);
      expect(body.details.join('\n')).toContain('each bound device is in its own phase');
      await apiDelete(`/api/admin/blueprints/${imported.id}`, token);
    },
  );

  itStack('derives a setup whose devices follow the lifecycle their answer chose', async () => {
    await releaseInstance(scopeInstanceId);
    scopeInstanceId = undefined;

    const imported = await apiPost('/api/admin/blueprints/import', token, perDeviceDoc());
    deviceBlueprintId = imported.id;
    await apiPost(`/api/admin/blueprints/${deviceBlueprintId}/publish`, token, {});

    // The wizard reads the form off the preview rather than knowing the blueprint.
    const preview = await apiGet(`/api/blueprints/${deviceBlueprintId}/preview`, token);
    expect(preview.profiles.map((p: any) => p.key)).toEqual(['fast_cycle', 'slow_cycle']);
    expect(preview.fields).toHaveLength(1);
    expect(preview.fields[0].scope).toBe('binding');

    const result = await apiPost(`/api/blueprints/${deviceBlueprintId}/derive`, token, {
      name: `E2E Per-device Loop ${SUFFIX}`,
      bindings: [
        { slot_key: 'tank', user_device_id: tankDev.deviceId },
        {
          slot_key: 'loops',
          user_device_id: socketDev.deviceId,
          label: 'Loop A',
          // No profile_key: the ANSWER picks it. That is the whole point of the option's profile.
          field_values: [{ field_key: 'duty', value: 'quick_run' }],
        },
        {
          slot_key: 'loops',
          user_device_id: socketDev2.deviceId,
          label: 'Loop B',
          field_values: [{ field_key: 'duty', value: 'long_soak' }],
        },
      ],
    });
    deviceInstanceId = result.instance_id;

    const loops = result.bindings.filter((b: any) => b.slot_key === 'loops');
    expect(loops.map((b: any) => b.profile_key).sort()).toEqual(['fast_cycle', 'slow_cycle']);
    // The shared device has no lifecycle of its own.
    expect(result.bindings.find((b: any) => b.slot_key === 'tank').profile_key).toBeNull();
    // A setup whose devices own the schedule has no phase to start into, so it is born running.
    expect(result.lifecycle_state).toBe('running');
    expect(result.first_phase).toBeNull();
  });

  itStack('refuses a device on a profiled slot with no way to know its lifecycle', async () => {
    const { status, body } = await apiRaw(
      'POST',
      `/api/blueprints/${deviceBlueprintId}/derive`,
      token,
      {
        name: `E2E Per-device Unanswered ${SUFFIX}`,
        bindings: [{ slot_key: 'loops', user_device_id: socketDev.deviceId }],
      },
    );
    expect(status).toBe(400);
    // Required-field first: the answer is what would have chosen the profile.
    expect(body.error).toContain('required');
  });

  itStack('materialises one rule per bound device, each wired to only that device', async () => {
    const rules = (await apiGet('/api/rules', token)).filter((r: any) =>
      r.name.startsWith(`Loop low ${SUFFIX}`),
    );
    expect(rules).toHaveLength(2);
    // Named after the device they belong to, so two copies are tellable apart.
    expect(rules.map((r: any) => r.name).sort()).toEqual([
      `Loop low ${SUFFIX} · Loop A`,
      `Loop low ${SUFFIX} · Loop B`,
    ]);
    // One condition and one action each — NOT one per bound device. The whole difference from a
    // combined template: this rule watches its own device only.
    for (const rule of rules) {
      expect(rule.conditions).toHaveLength(1);
      expect(rule.actions).toHaveLength(1);
    }
    // And they are wired to different devices.
    const actionIds = rules.map((r: any) => r.actions[0].user_device_action_id);
    expect(new Set(actionIds).size).toBe(2);
  });

  // ── The device selector (F11.9) ────────────────────────────────────────────
  //
  // `fan_out` says how many automations; `fan_out_profiles` says which devices they cover. The two
  // together are one / some / all, and "some" is the shape that had no expression before: an
  // automation for two of three devices previously had to exist on all three and be gated shut on
  // the third, which is a live row that can never fire.

  itStack('materialises a per-device rule on only the selected lifecycle', async () => {
    const rules = (await apiGet('/api/rules', token)).filter((r: any) =>
      r.name.startsWith(`Fast loop top-up ${SUFFIX}`),
    );
    // Loop A answered "quick run" → fast_cycle; Loop B answered "long soak". One rule, not two.
    expect(rules).toHaveLength(1);
    expect(rules[0].name).toBe(`Fast loop top-up ${SUFFIX} · Loop A`);
  });

  itStack('materialises one combined scene covering only the selected devices', async () => {
    const scene = (await apiGet('/api/scenes', token)).find(
      (sc: any) => sc.name === `Slow loops off ${SUFFIX}`,
    );
    // One entity, so the author's name stands unsuffixed — there is nothing to tell apart.
    expect(scene).toBeDefined();
    // Two devices are bound to the slot; only the slow one is in the scene.
    expect(scene.members).toHaveLength(1);

    // And it is genuinely the slow device: the per-device rule named after Loop B is wired to the
    // same action, which is the only cross-check that distinguishes "one member" from "the right
    // member".
    const loopB = (await apiGet('/api/rules', token)).find(
      (r: any) => r.name === `Loop low ${SUFFIX} · Loop B`,
    );
    expect(scene.members[0].user_device_action_id).toBe(loopB.actions[0].user_device_action_id);
  });

  // The three ways a selector can be written so that it selects nobody. Each would otherwise
  // publish cleanly and produce an automation that silently covers no device at all.

  async function expectSelectorRejected(
    mutate: (doc: ReturnType<typeof perDeviceDoc>) => void,
    expected: string,
  ): Promise<void> {
    const bad = perDeviceDoc();
    bad.key = `${BLUEPRINT_KEY}_sel_${Math.random().toString(36).slice(2, 8)}`;
    bad.name = `${bad.name} (sel)`;
    mutate(bad);
    const imported = await apiPost('/api/admin/blueprints/import', token, bad);
    const { status, body } = await apiRaw(
      'POST',
      `/api/admin/blueprints/${imported.id}/publish`,
      token,
    );
    expect(status).toBe(400);
    expect(body.details.join('\n')).toContain(expected);
    await apiDelete(`/api/admin/blueprints/${imported.id}`, token);
  }

  // Reconcile disables an automation whose device left the selection. It must also bring it back —
  // and must NOT resurrect one the *user* switched off, which is why the author of the disable is
  // recorded rather than inferred. Toggling `enabled` is deliberately not drift, so without that
  // record the two cases are indistinguishable and one of them is always wrong.

  itStack(
    're-enables an automation it disabled once its device returns to the selection',
    async () => {
      const bindings = await apiGet(
        `/api/blueprints/instances/${deviceInstanceId}/bindings`,
        token,
      );
      const loopA = bindings.find((b: any) => b.label === 'Loop A');
      const ruleNamed = async () =>
        (await apiGet('/api/rules', token)).find(
          (r: any) => r.name === `Fast loop top-up ${SUFFIX} · Loop A`,
        );

      expect((await ruleNamed()).enabled).toBe(true);

      // Off the selected lifecycle → its per-device rule is no longer produced.
      await apiPost(`/api/blueprints/bindings/${loopA.binding_id}/reset`, token, {
        profile_key: 'slow_cycle',
      });
      await apiPost(`/api/blueprints/instances/${deviceInstanceId}/reconcile`, token, {});
      expect((await ruleNamed()).enabled).toBe(false);

      // …and back again.
      await apiPost(`/api/blueprints/bindings/${loopA.binding_id}/reset`, token, {
        profile_key: 'fast_cycle',
      });
      await apiPost(`/api/blueprints/instances/${deviceInstanceId}/reconcile`, token, {});
      expect((await ruleNamed()).enabled).toBe(true);
    },
  );

  itStack('leaves an automation the user disabled switched off across a reconcile', async () => {
    const rule = (await apiGet('/api/rules', token)).find(
      (r: any) => r.name === `Fast loop top-up ${SUFFIX} · Loop A`,
    );
    await apiPatch(`/api/rules/${rule.id}/toggle`, token, { enabled: false });

    await apiPost(`/api/blueprints/instances/${deviceInstanceId}/reconcile`, token, {});

    const after = (await apiGet('/api/rules', token)).find((r: any) => r.id === rule.id);
    expect(after.enabled).toBe(false);
    // Restore, so the rest of the suite sees the setup as the blueprint describes it.
    await apiPatch(`/api/rules/${rule.id}/toggle`, token, { enabled: true });
  });

  itStack(
    'refuses to publish more than one lifecycle when no slot chooses between them',
    async () => {
      // Nothing picks a lifecycle unless a slot is profiled, so the second one is dead weight: derive
      // and the setup page both silently take the first. Publishing that hides an authoring mistake.
      const bad = perDeviceDoc();
      bad.key = `${BLUEPRINT_KEY}_unchosen`;
      bad.name = `${bad.name} (unchosen)`;
      bad.slots[1]!.profiled = false;
      // Drop everything that depends on the slot being profiled, so this is the only problem left.
      bad.fields = [];
      bad.rules = [];
      bad.scenes = [];
      const imported = await apiPost('/api/admin/blueprints/import', token, bad);
      const { status, body } = await apiRaw(
        'POST',
        `/api/admin/blueprints/${imported.id}/publish`,
        token,
      );
      expect(status).toBe(400);
      expect(body.details.join('\n')).toContain('no slot whose devices choose between them');
      await apiDelete(`/api/admin/blueprints/${imported.id}`, token);
    },
  );

  itStack('refuses to publish a selector naming an undeclared lifecycle', async () => {
    await expectSelectorRejected((doc) => {
      doc.rules[1]!.fan_out_profiles = ['no_such_cycle'];
    }, 'is not a declared lifecycle');
  });

  itStack('refuses to publish a selector over a slot whose devices share the setup', async () => {
    // The tank is unprofiled: its device has no lifecycle, so there is nothing to select it by.
    await expectSelectorRejected((doc) => {
      doc.rules[1]!.fan_out_slot_key = 'tank';
    }, 'do not each follow one');
  });

  itStack('refuses to publish a selector over a slot the template never addresses', async () => {
    // Narrowing a slot nothing reads changes nothing — the automation would still act on whatever
    // it does address, for every device, while claiming to be limited.
    await expectSelectorRejected((doc) => {
      doc.scenes[0]!.members[0]!.slot_key = 'tank';
      doc.scenes[0]!.members[0]!.action_name = 'water_level';
    }, 'would change nothing');
  });

  itStack('starts one device without touching the other', async () => {
    const before = await apiGet(`/api/blueprints/instances/${deviceInstanceId}/bindings`, token);
    expect(before).toHaveLength(2);
    expect(before.every((b: any) => b.lifecycle_state === 'not_started')).toBe(true);

    const loopA = before.find((b: any) => b.label === 'Loop A');
    const started = await apiPost(`/api/blueprints/bindings/${loopA.binding_id}/start`, token, {
      phase_key: 'fill',
    });
    expect(started.lifecycle_state).toBe('running');
    expect(started.current_phase.key).toBe('fill');

    const after = await apiGet(`/api/blueprints/instances/${deviceInstanceId}/bindings`, token);
    expect(after.find((b: any) => b.label === 'Loop B').lifecycle_state).toBe('not_started');
  });

  itStack('advances one device, leaving the other where it was', async () => {
    const bindings = await apiGet(`/api/blueprints/instances/${deviceInstanceId}/bindings`, token);
    const loopA = bindings.find((b: any) => b.label === 'Loop A');
    const loopB = bindings.find((b: any) => b.label === 'Loop B');

    await apiPost(`/api/blueprints/bindings/${loopB.binding_id}/start`, token, {
      phase_key: 'fill',
    });
    const moved = await apiPut(`/api/blueprints/bindings/${loopA.binding_id}/phase`, token, {
      phase_key: 'hold',
      timer: 'reset',
    });
    expect(moved.current_phase.key).toBe('hold');

    const after = await apiGet(`/api/blueprints/instances/${deviceInstanceId}/bindings`, token);
    expect(after.find((b: any) => b.label === 'Loop B').current_phase.key).toBe('fill');
    // Two devices, two different phases, at the same instant — impossible before F11.
    expect(new Set(after.map((b: any) => b.current_phase.key)).size).toBe(2);
  });

  itStack('refuses a phase that belongs to the other device lifecycle', async () => {
    // "flush" is a phase of slow_cycle; Loop A follows fast_cycle and must not be able to enter it.
    const bindings = await apiGet(`/api/blueprints/instances/${deviceInstanceId}/bindings`, token);
    const loopA = bindings.find((b: any) => b.label === 'Loop A');
    const { status, body } = await apiRaw(
      'PUT',
      `/api/blueprints/bindings/${loopA.binding_id}/phase`,
      token,
      { phase_key: 'flush' },
    );
    expect(status).toBe(400);
    expect(body.error).toContain('is not a phase of profile "fast_cycle"');
  });

  itStack('holds every device once the setup is stopped', async () => {
    await apiPost(`/api/blueprints/instances/${deviceInstanceId}/stop`, token, {});
    const held = await apiGet(`/api/blueprints/instances/${deviceInstanceId}/bindings`, token);
    // Each device still says what IT is; the effective state is what any gate reads.
    expect(held.every((b: any) => b.lifecycle_state === 'running')).toBe(true);
    expect(held.every((b: any) => b.effective_state === 'stopped')).toBe(true);
    await apiPost(`/api/blueprints/instances/${deviceInstanceId}/start`, token, {});
  });

  itStack(
    'summarises the devices on the setups list rather than a phase it does not have',
    async () => {
      const row = (await apiGet('/api/blueprints/instances', token)).find(
        (i: any) => i.id === deviceInstanceId,
      );
      expect(row.has_phases).toBe(false); // the devices own the lifecycle, not the setup
      expect(row.devices).toEqual({ total: 2, running: 2 });
      // …and no track of its own, because drawing one beside the devices' would show the same
      // time twice.
      expect(row.phases).toEqual([]);
    },
  );

  itStack('carries a whole track per device on the setups list (F11.4)', async () => {
    // The list card draws a rail per device, so it needs every phase — not just the current one —
    // and each device's own position in its own lifecycle.
    const row = (await apiGet('/api/blueprints/instances', token)).find(
      (i: any) => i.id === deviceInstanceId,
    );
    expect(row.device_tracks).toHaveLength(2);

    const loopA = row.device_tracks.find((d: any) => d.label === 'Loop A');
    const loopB = row.device_tracks.find((d: any) => d.label === 'Loop B');
    expect(loopA.effective_state).toBe('running');
    expect(loopA.phases.length).toBeGreaterThan(1);
    // Exactly one phase is current, and it is the one the binding reports.
    expect(loopA.phases.filter((p: any) => p.is_current)).toHaveLength(1);
    expect(loopA.phases.find((p: any) => p.is_current).key).toBe(loopA.current_phase.key);

    // Two devices on different lifecycles, so the tracks are genuinely different — the whole
    // reason a single setup-level bar could not describe this setup.
    expect(loopA.current_phase.key).not.toBe(loopB.current_phase.key);

    // Every phase carries what a bar needs: a length to size the segment and a spend to fill it.
    for (const phase of loopA.phases) {
      expect(typeof phase.name).toBe('string');
      expect(typeof phase.ordinal).toBe('number');
      expect(phase.elapsed_seconds).toBeGreaterThanOrEqual(phase.accrued_seconds);
    }
  });

  itStack('puts a device on another lifecycle when it is reset', async () => {
    const bindings = await apiGet(`/api/blueprints/instances/${deviceInstanceId}/bindings`, token);
    const loopA = bindings.find((b: any) => b.label === 'Loop A');
    const reset = await apiPost(`/api/blueprints/bindings/${loopA.binding_id}/reset`, token, {
      profile_key: 'slow_cycle',
    });
    expect(reset.profile_key).toBe('slow_cycle');
    expect(reset.lifecycle_state).toBe('not_started');
    expect(reset.accrued_seconds).toBe(0);
    // It now walks the other lifecycle's phases.
    expect(reset.phases.map((p: any) => p.key)).toEqual(['fill', 'flush']);
  });

  itStack('refuses a lifecycle action on a device the setup shares', async () => {
    const instance = await apiGet(`/api/blueprints/instances/${deviceInstanceId}`, token);
    const tank = instance.bindings.find((b: any) => b.slot_key === 'tank');
    expect(tank.binding_id).toBeNull(); // no lifecycle of its own, so nothing to start
  });

  // ── F10.10: sealed-template change propagation ────────────────────────────────────────────
  //
  // A published blueprint addresses (slot_key, mqtt_action_name); the template owns the names. The
  // failure being guarded is silent — a stranded reference resolves to nothing at the next
  // derive/reconcile and the entity is skipped — so every case here asserts on the *refusal*, not
  // on some observable breakage after the fact.
  //
  // The guard blueprint fills its slot from the suite's own SOCKET_TEMPLATE rather than a private
  // one. A second template cannot be released for this device type at all: releasing rejects a
  // target range that overlaps an already-released one, AND rejects a range with no catalog version
  // in it — and the socket template already covers every version the catalog has. So the two rules
  // together leave no window for a private template, and the shared one is what a dependent
  // blueprint must point at.
  //
  // Safe because this group runs LAST: the only thing after it is afterAll. The mutating cases
  // below edit the shared template on purpose, and the final case puts it back. Every assertion
  // therefore looks its own blueprint up by key instead of assuming it is the only dependent —
  // the suite's other published blueprints address the same template.

  const guardEntries = (count: number, label = 'Socket') =>
    [0, 1].slice(0, count).map((channel) => ({
      capability_key: 'i2c_socket_8',
      action_label: `${label} ${channel + 1}`,
      sort_order: channel,
      pins: [
        { pin_slot_key: 'sda', pin_number: 8 },
        { pin_slot_key: 'scl', pin_number: 9 },
        { pin_slot_key: 'address', pin_number: 32 },
        { pin_slot_key: 'channel', pin_number: channel },
      ],
      behaviors: [{ behavior: 'command' }],
    }));

  itStack('reports which published blueprints a sealed template holds up', async () => {
    // templateIds[1] is SOCKET_TEMPLATE — released in beforeAll, with entries i2c_socket_8 and
    // i2c_socket_8_2, which is exactly the two-entry shape these cases need.
    guardTemplateId = templateIds[1];

    const imported = await apiPost('/api/admin/blueprints/import', token, {
      key: GUARD_KEY,
      name: `E2E Guard ${SUFFIX}`,
      is_static: true,
      slots: [{ key: 'sockets', label: 'Socket board', sealed_template: SOCKET_TEMPLATE }],
      params: [{ key: 'pump.state', label: 'On value', default_value: 'on', user_tunable: false }],
      phases: [],
      scenes: [
        {
          key: 'stop_all',
          name: `Guard stop ${SUFFIX}`,
          members: [{ slot_key: 'sockets', action_name: 'i2c_socket_8', target_state: 'off' }],
        },
      ],
      rules: [
        {
          key: 'guard_rule',
          name: `Guard rule ${SUFFIX}`,
          conditions: [
            {
              condition_type: 'device_status',
              slot_key: 'sockets',
              action_name: 'i2c_socket_8',
              status_value: 'offline',
            },
          ],
          actions: [
            {
              slot_key: 'sockets',
              action_name: 'i2c_socket_8_2',
              target_state: '@param.pump.state',
            },
          ],
        },
      ],
      pipelines: [],
    });
    guardBlueprintId = imported.id;
    await apiPost(`/api/admin/blueprints/${guardBlueprintId}/publish`, token, {});

    const usage = await apiGet(
      `/api/admin/catalog/sealed/templates/${guardTemplateId}/usage`,
      token,
    );
    // The suite's other blueprints fill a slot from this template too, so the lookup is by key —
    // asserting "exactly one dependent" would be asserting the fixture, not the reverse lookup.
    const mine = usage.find((u: any) => u.key === GUARD_KEY);
    expect(mine).toBeDefined();
    expect(mine.blueprint_id).toBe(guardBlueprintId);
    expect(mine.status).toBe('published');
    expect(mine.slot_keys).toEqual(['sockets']);
    // Every place that can address an action is collected, not just the rule action.
    expect(mine.refs.map((r: any) => r.where).sort()).toEqual([
      'rule "guard_rule" action',
      'rule "guard_rule" condition',
      'scene "stop_all" member',
    ]);
    // Nothing broken yet — for any dependent, not just ours.
    expect(usage.flatMap((u: any) => u.stranded)).toEqual([]);
  });

  itStack('blocks an entry removal that would strand a published blueprint reference', async () => {
    // Dropping the second entry is the positional rename in disguise: `i2c_socket_8_2` simply
    // stops existing, and the rule action that names it would resolve to nothing.
    const { status, body } = await apiRaw(
      'PATCH',
      `/api/admin/catalog/sealed/templates/${guardTemplateId}`,
      token,
      { entries: guardEntries(1) },
    );
    expect(status).toBe(409);
    // Our blueprint's rule action is named; every line names the entry that would vanish. Other
    // dependents of the shared template appear too, which is the point — the guard reports all of
    // them, not the first one it finds.
    const details: string[] = body.details;
    expect(details.every((d) => d.includes('i2c_socket_8_2'))).toBe(true);
    expect(
      details.some(
        (d) => d.includes(`E2E Guard ${SUFFIX}`) && d.includes('rule "guard_rule" action'),
      ),
    ).toBe(true);

    // Refused *before* the write: the entry set is untouched.
    const after = await apiGet(`/api/admin/catalog/sealed/templates/${guardTemplateId}`, token);
    expect(after.entries.map((e: any) => e.mqtt_action_name)).toEqual([
      'i2c_socket_8',
      'i2c_socket_8_2',
    ]);
  });

  itStack('lets an unrelated sealed-template edit through untouched', async () => {
    // Same entries, same generated names, different labels — nothing a blueprint addresses moves.
    await apiPatch(`/api/admin/catalog/sealed/templates/${guardTemplateId}`, token, {
      entries: guardEntries(2, 'Renamed socket'),
    });
    const after = await apiGet(`/api/admin/catalog/sealed/templates/${guardTemplateId}`, token);
    expect(after.entries.map((e: any) => e.action_label)).toEqual([
      'Renamed socket 1',
      'Renamed socket 2',
    ]);
    const usage = await apiGet(
      `/api/admin/catalog/sealed/templates/${guardTemplateId}/usage`,
      token,
    );
    expect(usage.flatMap((u: any) => u.stranded)).toEqual([]);
  });

  itStack('refuses to delete a sealed template a published blueprint depends on', async () => {
    const { status, body } = await apiRaw(
      'DELETE',
      `/api/admin/catalog/sealed/templates/${guardTemplateId}`,
      token,
    );
    expect(status).toBe(409);
    expect(
      (body.details as string[]).some(
        (d) => d.includes(`E2E Guard ${SUFFIX}`) && d.includes('slot sockets'),
      ),
    ).toBe(true);
    // Still there — the FK would have refused it too, but as an unexplained 500.
    await apiGet(`/api/admin/catalog/sealed/templates/${guardTemplateId}`, token);
  });

  itStack('proceeds on force, and then reports the reference it broke', async () => {
    await apiPatch(`/api/admin/catalog/sealed/templates/${guardTemplateId}`, token, {
      entries: guardEntries(1),
      force: true,
    });
    const usage = await apiGet(
      `/api/admin/catalog/sealed/templates/${guardTemplateId}/usage`,
      token,
    );
    const mine = usage.find((u: any) => u.key === GUARD_KEY);
    expect(mine.stranded).toHaveLength(1);
    expect(mine.stranded[0]).toContain('i2c_socket_8_2');

    // Putting the entry back needs no force: the reference resolves again, so the guard is silent.
    await apiPatch(`/api/admin/catalog/sealed/templates/${guardTemplateId}`, token, {
      entries: guardEntries(2),
    });
    const healed = await apiGet(
      `/api/admin/catalog/sealed/templates/${guardTemplateId}/usage`,
      token,
    );
    expect(healed.flatMap((u: any) => u.stranded)).toEqual([]);
  });
});
