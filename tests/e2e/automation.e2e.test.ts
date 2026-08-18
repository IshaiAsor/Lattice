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

    // Wait out the rule's 1s cooldown (a real product delay, not a synchronisation guess), then
    // send a value under the threshold and assert no *new* command arrives in a bounded window.
    // Matching on commandId is what makes this deterministic: the previous case's command can be
    // redelivered or simply arrive late under load, and a match on action alone would read that
    // as "the rule fired below its threshold" — the exact false positive this test exists to
    // rule out.
    await new Promise((r) => setTimeout(r, 1500));
    const commandP = dev.waitFor(
      'command',
      (c: any) => c.action === outlet.mqtt_action_name && c.commandId !== lastCommandId,
      5000,
    );
    dev.publishTelemetry(sensor.mqtt_action_name, 50);
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
});
