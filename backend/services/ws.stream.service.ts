import { WebSocketServer, WebSocket } from 'ws';
import { IncomingMessage } from 'http';
import { Server } from 'http';
import { jwtService, JwtPurpose } from './jwt.service';
import { userDevicesActionsRepository } from '../dal/user.devices.actions.repository';
import socketService from './socket.service';

class WsStreamService {
  init(server: Server) {
    const wss        = new WebSocketServer({ noServer: true });
    const wssCapture = new WebSocketServer({ noServer: true });

    server.on('upgrade', (req, socket, head) => {
      const url = new URL(req.url!, 'http://localhost');
      if (url.pathname === '/ws/stream') {
        wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
      } else if (url.pathname === '/ws/capture') {
        wssCapture.handleUpgrade(req, socket, head, (ws) => wssCapture.emit('connection', ws, req));
      }
    });

    // ── Live stream (/ws/stream) ─────────────────────────────────────────────
    wss.on('connection', async (ws: WebSocket, req: IncomingMessage) => {
      const url = new URL(req.url!, 'http://localhost');
      const token = url.searchParams.get('token') ?? '';

      const decoded = jwtService.verifyToken(token, JwtPurpose.device_usage);
      if (!decoded.valid) {
        ws.close(4001, 'Unauthorized');
        return;
      }

      const userId   = decoded.decoded.userid   as number;
      const deviceId = decoded.decoded.clientid  as number;

      const actions   = await userDevicesActionsRepository.getByDeviceId(deviceId);
      const camAction = actions.find(a => a.action.implementation_type === 'LiveStreamAction');
      if (!camAction) {
        console.log(`[WS Stream] No LiveStreamAction found for device ${deviceId}`);
        ws.close(4004, 'No stream action configured');
        return;
      }

      console.log(`[WS Stream] Device ${deviceId} connected (user ${userId}, action ${camAction.id})`);

      ws.on('message', (data: Buffer) => {
        const b64 = data.toString('base64');
        socketService.publishActionStateUpdate(userId, camAction.id, b64);
        userDevicesActionsRepository.updateState(camAction.id, b64).catch(err =>
          console.error('[WS Stream] updateState error:', err.message)
        );
      });

      ws.on('close', () => {
        console.log(`[WS Stream] Device ${deviceId} disconnected`);
      });

      ws.on('error', (err) => {
        console.error(`[WS Stream] Error for device ${deviceId}:`, err.message);
      });
    });

    // ── Still capture (/ws/capture) ──────────────────────────────────────────
    wssCapture.on('connection', async (ws: WebSocket, req: IncomingMessage) => {
      const url = new URL(req.url!, 'http://localhost');
      const token = url.searchParams.get('token') ?? '';

      const decoded = jwtService.verifyToken(token, JwtPurpose.device_usage);
      if (!decoded.valid) {
        ws.close(4001, 'Unauthorized');
        return;
      }

      const userId   = decoded.decoded.userid   as number;
      const deviceId = decoded.decoded.clientid  as number;

      const actions      = await userDevicesActionsRepository.getByDeviceId(deviceId);
      const stillAction  = actions.find(a => a.action.implementation_type === 'TakePictureAction');
      if (!stillAction) {
        console.log(`[WS Capture] No TakePictureAction found for device ${deviceId}`);
        ws.close(4004, 'No capture action configured');
        return;
      }

      console.log(`[WS Capture] Device ${deviceId} connected (user ${userId}, action ${stillAction.id})`);

      ws.on('message', (data: Buffer) => {
        const b64 = data.toString('base64');
        socketService.publishActionStateUpdate(userId, stillAction.id, b64);
        userDevicesActionsRepository.updateState(stillAction.id, b64).catch(err =>
          console.error('[WS Capture] updateState error:', err.message)
        );
      });

      ws.on('close', () => {
        console.log(`[WS Capture] Device ${deviceId} disconnected`);
      });

      ws.on('error', (err) => {
        console.error(`[WS Capture] Error for device ${deviceId}:`, err.message);
      });
    });

    console.log('📷 WS Stream server attached at /ws/stream');
    console.log('📸 WS Capture server attached at /ws/capture');
  }
}

export default new WsStreamService();
