import { defineConfig, env } from "prisma/config";

export default defineConfig({
  schema: "../prisma/schema.prisma",
  // Required by Prisma 7 for migration/introspection CLI commands.
  // Runtime client uses the pg driver adapter (config/db.ts), not this url.
  datasource: { url: env("DATABASE_URL") },
});
