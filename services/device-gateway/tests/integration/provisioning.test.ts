import request from 'supertest';
import { db } from '@lattice/prisma-client';
import { mockRedisInstance } from '../__mocks__/ioredis';
import { createTestApp } from '../helpers/app';
import {
  makeProvisioningToken,
  makeDeviceUsageToken,
  makeDeviceRefreshToken,
  decodeToken,
} from '../helpers/jwt';
import { JwtPurpose } from '../../services/jwt.service';

const fn = <T>(f: T): jest.Mock => f as unknown as jest.Mock;

beforeEach(() => {
  mockRedisInstance.get.mockResolvedValue(null);
  mockRedisInstance.set.mockResolvedValue('OK');
  mockRedisInstance.del.mockResolvedValue(1);
  mockRedisInstance.keys.mockResolvedValue([]);
  mockRedisInstance.exists.mockResolvedValue(0);
});

// ─── Shared fixtures ──────────────────────────────────────────────────────────

const USER_ID          = 1;
const DEVICE_ID        = 42;
const MODEL_ID         = 10;
const MAC_ID           = 'AA:BB:CC:DD:EE:FF';
const MODEL_KEY        = 'esp32_cam';
const VERSION          = '2.0.81';
const DEVICE_UNIQUE_ID = 'ABC123456789';  // hardware eFuse ID

const PROV_CLIENT_ID = `${USER_ID}_provisioning`;

const stubDevice: any = {
  id:                   DEVICE_ID,
  user_id:              USER_ID,
  user_device_model_id: MODEL_ID,
  mac_id:               null,
  name:                 'Esp32 Cam',
  online:               false,
  last_seen_at:         null,
  created_at:           new Date('2024-01-01'),
  updated_at:           new Date('2024-01-01'),
};

const stubBoundDevice: any = { ...stubDevice, mac_id: MAC_ID };

const stubModel: any = {
  id:           MODEL_ID,
  user_id:      USER_ID,
  model_key:    MODEL_KEY,
  version:      VERSION,
  display_name: 'Esp32 Cam',
};

// ─── App ─────────────────────────────────────────────────────────────────────

const app = createTestApp();

// Helper: build a provisioning request body with all required fields.
function provBody(overrides: Record<string, unknown> = {}) {
  return {
    mac_id:              MAC_ID,
    model_key:           MODEL_KEY,
    version:             VERSION,
    deviceId:            DEVICE_UNIQUE_ID,
    provisioningClientId: PROV_CLIENT_ID,
    ...overrides,
  };
}

// ═════════════════════════════════════════════════════════════════════════════
// Suite 1 — POST /api/provision/register  (single-step provisioning)
//
// New flow: one request returns permanent device_usage tokens immediately.
// Required body fields: mac_id (or macAddress), model_key (or deviceType),
//   version, deviceId, provisioningClientId.
// Auth: Bearer device_provisioning JWT (or user_id in body).
// ═════════════════════════════════════════════════════════════════════════════

describe('POST /api/provision/register', () => {

  // ── Validation ─────────────────────────────────────────────────────────────

  describe('TC-P-01 missing mac_id → 400', () => {
    it('returns 400', async () => {
      const res = await request(app).post('/api/provision/register').send(
        provBody({ mac_id: undefined }),
      );
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/mac_id/);
    });
  });

  describe('TC-P-02 missing model_key → 400', () => {
    it('returns 400', async () => {
      const res = await request(app).post('/api/provision/register').send(
        provBody({ model_key: undefined }),
      );
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/model_key/);
    });
  });

  describe('TC-P-03 missing version → 400', () => {
    it('returns 400', async () => {
      const res = await request(app).post('/api/provision/register').send(
        provBody({ version: undefined }),
      );
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/version/);
    });
  });

  describe('TC-P-04 missing deviceId → 400', () => {
    it('returns 400 when hardware device ID is absent', async () => {
      const res = await request(app).post('/api/provision/register').send(
        provBody({ deviceId: undefined }),
      );
      expect(res.status).toBe(400);
    });
  });

  describe('TC-P-05 missing provisioningClientId → 400', () => {
    it('returns 400 when provisioningClientId is absent', async () => {
      const res = await request(app).post('/api/provision/register').send(
        provBody({ provisioningClientId: undefined }),
      );
      expect(res.status).toBe(400);
    });
  });

  describe('TC-P-06 provisioningClientId mismatch → 400', () => {
    it('rejects when clientId does not match the user in the JWT', async () => {
      fn(db.userDevice.findUnique).mockResolvedValue(null);
      const token = makeProvisioningToken({ id: USER_ID, deviceId: DEVICE_ID, mac_id: MAC_ID });

      const res = await request(app)
        .post('/api/provision/register')
        .set('Authorization', `Bearer ${token}`)
        .send(provBody({ provisioningClientId: '999_provisioning' }));  // wrong user

      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/provisioningClientId/i);
    });
  });

  describe('TC-P-07 wrong JWT purpose (device_usage) → 400', () => {
    it('rejects a device_usage token — provisioningClientId cannot be verified', async () => {
      fn(db.userDevice.findUnique).mockResolvedValue(null);
      const wrongToken = makeDeviceUsageToken({ id: USER_ID, deviceId: DEVICE_ID, mac_id: MAC_ID });

      const res = await request(app)
        .post('/api/provision/register')
        .set('Authorization', `Bearer ${wrongToken}`)
        .send(provBody());

      expect(res.status).toBe(400);
    });
  });

  // ── Happy paths ────────────────────────────────────────────────────────────

  describe('TC-P-08 new device, unbound placeholder exists → 200 with permanent token', () => {
    it('returns device_usage token and device config URLs', async () => {
      fn(db.userDevice.findUnique).mockResolvedValue(null);
      fn(db.userDevice.findFirst).mockResolvedValue(stubDevice);

      const provToken = makeProvisioningToken({ id: USER_ID, deviceId: DEVICE_ID, mac_id: MAC_ID });

      const res = await request(app)
        .post('/api/provision/register')
        .set('Authorization', `Bearer ${provToken}`)
        .send(provBody());

      expect(res.status).toBe(200);
      expect(res.body.clientId).toBe(DEVICE_ID);
      expect(res.body.permanentToken).toBeDefined();
      expect(res.body.refreshToken).toBeDefined();
      expect(res.body.deviceConfigUrl).toContain('/api/config');
      expect(res.body.refreshTokenCallbackUrl).toContain('token/refresh');

      const { valid, decoded } = decodeToken(res.body.permanentToken, JwtPurpose.device_usage);
      expect(valid).toBe(true);
      expect(decoded?.id).toBe(USER_ID);
      expect(decoded?.deviceId).toBe(DEVICE_ID);
      expect(decoded?.mac_id).toBe(MAC_ID);

      // Slot was found — no creation
      expect(db.userDeviceModel.create).not.toHaveBeenCalled();
      expect(db.userDevice.create).not.toHaveBeenCalled();
    });
  });

  describe('TC-P-09 user_id extracted from provisioning JWT → 200', () => {
    it('resolves user from Bearer token and issues permanent token', async () => {
      fn(db.userDevice.findUnique).mockResolvedValue(null);
      fn(db.userDevice.findFirst).mockResolvedValue(stubDevice);

      const provToken = makeProvisioningToken({ id: USER_ID, deviceId: DEVICE_ID, mac_id: MAC_ID });

      const res = await request(app)
        .post('/api/provision/register')
        .set('Authorization', `Bearer ${provToken}`)
        .send(provBody());

      expect(res.status).toBe(200);
      const { valid } = decodeToken(res.body.permanentToken, JwtPurpose.device_usage);
      expect(valid).toBe(true);
    });
  });

  describe('TC-P-10 no unbound placeholder — auto-creates device slot → 200', () => {
    it('creates UserDeviceModel + UserDevice and issues permanent token', async () => {
      fn(db.userDevice.findUnique).mockResolvedValue(null);
      fn(db.userDevice.findFirst).mockResolvedValue(null);
      fn(db.userDeviceModel.findFirst).mockResolvedValue(null);
      fn(db.userDeviceModel.create).mockResolvedValue(stubModel);
      fn(db.userDevice.create).mockResolvedValue(stubDevice);

      const provToken = makeProvisioningToken({ id: USER_ID, deviceId: DEVICE_ID, mac_id: MAC_ID });

      const res = await request(app)
        .post('/api/provision/register')
        .set('Authorization', `Bearer ${provToken}`)
        .send(provBody());

      expect(res.status).toBe(200);
      expect(res.body.clientId).toBe(DEVICE_ID);

      expect(db.userDeviceModel.create).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ user_id: USER_ID, model_key: MODEL_KEY }) }),
      );
      expect(db.userDevice.create).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ user_id: USER_ID }) }),
      );
    });
  });

  describe('TC-P-11 v1 field names (macAddress + deviceType) → 200', () => {
    it('accepts v1 field names, lowercases deviceType', async () => {
      fn(db.userDevice.findUnique).mockResolvedValue(null);
      fn(db.userDevice.findFirst).mockResolvedValue(stubDevice);

      const provToken = makeProvisioningToken({ id: USER_ID, deviceId: DEVICE_ID, mac_id: MAC_ID });

      const res = await request(app)
        .post('/api/provision/register')
        .set('Authorization', `Bearer ${provToken}`)
        .send({
          macAddress:           MAC_ID,
          deviceType:           'ESP32_CAM',
          version:              VERSION,
          deviceId:             DEVICE_UNIQUE_ID,
          provisioningClientId: PROV_CLIENT_ID,
        });

      expect(res.status).toBe(200);

      expect(db.userDevice.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            device_model: expect.objectContaining({ model_key: 'esp32_cam' }),
          }),
        }),
      );
    });
  });

  describe('TC-P-12 re-provisioning (mac_id already bound) → 200 with new permanent tokens', () => {
    it('finds existing device and issues fresh tokens without creating a new slot', async () => {
      fn(db.userDevice.findUnique).mockResolvedValue(stubBoundDevice);

      const provToken = makeProvisioningToken({ id: USER_ID, deviceId: DEVICE_ID, mac_id: MAC_ID });

      const res = await request(app)
        .post('/api/provision/register')
        .set('Authorization', `Bearer ${provToken}`)
        .send(provBody());

      expect(res.status).toBe(200);
      expect(res.body.clientId).toBe(DEVICE_ID);

      const { valid, decoded } = decodeToken(res.body.permanentToken, JwtPurpose.device_usage);
      expect(valid).toBe(true);
      expect(decoded?.mac_id).toBe(MAC_ID);

      // Re-provisioning must NOT create a new slot
      expect(db.userDevice.findFirst).not.toHaveBeenCalled();
      expect(db.userDevice.create).not.toHaveBeenCalled();
    });
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// Suite 2 — POST /api/provision/token/refresh
// ═════════════════════════════════════════════════════════════════════════════

describe('POST /api/provision/token/refresh', () => {

  describe('TC-R-01 no Authorization header → 401', () => {
    it('rejects requests with no token', async () => {
      const res = await request(app).post('/api/provision/token/refresh').send();
      expect(res.status).toBe(401);
    });
  });

  describe('TC-R-02 provisioning token (wrong purpose) → 403', () => {
    it('rejects a provisioning token on the refresh endpoint', async () => {
      const token = makeProvisioningToken({ id: USER_ID, deviceId: DEVICE_ID, mac_id: MAC_ID });

      const res = await request(app)
        .post('/api/provision/token/refresh')
        .set('Authorization', `Bearer ${token}`)
        .send();

      expect(res.status).toBe(403);
    });
  });

  describe('TC-R-03 device_usage_refresh token (wrong purpose for this endpoint) → 403', () => {
    it('rejects device_usage_refresh — endpoint expects device_usage', async () => {
      const token = makeDeviceRefreshToken({ id: USER_ID, deviceId: DEVICE_ID, mac_id: MAC_ID });

      const res = await request(app)
        .post('/api/provision/token/refresh')
        .set('Authorization', `Bearer ${token}`)
        .send();

      expect(res.status).toBe(403);
    });
  });

  describe('TC-R-04 valid device_usage token → 200 with renewed device_usage token', () => {
    it('issues a fresh device_usage JWT with the same payload', async () => {
      const usageToken = makeDeviceUsageToken({ id: USER_ID, deviceId: DEVICE_ID, mac_id: MAC_ID });

      const res = await request(app)
        .post('/api/provision/token/refresh')
        .set('Authorization', `Bearer ${usageToken}`)
        .send();

      expect(res.status).toBe(200);
      expect(res.body.token).toBeDefined();

      const { valid, decoded } = decodeToken(res.body.token, JwtPurpose.device_usage);
      expect(valid).toBe(true);
      expect(decoded?.id).toBe(USER_ID);
      expect(decoded?.deviceId).toBe(DEVICE_ID);
      expect(decoded?.mac_id).toBe(MAC_ID);
    });
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// Suite 3 — End-to-End provisioning flow (single-step)
// ═════════════════════════════════════════════════════════════════════════════

describe('End-to-End provisioning flow', () => {

  describe('TC-E-01 register → token/refresh (full new flow)', () => {
    it('single register call produces permanent tokens; refresh renews device_usage', async () => {
      // ── Step 1: register ──────────────────────────────────────────────────
      fn(db.userDevice.findUnique).mockResolvedValue(null);
      fn(db.userDevice.findFirst).mockResolvedValue(stubDevice);

      const provToken = makeProvisioningToken({ id: USER_ID, deviceId: DEVICE_ID, mac_id: MAC_ID });

      const registerRes = await request(app)
        .post('/api/provision/register')
        .set('Authorization', `Bearer ${provToken}`)
        .send(provBody());

      expect(registerRes.status).toBe(200);
      const usageToken = registerRes.body.permanentToken;

      expect(decodeToken(usageToken,                   JwtPurpose.device_usage).valid).toBe(true);
      expect(decodeToken(registerRes.body.refreshToken, JwtPurpose.device_usage_refresh).valid).toBe(true);

      // ── Step 2: refresh ───────────────────────────────────────────────────
      const refreshRes = await request(app)
        .post('/api/provision/token/refresh')
        .set('Authorization', `Bearer ${usageToken}`)
        .send();

      expect(refreshRes.status).toBe(200);

      const { valid, decoded } = decodeToken(refreshRes.body.token, JwtPurpose.device_usage);
      expect(valid).toBe(true);
      expect(decoded?.id).toBe(USER_ID);
      expect(decoded?.deviceId).toBe(DEVICE_ID);
      expect(decoded?.mac_id).toBe(MAC_ID);
    });
  });

  describe('TC-E-02 re-provisioning: device already registered, re-registers', () => {
    it('issues fresh permanent tokens without creating duplicate slots', async () => {
      fn(db.userDevice.findUnique).mockResolvedValue(stubBoundDevice);

      const provToken = makeProvisioningToken({ id: USER_ID, deviceId: DEVICE_ID, mac_id: MAC_ID });

      const registerRes = await request(app)
        .post('/api/provision/register')
        .set('Authorization', `Bearer ${provToken}`)
        .send(provBody());

      expect(registerRes.status).toBe(200);

      const { valid } = decodeToken(registerRes.body.permanentToken, JwtPurpose.device_usage);
      expect(valid).toBe(true);

      // No new slot created
      expect(db.userDevice.create).not.toHaveBeenCalled();
    });
  });
});
