// Shared Prisma client (F1.8). The adapter/Pool/DATABASE_URL wiring and the generated
// client all live in @lattice/prisma-client now — services just consume the singleton.
export { db, Prisma } from '@lattice/prisma-client';
