import { SOCKET_EVENTS } from '@lattice/ioredis';
import { Emitter } from '@socket.io/redis-emitter';
import IORedis from 'ioredis';
import { createLogger } from '@lattice/logger';
import { env } from '../config/env.config';

const log = createLogger('ml-router:pipeline:socket');

const valkeyClient = new IORedis(env.valkeyConfig.url, {
  username: env.valkeyConfig.username,
  password: env.valkeyConfig.password,
  lazyConnect: true,
});
valkeyClient.connect().catch((err) => log.error({ err }, 'Valkey connect failed'));

const socketEmitter = new Emitter(valkeyClient as never);

export function emitPipelineRunUpdate(
  userId: number,
  update: { runId: number; pipelineId: number; status: string; error?: string },
): void {
  log.trace({ userId, ...update }, 'emitting pipeline run update to socket room');
  socketEmitter.to(`user_${userId}`).emit(SOCKET_EVENTS.PIPELINE_RUN_UPDATE, update);
}
