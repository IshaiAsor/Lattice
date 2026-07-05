import { randomUUID } from 'node:crypto';
import type { Channel } from 'amqplib';
import {
  consume,
  publish,
  RK,
  QUEUES,
  type PictureRequestedPayload,
  type PictureResultPayload,
} from '@lattice/queue';
import { createLogger } from '@lattice/logger';

const log = createLogger('ml-router:pipeline:picture-capture');

// Resolvers for in-flight picture requests, keyed by commandId. requestPicture() registers
// one before publishing; the PICTURE_RESULT consumer (registered once via
// registerPictureResultConsumer) resolves it on arrival. A local setTimeout is the safety
// net if the PICTURE_RESULT message itself never shows up (e.g. digest-service restarted
// mid-request) — digest-service's own timeout is the primary path.
const pending = new Map<string, (result: PictureResultPayload) => void>();

export async function registerPictureResultConsumer(ch: Channel): Promise<void> {
  await consume<PictureResultPayload>(ch, QUEUES.PICTURE_RESULT, async (result) => {
    // Never log result.image — it's a base64 JPEG.
    log.info({ commandId: result.commandId, status: result.status }, 'PICTURE_RESULT received');
    const resolve = pending.get(result.commandId);
    if (!resolve) return; // already resolved locally (safety-net timeout beat it), or unknown
    pending.delete(result.commandId);
    resolve(result);
  });
}

// Requests a fresh camera frame for the given action and waits for the correlated result
// (or a local timeout fallback if the message never arrives). Never rejects — a failed
// capture resolves with status 'timeout' so the caller can fall back to the last stored frame.
export async function requestPicture(
  ch: Channel,
  userId: number,
  actionId: number,
  timeoutMs: number,
): Promise<PictureResultPayload> {
  const commandId = randomUUID();

  const result = await new Promise<PictureResultPayload>((resolve) => {
    pending.set(commandId, resolve);

    const localTimeout = setTimeout(() => {
      if (pending.delete(commandId)) {
        log.warn(
          { commandId, actionId },
          'picture request had no PICTURE_RESULT — local timeout fallback',
        );
        resolve({ commandId, status: 'timeout' });
      }
    }, timeoutMs + 2000); // small buffer past digest-service's own timeout
    localTimeout.unref?.();

    const payload: PictureRequestedPayload = {
      userId: String(userId),
      actionId,
      commandId,
      timeoutMs,
    };
    publish(ch, RK.PICTURE_REQUESTED, payload);
    log.info({ commandId, actionId, timeoutMs }, 'picture.requested published');
  });

  return result;
}
