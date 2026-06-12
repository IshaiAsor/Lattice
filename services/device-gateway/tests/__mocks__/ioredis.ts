// Mock IORedis class — intercepts new IORedis(...) in device.cache.ts.
const mockRedisInstance = {
  get:    jest.fn().mockResolvedValue(null),
  set:    jest.fn().mockResolvedValue('OK'),
  del:    jest.fn().mockResolvedValue(1),
  keys:   jest.fn().mockResolvedValue([]),
  exists: jest.fn().mockResolvedValue(0),
};

const MockIORedis = jest.fn().mockImplementation(() => mockRedisInstance);

export { mockRedisInstance };
export default MockIORedis;
