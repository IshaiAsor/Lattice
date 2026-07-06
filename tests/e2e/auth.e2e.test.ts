// E2E: auth domain — token lifecycle against the real api service.
// Mutating only in the sense of issuing tokens; creates no persistent rows, so it is
// acceptance-safe on staging (docs/TESTING.md).

import { itStack, API_URL, TEST_USER, TEST_PASS, apiGet } from './helpers/stack';
import { signJwt, JwtPurpose } from '../../packages/jwt/src';

jest.setTimeout(30000);

async function loginRaw(username: string, password: string): Promise<Response> {
  return fetch(`${API_URL}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password }),
  });
}

describe('auth e2e', () => {
  itStack('login returns an access + refresh token pair', async () => {
    const r = await loginRaw(TEST_USER, TEST_PASS);
    expect(r.status).toBe(200);
    const body = await r.json();
    expect(typeof body.token).toBe('string');
    expect(typeof body.refreshToken).toBe('string');
    expect(body.token).not.toBe(body.refreshToken);
  });

  itStack('refresh-token rotation returns a new working pair', async () => {
    const first = await (await loginRaw(TEST_USER, TEST_PASS)).json();

    const r = await fetch(`${API_URL}/api/auth/refresh-token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ refreshToken: first.refreshToken }),
    });
    expect(r.status).toBe(200);
    const second = await r.json();
    expect(typeof second.token).toBe('string');
    expect(typeof second.refreshToken).toBe('string');

    // The rotated access token must work on a protected route.
    const devices = await apiGet('/api/devices', second.token);
    expect(Array.isArray(devices)).toBe(true);
  });

  itStack('a refresh token is rejected as an access token (purpose boundary)', async () => {
    const { refreshToken } = await (await loginRaw(TEST_USER, TEST_PASS)).json();
    const r = await fetch(`${API_URL}/api/devices`, {
      headers: { Authorization: `Bearer ${refreshToken}` },
    });
    expect([401, 403]).toContain(r.status);
  });

  itStack('a wrong-purpose token signed with the real secret is rejected', async () => {
    // Local-only: needs JWT_SECRET (from .env.test) to forge the token. Skipped on staging,
    // where the secret is (correctly) not available to the test runner.
    const secret = process.env.JWT_SECRET;
    if (!secret) {
      console.warn('SKIP: JWT_SECRET not available — wrong-purpose forgery check needs it');
      return;
    }
    const deviceToken = signJwt(
      { userId: '1', id: 1, purpose: JwtPurpose.device_usage },
      secret,
      '5m',
    );
    const r = await fetch(`${API_URL}/api/devices`, {
      headers: { Authorization: `Bearer ${deviceToken}` },
    });
    expect([401, 403]).toContain(r.status);
  });

  itStack('garbage and missing tokens are rejected', async () => {
    const garbage = await fetch(`${API_URL}/api/devices`, {
      headers: { Authorization: 'Bearer not-a-jwt' },
    });
    expect([401, 403]).toContain(garbage.status);

    const missing = await fetch(`${API_URL}/api/devices`);
    expect([401, 403]).toContain(missing.status);
  });
});
