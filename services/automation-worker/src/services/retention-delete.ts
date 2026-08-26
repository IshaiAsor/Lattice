import { Prisma } from '@lattice/prisma-client';
import { db } from '../db/client';
import { env } from '../config/env.config';

// ── Bounded deletes ──────────────────────────────────────────────────────────

/**
 * Delete in bounded chunks until nothing is left or the budget is spent.
 *
 * Phase 1 checked its cap BEFORE calling `deleteMany`, so the cap decided whether a delete started,
 * not how big it was: one user with millions of expired rows still deleted them in a single
 * statement holding one long lock — precisely what that function's own comment said it avoided.
 * Prisma's `deleteMany` has no LIMIT, so this drops to raw SQL over an `id IN (SELECT … LIMIT n)`
 * subselect and loops.
 *
 * Returns how many were actually deleted; the budget is the caller's, because the cap is per kind
 * across all users rather than per statement.
 */
export async function deleteBounded(
  table: string,
  where: Prisma.Sql,
  budget: number,
): Promise<number> {
  const chunk = env.retention.deleteChunk;
  let deleted = 0;
  while (deleted < budget) {
    const take = Math.min(chunk, budget - deleted);
    // Interpolating the table name is safe here and nowhere else: every caller passes a literal
    // from this file, never anything derived from a request. The predicate is parameterised.
    const n = await db.$executeRaw`
      DELETE FROM ${Prisma.raw(`"${table}"`)}
      WHERE id IN (
        SELECT id FROM ${Prisma.raw(`"${table}"`)} WHERE ${where} ORDER BY id LIMIT ${take}
      )
    `;
    deleted += n;
    if (n < take) break; // nothing left to find
  }
  return deleted;
}
