import mqtt, { MqttClient } from 'mqtt';
import config from '../config/env.config';
import { processTelemetry, processStatus } from './action.hub.service';
import { createLogger } from '@lattice/logger';
import * as tls from 'tls';
import * as fs from 'fs';
import * as path from 'path';

const log = createLogger('device-gateway:mqtt');

// Shared subscription — only one group member receives each message (load-balanced across instances)
const SHARED_SUB = 'users/+/devices/+/#';

// Topic (versioned):   users/{userId}/devices/{macId}/{version}/{channel}/{actionKey?}
// Topic (unversioned): users/{userId}/devices/{macId}/{channel}/{actionKey?}
// The version segment is present when parts[4] matches /^v\d/ (e.g. "v2.0.81").
function parseTopic(topic: string): { userId: number; macId: string; version: string | null; channel: string; actionKey: string } | null {
  const parts = topic.split('/');
  if (parts.length < 5 || parts[0] !== 'users' || parts[2] !== 'devices') return null;
  const userId = parseInt(parts[1], 10);
  if (isNaN(userId)) return null;

  const hasVersion = /^v\d/.test(parts[4]);
  const version   = hasVersion ? parts[4] : null;
  const channel   = hasVersion ? parts[5] : parts[4];
  const actionKey = hasVersion ? parts.slice(6).join('/') : parts.slice(5).join('/');

  if (!channel) return null;
  return { userId, macId: parts[3], version, channel, actionKey };
}

export class MqttService {
  private client?: MqttClient;

  connect(): void {
    const options: any = {
      clientId: config.emqx.clientId,
      host: config.emqx.internalHost,
      port: config.emqx.port,
      protocol: 'mqtts',
      username: config.emqx.username,
      password: config.emqx.password,
      rejectUnauthorized: config.emqx.validateCert,
      servername: config.emqx.serverName, 
      checkServerIdentity: (host: string, cert: tls.PeerCertificate) => {
        // Force verification against the public domain name to allow internal loopback
        if (config.emqx.serverName) {
            return tls.checkServerIdentity(config.emqx.serverName, cert);
        }
        return tls.checkServerIdentity(host, cert);
      },
      keepalive: 60,
      reconnectPeriod: 1000,
    };

    if (config.emqx.caCertPath) {
      try {
        const caPath = path.resolve(__dirname, config.emqx.caCertPath);
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
      log.info('MQTT connected to EMQX');
      this.client!.subscribe(SHARED_SUB, { qos: 1 }, (err) => {
        if (err) log.error(err, 'MQTT subscribe failed');
        else log.info({ topic: SHARED_SUB }, 'MQTT subscribed');
      });
    });

    this.client.on('message', (topic, payload) => {
      const parsed = parseTopic(topic);
      if (!parsed) return;
      const { userId, macId, channel, actionKey } = parsed;
      const value = payload.toString().trim();

      if (channel === 'status') {
        processStatus(macId, userId, value).catch((err) =>
          log.error(err, 'Error processing status message'),
        );
      } else if (channel === 'telemetry' && actionKey) {
        processTelemetry(macId, userId, actionKey, value).catch((err) =>
          log.error(err, 'Error processing telemetry message'),
        );
      }
    });

    this.client.on('error',      (err) => 
      log.error(err, 'MQTT error')
  );
    this.client.on('reconnect',  ()    => log.warn('MQTT reconnecting'));
    this.client.on('disconnect', ()    => log.warn('MQTT disconnected'));
  }

  /** Publish an MQTT command to a device. */
  publish(topic: string, value: string): void {
    if (!this.client?.connected) {
      log.warn({ topic }, 'MQTT not connected — cannot publish command');
      return;
    }
    this.client.publish(topic, value, { qos: 1 });
  }

  /** Build the MQTT command topic for a device.
   *  version: firmware version string stored at provisioning (e.g. "v2.0.81"); omit for unversioned legacy devices.
   */
  static commandTopic(userId: number, macId: string, version: string | null, mqttType: string, mqttName: string): string {
    const versionSegment = version ? `/${version}` : '';
    return `users/${userId}/devices/${macId}${versionSegment}/${mqttType}/${mqttName}`;
  }
}

export const mqttService = new MqttService();
