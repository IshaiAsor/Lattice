ALTER TABLE "device_actions"
  ADD COLUMN "implementation_type" VARCHAR(64),
  ADD COLUMN "valid_parameters"    JSONB,
  ADD COLUMN "pins"                JSONB;

-- Populate existing rows (no default used)
UPDATE "device_actions" SET
  "implementation_type" = 'OutletAction',
  "valid_parameters"    = '{"values":["on","off","0","1"]}'::jsonb,
  "pins"                = '[{"pinNumber":4,"pinMode":"OUTPUT"}]'::jsonb
  WHERE "default_name" = 'outlet1';

UPDATE "device_actions" SET
  "implementation_type" = 'OneDirectionalMotorAction',
  "valid_parameters"    = '{"values":["on","off"],"range":{"min":0,"max":100}}'::jsonb,
  "pins"                = '[{"pinNumber":5,"pinMode":"OUTPUT"},{"pinNumber":18,"pinMode":"OUTPUT"},{"pinNumber":19,"pinMode":"OUTPUT"}]'::jsonb
  WHERE "default_name" = 'fan1';

UPDATE "device_actions" SET
  "implementation_type" = 'TemperatureAction',
  "valid_parameters"    = '{"values":[]}'::jsonb,
  "pins"                = '[{"pinNumber":7,"pinMode":"INPUT"}]'::jsonb
  WHERE "default_name" = 'Tempture Sensor 1';

ALTER TABLE "device_actions"
  ALTER COLUMN "implementation_type" SET NOT NULL;
