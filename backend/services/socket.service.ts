import { Server } from 'socket.io';
import http from 'http';
import socketActionsService from './socket.actions.service';
import { JwtPurpose, jwtService } from './jwt.service';

class SocketService {
  private io?: Server;
  init(server: http.Server) {
    this.io = new Server(server, { cors: { origin: '*' } });

    this.io.use((socket, next) => {
      
      const token = socket.handshake.auth?.token;
      if (!token) {
        return next(new Error('Authentication error: Token missing'));
      }

      let jwtVerificationResult = jwtService.verifyToken(token, JwtPurpose.app_usage);
      if(jwtVerificationResult.valid)
      {
        socket.data.user = jwtVerificationResult.decoded;
        next();
      }
      else{
        next(new Error('Authentication error: Invalid token'));
        
      }
    });

    this.io.on('connection', (socket) => {
      const userId = socket.data.user.id;

      socket.join(`user_${userId}`);
      console.log(`⚡ User ${userId} connected via WebSocket and joined room: user_${userId}`);

      socket.on('disconnect', () => {
        console.log(`User ${userId} disconnected from WebSocket`);
      });

      socket.on('action_state_update',async (data:{ actionId: number; state: any }) => {
       await socketActionsService.handleActionUpdate(userId, data.actionId, data.state);
      });
    });
  }

  publishActionStateUpdate(userId: number, actionId: number, state: any) {
    if (this.io) {
      this.io.to(`user_${userId}`).emit('action_state_update', { actionId, state });
    }
  };

    publishDeviceStatusUpdate(userId: number, deviceId: number, state: any) {
    if (this.io) {
      this.io.to(`user_${userId}`).emit('device_status_change', { deviceId, state });
    }
  };
}

export default new SocketService();
