import mqtt, { MqttClient } from 'mqtt';
import config from '../config/env.config';
import { userDevicesRepository } from '../dal/user.devices.repository';
import * as fs from 'fs';
import * as tls from 'tls';
import path from 'path';
import socketService from './socket.service';
import { userDevicesActionsRepository } from '../dal/user.devices.actions.repository';
import { deviceMgmtService } from './device.mgmt.service';
import { deviceActionsService } from './device.actions.service';
import { googleHomegraphService } from './google-smart-home/google.homegraph.service';

class MqttService {
  client: MqttClient;

  constructor() {
    const options: any = {
      host: config.mqtt.internalHost,
      port: config.mqtt.port,
      protocol: 'mqtts',
      username: config.mqtt.username,
      password: config.mqtt.password,
      rejectUnauthorized: config.mqtt.validateCert,
      servername: config.mqtt.serverName, 
      checkServerIdentity: (host: string, cert: tls.PeerCertificate) => {
        // Force verification against the public domain name to allow internal loopback
        if (config.mqtt.serverName) {
            return tls.checkServerIdentity(config.mqtt.serverName, cert);
        }
        return tls.checkServerIdentity(host, cert);
      },
      keepalive: 60,
      reconnectPeriod: 1000,
    };

    if (config.mqtt.caCertPath) {
      try {
        const caPath = path.resolve(__dirname, config.mqtt.caCertPath);
        if (fs.existsSync(caPath) && fs.lstatSync(caPath).isFile()) {
          console.log(`🔐 Loading custom CA cert from: ${caPath}`);
          options.ca = fs.readFileSync(caPath);
        }
      } catch (err) {
        console.error('⚠️ Failed to load custom CA cert, falling back to system roots:', err);
      }
    } else {
      console.log('🌐 No custom CA path provided, using system root certificates.');
    }

    this.client = mqtt.connect(options);

    this.client.on('connect', () => {
      console.log('✅ Connected to MQTT Broker');
      const topicsToSubscribe = ['users/+/devices/+/status', 'users/+/devices/+/telemetry/#'];

      this.client.subscribe(topicsToSubscribe, (err) => {
        if (!err) {
          console.log(`🎧 Subscribed to topics: ${topicsToSubscribe.join(', ')}`);
        } else {
          console.error('❌ Subscription error:', err);
        }
      });
    });

    this.client.on('error', (err) => {
      console.error('❌ MQTT Error:', err);
    });

    this.client.on('message', async (topic: string, message: Buffer) => {
      const payload = message.toString();

      console.log(`📥 Received MQTT -> ${topic}: ${payload}`);

      const parts = topic.split('/');
      const userId = parseInt(parts[1]);//userid
      const deviceId = parseInt(parts[3]);//clientid
      const channel = parts[4]; // 'status', 'telemetry', or 'command'
      const actionName = parts[5]; //sensor1 / outlet1 etc

      let userDevices = await deviceMgmtService.getUserDevices(userId);
      let device = userDevices.find((d) => d.id === deviceId);
      if (!device) {
        console.log(`Device ${deviceId} not found for user ${userId}`);
        return;
      }

      if (channel === 'status') {
        userDevicesRepository.updateDeviceOnlineStatus(userId, device.id, payload === 'online');
        socketService.publishDeviceStatusUpdate(userId, device.id, payload == "online");
        return;
      }
      let deviceActions = await userDevicesActionsRepository.getByDeviceId(device.id);
      
    let action = deviceActions.find((a) => a.action.mqtt_action_name === actionName && a.action.mqtt_action_type === channel);
    if (!action)
    {
      console.log(`Action ${actionName} not found for device ${deviceId}`);
      return;
    }
      if (channel === 'telemetry') {
          await userDevicesActionsRepository.updateState(action.action_id, payload);
          socketService.publishActionStateUpdate(userId, action.action_id, payload);

          // Report state to Google Homegraph
          const actionView = await deviceActionsService.getActionView(action.action_id);
          if (actionView) {
            // The state in the actionView is the old one, we need to update it with the new payload
            actionView.state = payload;
            await googleHomegraphService.reportState(userId.toString(), actionView);
          }
          
      } 
    });
  }

  publishActionState(userId: number, deviceId: number, actionType: string, actionName: string, state: any) {
    const topic = `users/${userId}/devices/${deviceId}/${actionType}/${actionName}`;
    console.log(`📤 Publishing MQTT -> ${topic}: ${state}`);
    this.client.publish(topic, state);
  }
}

export default new MqttService();
