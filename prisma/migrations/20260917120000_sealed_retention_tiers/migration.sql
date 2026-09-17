-- F18.21 — a sealed template carries a retention shape.
--
-- A sealed board is built for one application, so whoever composes its template already knows which
-- entry is a fast-sampling sensor worth a `5m` tier and which is a switch that only needs raw. Until
-- now every sealed device landed on the platform default and each owner re-derived that per device.
--
-- A sixth tier scope, resolved action → device → blueprint → SEALED → user → platform. Addressed by
-- (sealed_template_id, action_name) where action_name is the entry's mqtt_action_name as a plain
-- string: `updateTemplate` recreates every entry on each save, so an FK to the entry row would
-- cascade these away on every Save.
--
-- EXPAND ONLY. No rows are seeded, so every device resolves exactly as it did before.

-- CreateTable
CREATE TABLE "sealed_retention_tiers" (
    "id" SERIAL NOT NULL,
    "sealed_template_id" INTEGER NOT NULL,
    "action_name" VARCHAR(64) NOT NULL,
    "data_kind" VARCHAR(20) NOT NULL,
    "bucket" VARCHAR(12) NOT NULL,
    "keep_days" INTEGER NOT NULL DEFAULT 0,
    "position" INTEGER NOT NULL DEFAULT 0,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "sealed_retention_tiers_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "sealed_retention_tiers_sealed_template_id_action_name_idx" ON "sealed_retention_tiers"("sealed_template_id", "action_name");

-- CreateIndex
CREATE UNIQUE INDEX "sealed_retention_tiers_sealed_template_id_action_name_data__key" ON "sealed_retention_tiers"("sealed_template_id", "action_name", "data_kind", "bucket");

-- AddForeignKey
ALTER TABLE "sealed_retention_tiers" ADD CONSTRAINT "sealed_retention_tiers_sealed_template_id_fkey" FOREIGN KEY ("sealed_template_id") REFERENCES "sealed_templates"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sealed_retention_tiers" ADD CONSTRAINT "sealed_retention_tiers_bucket_fkey" FOREIGN KEY ("bucket") REFERENCES "retention_buckets"("code") ON DELETE RESTRICT ON UPDATE CASCADE;
