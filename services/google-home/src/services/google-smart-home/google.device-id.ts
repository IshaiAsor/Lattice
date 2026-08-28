// Google addresses everything in a user's home by one opaque device id, and until F7.12 that id
// was always a stringified `user_device_actions.id`. Scenes are a different table with its own
// autoincrement, so scene 12 and action 12 would arrive as the same `"12"` and EXECUTE would
// command whichever one it looked up first.
//
// The fix is a namespace prefix on the new kind only: existing action ids keep their exact wire
// format, so an already-linked account does not have to re-link or re-sync to keep working.

export const SCENE_ID_PREFIX = 'scene:';

export type GoogleDeviceRef = { kind: 'action' | 'scene'; id: number };

export function sceneDeviceId(sceneId: number): string {
  return `${SCENE_ID_PREFIX}${sceneId}`;
}

export function actionDeviceId(actionId: number): string {
  return String(actionId);
}

/**
 * Parse an id Google sent back. Returns null for anything that is not one of ours — a stale id
 * from a since-deleted device, or a malformed one — which the caller answers as deviceNotFound
 * rather than coercing (`parseInt('scene:12')` is NaN, and `parseInt('12abc')` is a silent 12).
 */
export function parseGoogleDeviceId(raw: string): GoogleDeviceRef | null {
  const isPositiveInt = (s: string): boolean => /^[1-9][0-9]*$/.test(s);

  if (raw.startsWith(SCENE_ID_PREFIX)) {
    const rest = raw.slice(SCENE_ID_PREFIX.length);
    return isPositiveInt(rest) ? { kind: 'scene', id: Number(rest) } : null;
  }
  return isPositiveInt(raw) ? { kind: 'action', id: Number(raw) } : null;
}
