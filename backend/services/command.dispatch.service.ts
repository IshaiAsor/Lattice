import { connect, publish, RK } from '@lattice/queue';
import type { ActionDispatchPayload } from '@lattice/queue';
import config from '../config/env.config';
import { userDevicesRepository } from '../dal/user.devices.repository';

// Replaces the monolith's direct MQTT publishing. The MQTT broker connection is owned by
// services/mqtt-service; the monolith now publishes ActionDispatchPayload to
// q.action.dispatch and mqtt-service forwards it to the device. Lazy single channel —
// connects on first command so startup never blocks on RabbitMQ.
let chPromise: ReturnType<typeof connect> | null = null;

function resetChannel() { chPromise = null; }

async function channel() {
  if (chPromise) {
    // If the connection attempt itself failed, start fresh.
    try { await chPromise; } catch { chPromise = null; }
  }

  if (!chPromise) {
    chPromise = connect(config.rabbitmqUrl).then((ch) => {
      // Reset so the next call reconnects if the channel or its connection is closed.
      ch.on('close', resetChannel);
      ch.on('error', resetChannel);
      (ch as any).connection?.on('close', resetChannel);
      (ch as any).connection?.on('error', resetChannel);
      return ch;
    });
  }
  return chPromise;
}

class CommandDispatchService {
  private async resolveVersion(deviceId: number): Promise<string | undefined> {
    try {
      const userDevice = await userDevicesRepository.getById(deviceId);
      return userDevice.device.version ?? undefined;
    } catch (err) {
      console.error(`[CommandDispatch] Could not resolve version for device ${deviceId}:`, err);
      return undefined;
    }
  }

  // userId/deviceId are the user_device owner id and user_device id (the MQTT topic ids);
  // actionName is the mqtt_action_name; command is the message body sent to the device.
  async publishCommand(userId: number, deviceId: number, actionName: string, command: unknown): Promise<void> {
    const firmwareVersion = await this.resolveVersion(deviceId);
    const payload: ActionDispatchPayload = {
      userId:   String(userId),
      deviceId: String(deviceId),
      actionName,
      command,
      firmwareVersion,
    };
    let ch = await channel();
    try {
      publish(ch, RK.ACTION_DISPATCH, payload);
    } catch (err: any) {
      // Channel closed between the health-check and the publish — reset and retry once.
      if (err?.name === 'IllegalOperationError') {
        resetChannel();
        ch = await channel();
        publish(ch, RK.ACTION_DISPATCH, payload);
      } else {
        throw err;
      }
    }
    console.log(`📤 [CommandDispatch] action.dispatch -> device ${deviceId} (Action: ${actionName})`);
  }
}

export default new CommandDispatchService();
