import { db } from './db/client';
import { resolveAction } from './cache/valkey';
import type { ResolvedAction } from './cache/valkey';

// DeviceAction.implementation_type values that produce image/camera-frame telemetry
// rather than scalar sensor readings. Anything else is treated as scalar.
const IMAGE_IMPL_TYPES = new Set([
  'TakePictureAction',
  'LiveStreamAction',
  'TakePictureHttpAction',
  'LiveStreamHttpAction',
]);

// Resolve a (deviceId, actionName) pair to its UserDeviceAction id + kind, via the
// Valkey cache with a DB-join fallback. Shared by the telemetry consumer (actual
// state coming in) and the action-dispatch consumer (desired state going out).
export function resolveUserDeviceAction(
  deviceId: string,
  actionName: string,
): Promise<ResolvedAction | null> {
  return resolveAction(deviceId, actionName, async () => {
    const row = await db.userDeviceAction.findFirst({
      where:  { user_device_id: parseInt(deviceId, 10), mqtt_action_name: actionName },
      select: { id: true, action: { select: { implementation_type: true } } },
    });
    if (!row) return null;
    const kind = IMAGE_IMPL_TYPES.has(row.action.implementation_type) ? 'image' : 'scalar';
    return { id: row.id, kind } satisfies ResolvedAction;
  });
}
