import { Server } from 'socket.io';
import { createAdapter } from '@socket.io/redis-adapter';
import IORedis from 'ioredis';
import http from 'http';
import { JwtPurpose, jwtService } from './jwt.service';
import config from '../config/env.config';
import { createLogger } from '@lattice/logger';
import { publish, RK } from '@lattice/queue';

const log = createLogger('api:socket');

class SocketService {
  private io?: Server;

  init(server: http.Server): void {
    const pubClient = new IORedis(config.valkey.url, {
      username: config.valkey.username,
      password: config.valkey.password,
      lazyConnect: true,
    });
    const subClient = pubClient.duplicate();

    this.io = new Server(server, { cors: { origin: '*' } });
    this.io.adapter(createAdapter(pubClient, subClient));

    // JWT auth on every Socket.IO connection
    this.io.use((socket, next) => {
      const token = socket.handshake.auth?.token as string | undefined;
      if (!token) return next(new Error('Authentication error: token missing'));

      const result = jwtService.verifyToken(token, JwtPurpose.app_usage);
      if (!result.valid) return next(new Error('Authentication error: invalid token'));

      socket.data.user = result.decoded;
      next();
    });

    this.io.on('connection', (socket) => {
      const userId: number = socket.data.user.id;
      socket.join(`user_${userId}`);
      log.info({ userId }, 'socket connected');

      socket.on('disconnect', () => log.info({ userId }, 'socket disconnected'));

      // User-initiated action state change (e.g. toggle from UI)
      socket.on('action_state_update', async (data: { actionId: number; userDeviceId: number; mqttType: string; mqttName: string; state: string }) => {
        await publish(RK.actionDispatch(userId), {
          userId,
          userDeviceId: data.userDeviceId,
          mqttType: data.mqttType,
          mqttName: data.mqttName,
          value: data.state,
        }).catch((err) => log.error(err, 'Failed to publish action_state_update'));
        this.publishActionStateUpdate(userId, data.actionId, data.state);
      });
    });

    log.info('Socket.IO server initialised with Valkey adapter');
  }

  // ─── Emit helpers (used by api directly and by workers via Valkey pub/sub) ──

  publishActionStateUpdate(userId: number, actionId: number, state: string): void {
    this.io?.to(`user_${userId}`).emit('action_state_update', { actionId, state });
  }

  publishDeviceStatusUpdate(userId: number, deviceId: number, online: boolean): void {
    this.io?.to(`user_${userId}`).emit('device_status_change', { deviceId, online });
  }

  publishEmergencyAlert(userId: number, payload: object): void {
    this.io?.to(`user_${userId}`).emit('emergency_alert', payload);
  }

  publishVlmError(userId: number, payload: object): void {
    this.io?.to(`user_${userId}`).emit('vlm_error', payload);
  }

  publishPipelineResult(userId: number, payload: object): void {
    this.io?.to(`user_${userId}`).emit('pipeline_result', payload);
  }
}

export default new SocketService();
