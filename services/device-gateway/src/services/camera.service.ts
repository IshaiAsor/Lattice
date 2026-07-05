import { publish, RK } from '@lattice/queue';
import { getChannel } from '../queue';

class CameraService {
  // Pure pass-through. The device sends its own mqtt_action_name (in the query), so the
  // gateway just republishes the frame as image telemetry — no DB lookup, no knowledge of
  // implementation_type. digest-service resolves (deviceId, actionName) and owns the
  // DB/camera_frame-cache/socket; an unknown action is DLQ'd there.
  publishFrame(
    userId: number,
    deviceId: number,
    actionName: string,
    jpeg: Buffer,
    commandId?: string,
  ): void {
    publish(getChannel(), RK.TELEMETRY_ARRIVED, {
      userId: String(userId),
      deviceId: String(deviceId),
      actionName,
      value: jpeg.toString('base64'),
      timestamp: new Date().toISOString(),
      ...(commandId ? { commandId } : {}),
    });
  }
}

export const cameraService = new CameraService();
