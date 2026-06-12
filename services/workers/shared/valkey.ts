import IORedis from 'ioredis';

export const valkey = new IORedis(process.env.VALKEY_URL ?? 'redis://localhost:6379', {
  username: process.env.VALKEY_USER,
  password: process.env.VALKEY_PASSWORD,
  lazyConnect: true,
});

// Convenience helpers for the key schema shared with device-gateway
export const keys = {
  actionState:  (id: number)         => `action_state:${id}`,
  deviceOnline: (id: number)         => `device_online:${id}`,
  cameraFrame:  (userDeviceId: number) => `camera_frame:${userDeviceId}`,
};
