// Unit: auth domain — @lattice/jwt purpose/expiry verification matrix. Purposes are the
// security boundary between app, device, and Google tokens: a token signed for one purpose
// must never verify as another.

import { signJwt, verifyJwt, JwtService, JwtPurpose } from '../../packages/jwt/src';

const SECRET = 'unit-test-secret';

describe('verifyJwt', () => {
  it('accepts a token with the expected purpose', () => {
    const token = signJwt({ userId: '1', purpose: JwtPurpose.app_usage }, SECRET, '5m');
    const result = verifyJwt<{ userId: string; purpose: JwtPurpose }>(
      token,
      JwtPurpose.app_usage,
      SECRET,
    );
    expect(result.valid).toBe(true);
    if (result.valid) expect(result.decoded.userId).toBe('1');
  });

  // Full cross-purpose matrix: every purpose must fail verification against every OTHER
  // purpose (e.g. a refresh token used as an access token, a device token on an app route).
  const purposes = Object.values(JwtPurpose);
  it.each(
    purposes.flatMap((signed) =>
      purposes.filter((v) => v !== signed).map((verified) => [signed, verified]),
    ),
  )('rejects a "%s" token verified as "%s"', (signedPurpose, verifiedPurpose) => {
    const token = signJwt({ userId: '1', purpose: signedPurpose }, SECRET, '5m');
    const result = verifyJwt(token, verifiedPurpose as JwtPurpose, SECRET);
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.err).toContain('purpose');
  });

  it('rejects an expired token', () => {
    const token = signJwt({ userId: '1', purpose: JwtPurpose.app_usage }, SECRET, '-1s');
    const result = verifyJwt(token, JwtPurpose.app_usage, SECRET);
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.err).toContain('expired');
  });

  it('rejects a token signed with a different secret', () => {
    const token = signJwt({ userId: '1', purpose: JwtPurpose.app_usage }, 'other-secret', '5m');
    expect(verifyJwt(token, JwtPurpose.app_usage, SECRET).valid).toBe(false);
  });

  it('rejects a tampered token', () => {
    const token = signJwt({ userId: '1', purpose: JwtPurpose.app_usage }, SECRET, '5m');
    const parts = token.split('.');
    const tamperedPayload = Buffer.from(
      JSON.stringify({ userId: '999', purpose: JwtPurpose.app_usage }),
    ).toString('base64url');
    const tampered = `${parts[0]}.${tamperedPayload}.${parts[2]}`;
    expect(verifyJwt(tampered, JwtPurpose.app_usage, SECRET).valid).toBe(false);
  });

  it('rejects garbage input', () => {
    expect(verifyJwt('not-a-jwt', JwtPurpose.app_usage, SECRET).valid).toBe(false);
    expect(verifyJwt('', JwtPurpose.app_usage, SECRET).valid).toBe(false);
  });
});

describe('JwtService', () => {
  const svc = new JwtService(SECRET, { [JwtPurpose.app_usage]: 300 });

  it('generates and verifies a token for a configured purpose', () => {
    const token = svc.generateToken({ id: 7 }, JwtPurpose.app_usage);
    const result = svc.verifyToken(token, JwtPurpose.app_usage);
    expect(result.valid).toBe(true);
    expect(result.decoded.id).toBe(7);
  });

  it('throws when generating for a purpose with no configured expiry', () => {
    expect(() => svc.generateToken({ id: 7 }, JwtPurpose.device_usage)).toThrow(
      /No expiry configured/,
    );
  });
});
