export interface MqttConfig {
  serverName?: string;
  username?: string;
  password?: string;
  port?: number;
  caCertPath: string;
  validateCert?: boolean;
}

export interface GoogleAuthConfig {
  clientId: string;
  clientSecret?: string;
}
export interface GoogleSignInConfig {
  signInClientId?: string;
  signInClientSecret?: string;
}
export interface DbConfig {
  host?: string;
  user?: string;
  password?: string;
  database?: string;
  port?: number;
}

export interface RateLimitConfig {
  windowMs: number;
  limit: number;
}

export interface EnvConfig {
  port: number;
  baseUrl: string;
  mqtt: MqttConfig;
  googleAuth: GoogleAuthConfig;
  googleSignIn: GoogleSignInConfig;
  db: DbConfig;
  redis: RedidConfig;
  Jwt: JwtConfig;
  rateLimit: RateLimitConfig;
}

export interface JwtConfig {
  Secret: string;

  AppUsageExpiresIn: number;
  AppUsageRefreshExpiresIn: number;

  GoogleShortLivedExpiresIn: number;

  GoogleCloudToCloudLoginExpiresIn: number;
  GoogleCloudToCloudLoginRefreshExpiresIn: number;

  deviceProvisioningExpiresIn: number;
  deviceExpiresIn: number;
  deviceRefreshExpiresIn: number;
}

export class RedidConfig {
  url?: string;
  user?: string;
  password?: string;
}

const config: EnvConfig = {
  baseUrl: process.env.BASE_URL || 'http://localhost:3000',
  port: +(process.env.PORT || 3000),
  mqtt: {
    serverName: process.env.MQTT_SERVER_NAME,
    username: process.env.MQTT_APP_USERNAME,
    password: process.env.MQTT_APP_PASSWORD,
    port: process.env.MQTT_PORT ? parseInt(process.env.MQTT_PORT) : undefined,
    caCertPath: process.env.MQTT_CA_CERT_PATH || '',
    validateCert: process.env.MQTT_VALIDATE_CERT === 'true',
  },
  googleAuth: {
    clientId: process.env.GOOGLE_AUTH_CLIENT_ID || '',
    clientSecret: process.env.GOOGLE_AUTH_CLIENT_SECRET,
  },
  googleSignIn: {
    signInClientId: process.env.GOOGLE_SIGN_IN_CLIENT_ID,
    signInClientSecret: process.env.GOOGLE_SIGN_IN_CLIENT_SECRET,
  },
  db: {
    host: process.env.DB_HOST,
    user: process.env.BACKEND_DB_USER,
    password: process.env.BACKEND_DB_PASSWORD,
    database: process.env.DB_NAME,
    port: +(process.env.DB_PORT || 5432),
  },
  Jwt: {
    Secret: process.env.JWT_SECRET || '',
    deviceProvisioningExpiresIn: process.env.DEVICE_PROVISION_EXPIRES_IN
      ? parseInt(process.env.DEVICE_PROVISION_EXPIRES_IN)
      : 0,

    AppUsageExpiresIn: process.env.JWT_APP_USAGE_EXPIRES_IN
      ? parseInt(process.env.JWT_APP_USAGE_EXPIRES_IN)
      : 0,
    AppUsageRefreshExpiresIn: process.env.JWT_APP_USAGE_REFRESH_EXPIRES_IN
      ? parseInt(process.env.JWT_APP_USAGE_REFRESH_EXPIRES_IN)
      : 0,

    deviceExpiresIn: process.env.JWT_DEVICE_USAGE_EXPIRES_IN
      ? parseInt(process.env.JWT_DEVICE_USAGE_EXPIRES_IN)
      : 0,
    deviceRefreshExpiresIn: process.env.JWT_DEVICE_USAGE_REFRESH_EXPIRES_IN
      ? parseInt(process.env.JWT_DEVICE_USAGE_REFRESH_EXPIRES_IN)
      : 0,

    GoogleShortLivedExpiresIn: process.env.JWT_GOOGLE_SHORT_LIVED_EXPIRES_IN
      ? parseInt(process.env.JWT_GOOGLE_SHORT_LIVED_EXPIRES_IN)
      : 0,

    GoogleCloudToCloudLoginExpiresIn: process.env.JWT_GOOGLE_CLOUD_TO_CLOUD_LOGIN_EXPIRES_IN
      ? parseInt(process.env.JWT_GOOGLE_CLOUD_TO_CLOUD_LOGIN_EXPIRES_IN)
      : 0,
    GoogleCloudToCloudLoginRefreshExpiresIn: process.env.JWT_GOOGLE_CLOUD_TO_CLOUD_LOGIN_REFRESH
      ? parseInt(process.env.JWT_GOOGLE_CLOUD_TO_CLOUD_LOGIN_REFRESH)
      : 0,
  },
  redis:{
    url: process.env.REDIS_URL,
    user: process.env.REDIS_USER,
    password: process.env.REDIS_PASSWORD,
  },
  rateLimit: {
    windowMs: process.env.RATE_LIMIT_WINDOW_MS
      ? parseInt(process.env.RATE_LIMIT_WINDOW_MS)
      : 15 * 60 * 1000, // Default to 15 minutes
    limit: process.env.RATE_LIMIT_MAX_REQUESTS
      ? parseInt(process.env.RATE_LIMIT_MAX_REQUESTS)
      : 150, // Default to 150 requests per windowMs
  },
};

export default config;
