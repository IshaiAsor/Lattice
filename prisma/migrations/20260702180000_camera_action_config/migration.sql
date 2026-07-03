-- Unified CameraAction: per-instance resolution + delivery transport config
-- (frame rate reuses the existing telemetry_interval_ms column).
ALTER TABLE "user_device_actions"
  ADD COLUMN "camera_resolution" VARCHAR(20),
  ADD COLUMN "camera_transport" VARCHAR(10);
