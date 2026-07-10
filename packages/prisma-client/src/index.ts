// Shared Prisma client for all Lattice services (F1.8).
//
// The generated client lives in this package's node_modules/.prisma/client (produced
// from the monorepo-root schema by scripts/prepare-prisma.mjs). We import it directly
// from '.prisma/client' — the same internal path @prisma/client re-exports — because
// npm hoists @prisma/client to the monorepo root, away from our generated sibling.
//
// Consumers do: `import { db, type UserDeviceAction } from '@lattice/prisma-client'`.
import { PrismaClient } from '.prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { Pool } from 'pg';

// Re-export every generated type/enum (UserDeviceAction, Prisma namespace, etc.).
export * from '.prisma/client';

// Prisma v7 connects through a driver adapter (no datasource url in the schema).
// The Pool is built from DATABASE_URL; it connects lazily on first query, so
// importing this module does not open a connection.
const pool = new Pool({ connectionString: process.env['DATABASE_URL'] });
// The DB server's default session timezone isn't UTC (local dev sets PGTZ for admin-tool
// convenience — see compose.yaml). Every pooled connection must pin UTC explicitly: without
// this, DateTime writes computed as `new Date(Date.now() + ttl)` get persisted against the
// session's local offset instead of the intended UTC instant, silently corrupting any
// short-TTL timestamp (e.g. password-reset tokens came back pre-expired).
pool.on('connect', async (client) => {
  await client.query("SET TIME ZONE 'UTC'");
});
const adapter = new PrismaPg(pool);

export const db = new PrismaClient({ adapter });
