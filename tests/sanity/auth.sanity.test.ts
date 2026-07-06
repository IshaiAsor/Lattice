// Sanity: auth domain — READ-ONLY (docs/TESTING.md safety model). Safe against any env.

import { itStack, login, apiGet, API_URL } from '../e2e/helpers/stack';

describe('sanity: auth', () => {
  itStack('login round-trip returns a token that works on a protected route', async () => {
    const token = await login();
    expect(typeof token).toBe('string');
    expect(token.split('.').length).toBe(3); // JWT shape
    const devices = await apiGet('/api/devices', token);
    expect(Array.isArray(devices)).toBe(true);
  });

  itStack('bad credentials are rejected', async () => {
    const r = await fetch(`${API_URL}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'nobody', password: 'wrong-password' }),
    });
    expect(r.ok).toBe(false);
    expect([400, 401, 403]).toContain(r.status);
  });

  itStack('protected route without a token is rejected', async () => {
    const r = await fetch(`${API_URL}/api/devices`);
    expect([401, 403]).toContain(r.status);
  });
});
