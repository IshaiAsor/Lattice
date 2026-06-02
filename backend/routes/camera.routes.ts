import { Router, Request, Response } from 'express';
import express from 'express';
import { jwtService, JwtPurpose } from '../services/jwt.service';
import { userDevicesActionsRepository } from '../dal/user.devices.actions.repository';
import socketService from '../services/socket.service';

const router = Router();

const STREAM_IMPL_TYPES  = ['LiveStreamAction',    'LiveStreamHttpAction'];
const CAPTURE_IMPL_TYPES = ['TakePictureAction',   'TakePictureHttpAction'];

router.post(
  '/frame',
  express.raw({ type: 'image/jpeg', limit: '2mb' }),
  async (req: Request, res: Response) => {
    const authHeader = (req.headers['authorization'] ?? '') as string;
    const token = authHeader.replace(/^Bearer\s+/i, '');

    const decoded = jwtService.verifyToken(token, JwtPurpose.device_usage);
    if (!decoded.valid) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    const userId   = decoded.decoded.userid   as number;
    const deviceId = decoded.decoded.clientid as number;
    const type     = (req.query.type as string) || 'stream';

    const actions   = await userDevicesActionsRepository.getByDeviceId(deviceId);
    const implTypes = type === 'capture' ? CAPTURE_IMPL_TYPES : STREAM_IMPL_TYPES;
    const action    = actions.find(a => implTypes.includes(a.action.implementation_type));

    if (!action) {
      res.status(404).json({ error: `No camera action (${type}) found for device ${deviceId}` });
      return;
    }

    const jpeg = req.body as Buffer;
    const b64  = jpeg.toString('base64');

    socketService.publishActionStateUpdate(userId, action.id, b64);
    userDevicesActionsRepository.updateState(action.id, b64).catch(err =>
      console.error('[Camera Route] updateState error:', err.message)
    );

    res.status(200).end();
  }
);

export default router;
