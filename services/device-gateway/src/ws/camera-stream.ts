import { WebSocketServer, WebSocket } from 'ws';
import type { IncomingMessage, Server } from 'http';
import { createLogger } from '@lattice/logger';
import { jwtService, JwtPurpose } from '../services/jwt.service';
import { cameraService } from '../services/camera.service';

const log = createLogger('device-gateway:ws-camera');

// The ESP32 opens a persistent WebSocket and pushes binary JPEG frames. Each frame is
// rewired through the same path as the HTTP route: republished to q.telemetry.arrived so
// digest-service owns the DB/camera_frame-cache/socket. The device names its own action
// via `?action=<mqtt_action_name>`. /ws/stream and /ws/capture behave identically — the
// path is kept only because current firmware connects to both.
export function initCameraStream(server: Server): void {
  const wss = new WebSocketServer({ noServer: true });

  server.on('upgrade', (req, socket, head) => {
    const { pathname } = new URL(req.url ?? '', 'http://localhost');
    if (pathname === '/ws/stream' || pathname === '/ws/capture') {
      wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
    } else {
      socket.destroy();
    }
  });

  wss.on('connection', handleConnection);
  log.info('WS camera attached at /ws/stream and /ws/capture');
}

function handleConnection(ws: WebSocket, req: IncomingMessage): void {
  const url = new URL(req.url ?? '', 'http://localhost');
  const token  = url.searchParams.get('token')  ?? '';
  const action = url.searchParams.get('action') ?? '';

  const decoded = jwtService.verifyToken(token, JwtPurpose.device_usage);
  if (!decoded.valid) {
    ws.close(4001, 'Unauthorized');
    return;
  }
  if (!action) {
    ws.close(4002, 'action query param required');
    return;
  }

  const userId   = Number(decoded.decoded.userid);
  const deviceId = Number(decoded.decoded.clientid);

  // On-demand captures (CameraAction::triggerCapture) send a small JSON text frame
  // {"commandId":"..."} immediately before the binary JPEG frame it correlates to; periodic
  // pushes send only the binary frame, unchanged. A device only ever has one capture in
  // flight at a time, so "next binary frame after this text frame" is an unambiguous pairing.
  let pendingCommandId: string | undefined;

  ws.on('message', (data: Buffer, isBinary: boolean) => {
    try {
      if (!isBinary) {
        const parsed = JSON.parse(data.toString('utf8')) as { commandId?: string };
        pendingCommandId = parsed.commandId;
        return;
      }
      cameraService.publishFrame(userId, deviceId, action, data, pendingCommandId);
      pendingCommandId = undefined;
    } catch (err) {
      log.error({ err, deviceId }, 'ws frame publish failed');
    }
  });
  ws.on('error', (err) => log.error({ err, deviceId }, 'ws error'));
}
