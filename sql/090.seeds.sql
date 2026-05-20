

/*INSERT INTO device_action_types (description, google_type_id) 
VALUES 
('Outlet', (select id from google_action_types where value = 'action.devices.types.OUTLET'));
*/


insert into devices (type,version,default_name,created_at,updated_at)
values ('ESP32_SmartOutlet','V1.0.0','ESP32_SmartOutlet',CURRENT_TIMESTAMP,CURRENT_TIMESTAMP);

insert into device_actions (device_id,default_name,google_type_id,mqtt_action_type,mqtt_action_name)
values (
    (select id from devices where default_name = 'ESP32_SmartOutlet'),
    'outlet1',
    (select id from google_action_types where value = 'action.devices.types.OUTLET'),
    'command',
    'outlet1'
);
insert into device_actions (device_id,default_name,google_type_id,mqtt_action_type,mqtt_action_name)
values (
    (select id from devices where default_name = 'ESP32_SmartOutlet'),
    'Tempture Sensor 1',
    (select id from google_action_types where value = 'action.devices.types.SENSOR'),
    'telemetry',
    'sensor1'
);

insert into action_type_traits (device_action_type_id,google_trait_id) 
values (
    (select id from device_actions where default_name = 'outlet1'),
    (select id from google_device_traits where value = 'action.devices.traits.OnOff')
);