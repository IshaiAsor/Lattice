// Sanity: device domains (provisioning/telemetry/commands, read side) — READ-ONLY
// (docs/TESTING.md safety model). Safe against any env. Mutating coverage of these
// domains lives in tests/e2e/ (acceptance on staging).

import { itStack, login, apiGet } from '../e2e/helpers/stack';

describe('sanity: devices', () => {
  itStack('device list and action list respond with well-formed data', async () => {
    const token = await login();

    const devices = await apiGet('/api/devices', token);
    expect(Array.isArray(devices)).toBe(true);
    for (const d of devices) {
      expect(typeof d.id).toBe('number');
    }

    const actions = await apiGet('/api/actions', token);
    expect(Array.isArray(actions)).toBe(true);
  });

  itStack('capability catalog is seeded', async () => {
    const token = await login();
    const catalog = await apiGet('/api/admin/catalog/devices', token);
    expect(Array.isArray(catalog)).toBe(true);
    expect(catalog.length).toBeGreaterThan(0); // empty catalog = provisioning is broken
  });
});
