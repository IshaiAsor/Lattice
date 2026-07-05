// Derives this package's Prisma schema from the monorepo-root schema
// (prisma/schema.prisma). The root schema hard-codes its generator output to the
// backend workspace (the legacy prod path); here we rewrite that line so the client
// is generated into THIS package's node_modules/.prisma/client, where src/index.ts
// resolves it via the sibling-.prisma convention and re-exports it.
//
// The generated prisma/schema.prisma is gitignored — the root schema stays the single
// source of truth (no drift). This package is the shared home for the generated client
// (F1.8); services depend on @lattice/prisma-client instead of generating their own.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const pkgRoot = resolve(here, '..');
const rootSchema = resolve(pkgRoot, '../../prisma/schema.prisma');
const outSchema = resolve(pkgRoot, 'prisma/schema.prisma');

const src = readFileSync(rootSchema, 'utf8');

// Output is relative to the schema's own directory (<pkgRoot>/prisma), so
// ../node_modules/.prisma/client lands in this package's node_modules.
const rewritten = src.replace(/output\s*=\s*".*?"/, 'output   = "../node_modules/.prisma/client"');

if (rewritten === src) {
  throw new Error('prepare-prisma: could not find generator output line to rewrite');
}

// No `url` is injected: Prisma v7 dropped datasource `url` in schema. The client
// connects via the @prisma/adapter-pg driver adapter (see src/index.ts).
mkdirSync(dirname(outSchema), { recursive: true });
writeFileSync(outSchema, rewritten);
console.log(`prepare-prisma: wrote ${outSchema} from ${rootSchema}`);
