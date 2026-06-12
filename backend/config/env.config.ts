// api service environment config — device-gateway owns MQTT/provisioning env vars

export const config = {
  port:    +(process.env.PORT ?? 3000),
  baseUrl:   process.env.BASE_URL ?? 'http://localhost:3000',
  jwtSecret: process.env.JWT_SECRET ?? '',

  jwt: {
    appUsageExpiresIn:        +(process.env.JWT_APP_USAGE_EXPIRES_IN        ?? 0),
    appUsageRefreshExpiresIn: +(process.env.JWT_APP_USAGE_REFRESH_EXPIRES_IN ?? 0),
    googleShortLivedExpiresIn:               +(process.env.JWT_GOOGLE_SHORT_LIVED_EXPIRES_IN               ?? 0),
    googleCloudToCloudLoginExpiresIn:         +(process.env.JWT_GOOGLE_CLOUD_TO_CLOUD_LOGIN_EXPIRES_IN      ?? 0),
    googleCloudToCloudLoginRefreshExpiresIn:  +(process.env.JWT_GOOGLE_CLOUD_TO_CLOUD_LOGIN_REFRESH         ?? 0),
    // device tokens — also needed here for the device command auth flows
    deviceProvisioningExpiresIn: +(process.env.DEVICE_PROVISION_EXPIRES_IN      ?? 0),
    deviceExpiresIn:             +(process.env.JWT_DEVICE_USAGE_EXPIRES_IN       ?? 0),
    deviceTempExpiresIn:         +(process.env.JWT_DEVICE_TEMP_USAGE_EXPIRES_IN  ?? 300),
    deviceRefreshExpiresIn:      +(process.env.JWT_DEVICE_USAGE_REFRESH_EXPIRES_IN ?? 0),
  },

  google: {
    authClientId:        process.env.GOOGLE_AUTH_CLIENT_ID ?? '',
    authClientSecret:    process.env.GOOGLE_AUTH_CLIENT_SECRET,
    signInClientId:      process.env.GOOGLE_SIGN_IN_CLIENT_ID,
    signInClientSecret:  process.env.GOOGLE_SIGN_IN_CLIENT_SECRET,
  },

  valkey: {
    url:      process.env.VALKEY_URL ?? 'redis://localhost:6379',
    username: process.env.VALKEY_USER,
    password: process.env.VALKEY_PASSWORD,
  },

  rateLimit: {
    windowMs: +(process.env.RATE_LIMIT_WINDOW_MS    ?? 15 * 60 * 1000),
    limit:    +(process.env.RATE_LIMIT_MAX_REQUESTS  ?? 150),
  },

  mqtt: {
    server:       process.env.MQTT_SERVER_NAME   ?? 'localhost',
    port:         +(process.env.MQTT_PORT         ?? 8883),
    validateCert: process.env.MQTT_VALIDATE_CERT === 'true',
  },

  gatewayUrl: process.env.GATEWAY_BASE_URL ?? 'http://localhost:3004',
};

export default config;
