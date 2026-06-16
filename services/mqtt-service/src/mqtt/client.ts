import mqtt, { MqttClient } from 'mqtt';
import * as fs from 'fs';
import * as tls from 'tls';
import * as path from 'path';
import { createLogger } from '@lattice/logger';

const log = createLogger('mqtt-service:client');

interface MqttEnv {
  host: string;
  port: number;
  username: string;
  password: string;
  caCertPath?: string;
  validateCert: boolean;
  serverName?: string;
}

export function createMqttClient(cfg: MqttEnv): MqttClient {
  const useTls = Boolean(cfg.caCertPath) || cfg.port === 8883;

  const options = {
    host:              cfg.host,
    port:              cfg.port,
    protocol:          useTls ? 'mqtts' : 'mqtt',
    username:          cfg.username,
    password:          cfg.password,
    rejectUnauthorized: cfg.validateCert,
    servername:        cfg.serverName,
    checkServerIdentity: (host: string, cert: tls.PeerCertificate) => {
      const nameToCheck = cfg.serverName ?? host;
      return tls.checkServerIdentity(nameToCheck, cert);
    },
    keepalive:      60,
    reconnectPeriod: 1000,
  } as mqtt.IClientOptions;

  if (cfg.caCertPath) {
    try {
      const caPath = path.resolve(cfg.caCertPath);
      if (fs.existsSync(caPath) && fs.lstatSync(caPath).isFile()) {
        (options as any).ca = fs.readFileSync(caPath);
        log.info({ caPath }, 'loaded custom CA cert');
      }
    } catch (err) {
      log.warn({ err }, 'failed to load custom CA cert, using system roots');
    }
  }

  return mqtt.connect(options);
}

export function mqttConnected(client: MqttClient): Promise<void> {
  return new Promise((resolve, reject) => {
    client.once('connect', () => resolve());
    client.once('error', (err) => reject(err));
  });
}
