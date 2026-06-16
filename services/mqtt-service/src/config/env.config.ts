export const env = {
  port:         parseInt(process.env['PORT'] ?? '3005', 10),
  logLevel:     process.env['LOG_LEVEL'] ?? 'info',
  otelEndpoint: process.env['OTEL_EXPORTER_OTLP_ENDPOINT'],
  rabbitmqUrl:  process.env['RABBITMQ_URL'] ?? 'amqp://localhost',

  mqtt: {
    host:           process.env['MQTT_INTERNAL_HOST'] ?? 'localhost',
    port:           parseInt(process.env['MQTT_PORT'] ?? '1883', 10),
    username:       process.env['MQTT_APP_USERNAME'] ?? '',
    password:       process.env['MQTT_APP_PASSWORD'] ?? '',
    caCertPath:     process.env['MQTT_CA_CERT_PATH'],
    validateCert:   process.env['MQTT_VALIDATE_CERT'] === 'true',
    serverName:     process.env['MQTT_SERVER_NAME'],
    defaultVersion: process.env['MQTT_DEFAULT_VERSION'] ?? 'v1',
  },
};
