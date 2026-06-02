-- Add missing Google Smart Home device types
INSERT INTO "google_action_types" ("name", "value") VALUES
  ('Lock',       'action.devices.types.LOCK'),
  ('Door',       'action.devices.types.DOOR'),
  ('Garage',     'action.devices.types.GARAGE'),
  ('Heater',     'action.devices.types.HEATER'),
  ('Sprinkler',  'action.devices.types.SPRINKLER')
ON CONFLICT ("value") DO NOTHING;

-- Add missing Google Smart Home traits
INSERT INTO "google_device_traits" ("name", "value") VALUES
  ('Camera Stream',    'action.devices.traits.CameraStream'),
  ('Lock / Unlock',    'action.devices.traits.LockUnlock'),
  ('Start / Stop',     'action.devices.traits.StartStop'),
  ('Humidity Setting', 'action.devices.traits.HumiditySetting')
ON CONFLICT ("value") DO NOTHING;
