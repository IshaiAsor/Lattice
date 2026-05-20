import { createClient, RedisClientType } from 'redis';
import config from '../config/env.config';

class RedisService {
  // 1. Hold the single instance of the class
  private static instance: RedisService;
  
  // 2. Keep the actual Redis client private so other files can't mess with it
  private client: RedisClientType;

  // 3. Private constructor prevents 'new RedisService()' from being called outside
  private constructor() {
    
    this.client = createClient({ url: config.redis.url });

    this.client.on('error', (err) => console.error('❌ Redis Error:', err.message));
    this.client.on('connect', () => console.log('🔒 Redis Connected!'));
  }

  // 4. The only way to get the service instance
  public static getInstance(): RedisService {
    if (!RedisService.instance) {
      RedisService.instance = new RedisService();
    }
    return RedisService.instance;
  }

  // --- PUBLIC API METHODS ---

  public async connect(): Promise<void> {
    if (!this.client.isOpen) {
      await this.client.connect();
    }
  }

  public async setTempData(key: string, value: any, ttlInSeconds: number): Promise<void> {
    const stringValue = typeof value === 'string' ? value : JSON.stringify(value);
    await this.client.set(key, stringValue, { EX: ttlInSeconds });
  }

  public async getTempData<T>(key: string): Promise<T | null> {
    const data = await this.client.get(key);
    if (!data) return null;

    try {
      return JSON.parse(data) as T;
    } catch {
      return data as unknown as T;
    }
  }

  public async deleteTempData(key: string): Promise<void> {
    await this.client.del(key);
  }

  // Optional: A safe way to gracefully shut down the connection
  public async disconnect(): Promise<void> {
    if (this.client.isOpen) {
      await this.client.quit();
    }
  }
}

export const redisService = RedisService.getInstance();
