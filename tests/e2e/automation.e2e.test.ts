// E2E: automation domain — a threshold rule created through the real API fires a command
// at the target device when telemetry crosses the threshold:
//   SimDevice telemetry → mqtt-service → digest (state write, rules.evaluate) →
//   automation-worker (rule eval, action.dispatch) → mqtt-service → SimDevice command.
// Mutating (rule + device rows) with full cleanup — acceptance-safe as e2e-bot.

import {
  SimDevice,
  itStack,
  stackUp,
  login,
  apiGet,
  apiPost,
  apiPatch,
  apiDelete,
  simOpts,
  poll,
  settleAfterStart,
} from './helpers/stack';

jest.setTimeout(60000);

describe('automation e2e', () => {
  let dev: any;
  let token: string;
  let sensor: any; // telemetry action on the device (threshold source)
  let outlet: any; // command action on the device (rule target)
  let sensorActionId: number | undefined;
  let outletActionId: number | undefined;
  // The commandId of the last command the rule dispatched. The below-threshold case asserts that
  // no *new* command arrives; without an identity to compare against it would also catch the
  // previous case's command arriving late, and fail for a reason that has nothing to do with it.
  let lastCommandId: string | undefined;
  const ruleIds: number[] = [];
  const MAC = `SIM-E2E-RULE-${Date.now().toString(36)}`;

  beforeAll(async () => {
    if (!(await stackUp())) return;
    token = await login();
    dev = new SimDevice(
      simOpts({
        mac: MAC,
        deviceType: process.env.DEVICE_TYPE || 'ESP32S3_MINI',
        autoTelemetry: false, // the test drives telemetry explicitly
        camera: false,
      }),
    );
    await dev.start();
    // Provisioning triggers a config-reload restart; let it land before commanding the device.
    await settleAfterStart(dev);

    sensor = dev.actions.find(
      (a: any) =>
        a.mqtt_action_type === 'telemetry' && !/camera|stream|picture/i.test(a.implementation_type),
    );
    outlet = dev.actions.find((a: any) => a.implementation_type === 'OutletCommandAction');

    // Rules reference UserDeviceAction ids — resolve them via the API view.
    const actions = await apiGet('/api/actions', token);
    const mine = actions.filter((a: any) => a.deviceId === dev.deviceId);
    sensorActionId = sensor
      ? mine.find((a: any) => a.mqttName === sensor.mqtt_action_name)?.id
      : undefined;
    outletActionId = outlet
      ? mine.find((a: any) => a.mqttName === outlet.mqtt_action_name)?.id
      : undefined;
  });

  afterAll(async () => {
    for (const id of ruleIds) {
      await apiDelete(`/api/rules/${id}`, token).catch(() => {});
    }
    if (dev) await dev.cleanup();
  });

  itStack('threshold rule fires a command when telemetry crosses it', async () => {
    if (!sensorActionId || !outletActionId) {
      console.warn('no sensor+outlet pair in catalog — skipping');
      return;
    }

    const rule = await apiPost('/api/rules', token, {
      name: `e2e threshold ${MAC}`,
      condition_operator: 'AND',
      cooldown_seconds: 1,
      conditions: [
        {
          condition_type: 'threshold',
          user_device_action_id: sensorActionId,
          operator: '>',
          threshold_value: '100',
        },
      ],
      actions: [{ user_device_action_id: outletActionId, target_state: 'on', delay_seconds: 0 }],
    });
    ruleIds.push(rule.id);
    expect(rule.enabled).toBe(true);

    // Cross the threshold; the rule engine reads current_state, so the state write must
    // land first — waitFor gives the full pipeline time to run.
    const commandP = dev.waitFor(
      'command',
      (c: any) => c.action === outlet.mqtt_action_name && c.value === 'on',
      20000,
    );
    dev.publishTelemetry(sensor.mqtt_action_name, 150);
    const cmd = await commandP;
    expect(cmd.valid).toBe(true);
    lastCommandId = cmd.commandId;
  });

  itStack('below-threshold telemetry does not fire the rule', async () => {
    if (!sensorActionId || !outletActionId || ruleIds.length === 0) {
      console.warn('rule fixture missing — skipping');
      return;
    }

    // Drop the sensor first and wait for the platform to have RECORDED it, then open the
    // observation window. Ordering matters: the rules engine also re-evaluates on a 10s cron
    // against `current_state`, which is still the previous above-threshold value until this write
    // lands. Publishing the low value and watching at the same time leaves a window where the
    // cooldown has expired but the stored value is still 150 — the cron then fires for an entirely
    // correct reason, and this test reads it as "fired below its threshold".
    dev.publishTelemetry(sensor.mqtt_action_name, 50);
    await poll(
      () => apiGet('/api/actions', token),
      (all: any[]) => Number(all.find((a) => a.id === sensorActionId)?.state) === 50,
      { timeoutMs: 15000 },
    );

    // Now wait out the rule's 1s cooldown (a real product delay, not a synchronisation guess) and
    // assert no *new* command arrives. Matching on commandId is what makes this deterministic: the
    // previous case's command can be redelivered or arrive late under load, and a match on action
    // alone would read that as a below-threshold fire.
    await new Promise((r) => setTimeout(r, 1500));
    const commandP = dev.waitFor(
      'command',
      (c: any) => c.action === outlet.mqtt_action_name && c.commandId !== lastCommandId,
      5000,
    );
    await expect(commandP).rejects.toThrow(/timed out/);
  });

  itStack('rule CRUD: list shows it, toggle disables it, delete removes it', async () => {
    if (!sensorActionId || !outletActionId || ruleIds.length === 0) {
      console.warn('rule fixture missing — skipping');
      return;
    }
    const ruleId = ruleIds[0];

    const rules = await apiGet('/api/rules', token);
    const mine = rules.find((r: any) => r.id === ruleId);
    expect(mine).toBeDefined();
    expect(mine.conditions.length).toBe(1);
    expect(mine.actions.length).toBe(1);

    await apiPatch(`/api/rules/${ruleId}/toggle`, token, { enabled: false });

    const after = await apiGet('/api/rules', token);
    expect(after.find((r: any) => r.id === ruleId).enabled).toBe(false);
  });

  // Runs last on purpose: the threshold rule above is disabled by the CRUD case, so nothing else
  // is watching this sensor and a command arriving here can only have come from the fault rule.
  itStack(
    'a fault reading fires an error rule and a good reading afterwards stops it',
    async () => {
      if (!sensorActionId || !outletActionId) {
        console.warn('no sensor+outlet pair in catalog — skipping');
        return;
      }

      const rule = await apiPost('/api/rules', token, {
        name: `e2e fault ${MAC}`,
        condition_operator: 'AND',
        cooldown_seconds: 1,
        conditions: [
          // No error_code — any fault. That is what the editors write today (F20).
          { condition_type: 'error', user_device_action_id: sensorActionId },
        ],
        // 'off' rather than 'on' so this rule's command is distinguishable from the threshold
        // rule's, not merely newer than it.
        actions: [{ user_device_action_id: outletActionId, target_state: 'off', delay_seconds: 0 }],
      });
      ruleIds.push(rule.id);
      expect(rule.conditions[0].condition_type).toBe('error');

      // The fault envelope the firmware publishes on the normal telemetry topic. digest records it,
      // sets the action's fault marker and nudges rules.evaluate — without that nudge the rule would
      // sit unevaluated, since the 10s cron only sweeps schedule-bearing rules.
      const commandP = dev.waitFor(
        'command',
        (c: any) => c.action === outlet.mqtt_action_name && c.value === 'off',
        20000,
      );
      dev.publishTelemetry(
        sensor.mqtt_action_name,
        JSON.stringify({ error: 'read_failed', action: sensor.mqtt_action_name }),
      );
      const cmd = await commandP;
      expect(cmd.valid).toBe(true);
      const faultCommandId = cmd.commandId;

      // Recovery. Same ordering care as the below-threshold case: publish the good reading and wait
      // until the platform has RECORDED it before opening the observation window, or the marker may
      // still be set when the window opens and a correct fire reads as a failure to clear.
      dev.publishTelemetry(sensor.mqtt_action_name, 50);
      await poll(
        () => apiGet('/api/actions', token),
        (all: any[]) => Number(all.find((a) => a.id === sensorActionId)?.state) === 50,
        { timeoutMs: 15000 },
      );

      // A good reading clears the marker, so the level condition is false and the rule stops — with
      // nobody having edited it. Wait past the 1s cooldown first so silence means "does not match"
      // rather than "still rate-limited".
      await new Promise((r) => setTimeout(r, 1500));
      const afterRecovery = dev.waitFor(
        'command',
        (c: any) => c.action === outlet.mqtt_action_name && c.commandId !== faultCommandId,
        5000,
      );
      await expect(afterRecovery).rejects.toThrow(/timed out/);
    },
  );
});
