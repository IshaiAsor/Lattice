import { db } from '../db';

// One ownership check, shared by every reader and writer of per-device data.
//
// Extracted out of history.service.ts when retention grew its own device- and action-scoped tier
// endpoints (F18.12). A second copy of this would be the thing that drifts: history says 404 for a
// missing id and 403 for someone else's, and a retention endpoint that answered differently would
// let an id probe distinguish "does not exist" from "not yours" on exactly the data most worth
// probing.
//
// 404 for missing, 403 for not-yours — deliberately, and consistently. Returning 404 for both would
// hide existence better, but the platform already leaks it everywhere else (a device you own that
// was deleted vs one that never existed), so the value is in the two codes MATCHING everywhere, not
// in one of them being clever.

export async function ensureActionOwned(userId: number, actionId: number): Promise<void> {
  const row = await db.userDeviceAction.findUnique({
    where: { id: actionId },
    select: { user_device: { select: { user_id: true } } },
  });
  if (!row) throw Object.assign(new Error('Action not found'), { statusCode: 404 });
  if (row.user_device.user_id !== userId)
    throw Object.assign(new Error('Forbidden'), { statusCode: 403 });
}

export async function ensureDeviceOwned(userId: number, deviceId: number): Promise<void> {
  const row = await db.userDevice.findUnique({
    where: { id: deviceId },
    select: { user_id: true },
  });
  if (!row) throw Object.assign(new Error('Device not found'), { statusCode: 404 });
  if (row.user_id !== userId) throw Object.assign(new Error('Forbidden'), { statusCode: 403 });
}
