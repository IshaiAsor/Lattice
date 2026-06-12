import { PrismaClient } from './generated';
import pg from 'pg';
import { PrismaPg } from '@prisma/adapter-pg';

let _db: PrismaClient | undefined;

export function getDb(): PrismaClient {
  if (!_db) {
    const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
    const adapter = new PrismaPg(pool);
    _db = new PrismaClient({ adapter } as any);
  }
  return _db;
}

// Default singleton export — import { db } from '@lattice/prisma-client'
export const db = new Proxy({} as PrismaClient, {
  get(_target, prop) {
    return (getDb() as any)[prop];
  },
});

// Re-export all generated types so services only need one import
export * from './generated';
export { PrismaClient } from './generated';
