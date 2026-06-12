import express from 'express';
import { verifyDeviceToken } from '../middlewares/device.auth.middleware';
import { JwtPurpose } from '../services/jwt.service';
import { processCameraFrame } from '../services/ws.stream.service';
import { deviceCache } from '../dal/device.cache';
import { db } from '@lattice/prisma-client';

const router = express.Router();
router.use(verifyDeviceToken(JwtPurpose.device_usage));

// POST /api/camera/frame  — device uploads a base64-encoded camera frame
router.post('/frame', async (req, res) => {
  const { id: userId, deviceId: userDeviceId } = req.device!;
  const { frame, action_key } = req.body as { frame: string; action_key?: string };

  if (!frame) return res.status(400).json({ error: 'frame is required' });

  // Resolve the camera UserAction (to get userActionId for pipeline trigger)
  const cameraAction = action_key
    ? await deviceCache.resolveAction(userDeviceId, action_key)
    : null;

  // Check if a pipeline is configured to trigger on camera frames for this device
  let pipelineId: number | undefined;
  if (cameraAction) {
    const pipeline = await db.pipeline.findFirst({
      where: {
        user_id: userId,
        enabled: true,
        trigger_kind: 'telemetry',
        trigger_capability: 'camera',
      },
      select: { id: true },
    });
    pipelineId = pipeline?.id;
  }

  await processCameraFrame(
    userId,
    userDeviceId,
    cameraAction?.userActionId ?? 0,
    frame,
    pipelineId,
  );

  res.json({ ok: true });
});

export default router;
