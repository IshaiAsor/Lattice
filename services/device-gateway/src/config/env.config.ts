export const env = {
  port:         parseInt(process.env['PORT'] ?? '3004', 10),
  jwtSecret:    process.env['JWT_SECRET'] ?? 'dev-secret',
  logLevel:     process.env['LOG_LEVEL'] ?? 'info',
  otelEndpoint: process.env['OTEL_EXPORTER_OTLP_ENDPOINT'],
  rabbitmqUrl:  process.env['RABBITMQ_URL'] ?? 'amqp://localhost',

  // Public base URL of device-gateway — embedded in provisioning responses so devices
  // call back to the gateway (config, refresh, camera) rather than the monolith.
  DeviceGatewaybaseUrl: process.env['DEVICE_GATEWAY_URL'] ?? 'http://localhost:3004',
  otaManagerUrl:        process.env['OTA_MANAGER_URL'] ?? 'http://localhost:3001',

  // Comma-separated origins allowed to make cross-origin requests from the browser UI.
  allowedOrigins: (process.env['ALLOWED_ORIGINS'] ?? 'http://localhost:4200').split(',').map(s => s.trim()),

  mqtt: {
    serverName:   process.env['MQTT_SERVER_NAME'] ?? 'localhost',
    port:         parseInt(process.env['MQTT_PORT'] ?? '8883', 10),
    validateCert: (process.env['MQTT_VALIDATE_CERT'] ?? 'true') === 'true',
  },

  jwt: {
    deviceProvisioningExpiresIn: parseInt(process.env['DEVICE_PROVISION_EXPIRES_IN']      ?? '3600'),
    deviceExpiresIn:             parseInt(process.env['JWT_DEVICE_USAGE_EXPIRES_IN']      ?? '31536000'),
    deviceTempExpiresIn:         parseInt(process.env['JWT_DEVICE_TEMP_USAGE_EXPIRES_IN'] ?? '300'),
    deviceRefreshExpiresIn:      parseInt(process.env['JWT_DEVICE_USAGE_REFRESH_EXPIRES_IN'] ?? '315360000'),
  },
};
