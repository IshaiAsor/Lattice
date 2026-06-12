export const config = {
  port:    +(process.env.PORT ?? 3004),
  baseUrl:   process.env.GATEWAY_BASE_URL ?? `http://localhost:${process.env.PORT ?? 3004}`,
  jwtSecret: process.env.JWT_SECRET ?? '',

  jwt: {
    deviceProvisioningExpiresIn: +(process.env.DEVICE_PROVISION_EXPIRES_IN      ?? 300),
    deviceExpiresIn:             +(process.env.JWT_DEVICE_USAGE_EXPIRES_IN       ?? 86400),
    deviceTempExpiresIn:         +(process.env.JWT_DEVICE_TEMP_USAGE_EXPIRES_IN  ?? 300),
    deviceRefreshExpiresIn:      +(process.env.JWT_DEVICE_USAGE_REFRESH_EXPIRES_IN ?? 604800),
  },

  mqtt: {
    validateCert: process.env.MQTT_VALIDATE_CERT === 'true',
  },

  emqx: {
    clientId: `device-gateway-${process.pid}`,
    serverName: process.env.MQTT_SERVER_NAME,
    internalHost: process.env.MQTT_INTERNAL_HOST || process.env.MQTT_SERVER_NAME,
    username: process.env.MQTT_APP_USERNAME,
    password: process.env.MQTT_APP_PASSWORD,
    port: process.env.MQTT_PORT ? parseInt(process.env.MQTT_PORT) : undefined,
    caCertPath: process.env.MQTT_CA_CERT_PATH || '',
    validateCert: process.env.MQTT_VALIDATE_CERT === 'true',
  },

  valkey: {
    url:      process.env.VALKEY_URL      ?? 'redis://localhost:6379',
    username: process.env.VALKEY_USER,
    password: process.env.VALKEY_PASSWORD,
  },
};

export default config;
