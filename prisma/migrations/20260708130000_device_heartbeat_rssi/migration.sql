-- Device heartbeat diagnostics surfaced on the devices page: latest WiFi RSSI (dBm) and the
-- time it arrived, updated by the digest heartbeat consumer. Live-only (UI nulls when offline).

-- AlterTable
ALTER TABLE "user_devices" ADD COLUMN     "last_heartbeat_at" TIMESTAMP(6),
ADD COLUMN     "rssi" INTEGER;
