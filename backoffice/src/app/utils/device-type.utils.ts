import { DeviceActionView } from '../services/device.mgmt.service';

export function iconForDeviceType(typeValue: string | null | undefined): string {
  switch (typeValue) {
    case 'action.devices.types.OUTLET':
    case 'action.devices.types.SWITCH':      return 'outlet';
    case 'action.devices.types.LIGHT':        return 'light_mode';
    case 'action.devices.types.FAN':          return 'toys_fan';
    case 'action.devices.types.SENSOR':       return 'thermometer';
    case 'action.devices.types.THERMOSTAT':   return 'thermostat';
    case 'action.devices.types.CAMERA':
    case 'action.devices.types.DOORBELL':     return 'photo_camera';
    case 'action.devices.types.LOCK':         return 'lock';
    case 'action.devices.types.DOOR':
    case 'action.devices.types.GATE':
    case 'action.devices.types.GARAGE':       return 'door_open';
    case 'action.devices.types.BLINDS':
    case 'action.devices.types.WINDOW':
    case 'action.devices.types.CURTAIN':
    case 'action.devices.types.SHUTTER':
    case 'action.devices.types.AWNING':
    case 'action.devices.types.PERGOLA':      return 'blinds';
    case 'action.devices.types.HEATER':
    case 'action.devices.types.RADIATOR':
    case 'action.devices.types.BOILER':       return 'mode_heat';
    case 'action.devices.types.SPRINKLER':
    case 'action.devices.types.VALVE':
    case 'action.devices.types.FAUCET':
    case 'action.devices.types.PUMP':
    case 'action.devices.types.WATERHEATER': return 'water';
    case 'action.devices.types.HUMIDIFIER':
    case 'action.devices.types.DEHUMIDIFIER': return 'humidity_high';
    case 'action.devices.types.AC_UNIT':
    case 'action.devices.types.AIRCOOLER':
    case 'action.devices.types.AIRPURIFIER':
    case 'action.devices.types.AIRFRESHENER': return 'ac_unit';
    case 'action.devices.types.SMOKE_DETECTOR':
    case 'action.devices.types.CARBON_MONOXIDE_DETECTOR': return 'detector_alarm';
    case 'action.devices.types.TV':
    case 'action.devices.types.SPEAKER':
    case 'action.devices.types.SOUNDBAR':
    case 'action.devices.types.STREAMING_BOX':
    case 'action.devices.types.STREAMING_SOUNDBAR':
    case 'action.devices.types.STREAMING_STICK': return 'tv';
    case 'action.devices.types.WASHER':
    case 'action.devices.types.DRYER':        return 'local_laundry_service';
    case 'action.devices.types.REFRIGERATOR':
    case 'action.devices.types.FREEZER':      return 'kitchen';
    case 'action.devices.types.VACUUM':
    case 'action.devices.types.MOP':          return 'cleaning_services';
    case 'action.devices.types.OVEN':
    case 'action.devices.types.MICROWAVE':
    case 'action.devices.types.COFFEE_MAKER':
    case 'action.devices.types.COOKTOP':
    case 'action.devices.types.MULTICOOKER':  return 'oven_gen';
    case 'action.devices.types.SECURITYSYSTEM': return 'security';
    case 'action.devices.types.SCENE':        return 'auto_awesome';
    default:                                  return 'device_unknown';
  }
}

export function hasTrait(action: DeviceActionView, traitValue: string): boolean {
  return action.googleTraits.some(t => t.value === traitValue);
}

export function isCameraAction(action: DeviceActionView): boolean {
  return action.googleType?.value === 'action.devices.types.CAMERA'
    || action.googleType?.value === 'action.devices.types.DOORBELL';
}

// Returns the trait value string for the currently active (displayed) control.
// Resolution order: user's saved defaultTraitId → first trait in list → null.
export function activeTraitValue(action: DeviceActionView): string | null {
  const active = action.googleTraits.find(t => t.id === action.defaultTraitId)
    ?? action.googleTraits[0];
  return active?.value ?? null;
}

// Sensor-only trait values that are read-only display widgets (not interactive controls).
// These are excluded from the switcher chip row and never conflict with control traits.
export const SENSOR_TRAIT_VALUES = new Set([
  'action.devices.traits.TemperatureSetting',
  'action.devices.traits.HumiditySetting',
  'action.devices.traits.WaterLevel',
  'action.devices.traits.PhLevel',
  'action.devices.traits.TdsLevel',
  'action.devices.traits.CO2Level',
]);

// Returns only the controllable (interactive) traits — used to decide whether to show
// the switcher chip row and which chips to render.
export function controllableTraits(action: DeviceActionView) {
  return action.googleTraits.filter(t => !SENSOR_TRAIT_VALUES.has(t.value));
}

// True for read-only sensor telemetry actions (temperature, humidity, etc.) — used to gate
// UI elements that only make sense for telemetry, not command/control actions.
export function isTelemetryAction(action: DeviceActionView): boolean {
  return action.googleTraits.some(t => SENSOR_TRAIT_VALUES.has(t.value));
}

// Maps a Google trait value to a mat-icon name for use in the trait-switcher chips.
export function traitIconName(traitValue: string): string {
  switch (traitValue) {
    case 'action.devices.traits.OnOff':               return 'power_settings_new';
    case 'action.devices.traits.Brightness':          return 'light_mode';
    case 'action.devices.traits.FanSpeed':            return 'toys_fan';
    case 'action.devices.traits.ColorSetting':        return 'palette';
    case 'action.devices.traits.LockUnlock':          return 'lock';
    case 'action.devices.traits.OpenClose':           return 'expand_more';
    case 'action.devices.traits.StartStop':           return 'play_arrow';
    case 'action.devices.traits.ArmDisarm':           return 'shield';
    case 'action.devices.traits.TemperatureSetting':  return 'thermometer';
    case 'action.devices.traits.HumiditySetting':     return 'humidity_high';
    case 'action.devices.traits.WaterLevel':          return 'water';
    case 'action.devices.traits.PhLevel':             return 'science';
    case 'action.devices.traits.TdsLevel':            return 'grain';
    case 'action.devices.traits.CO2Level':            return 'co2';
    default:                                          return 'settings';
  }
}

export const COLOR_OPTIONS = ['red', 'green', 'blue', 'orange', 'off'] as const;

export function iconForAction(action: DeviceActionView): string {
  if (action.googleType?.value) return iconForDeviceType(action.googleType.value);
  switch (action.implementation_type) {
    case 'OutletAction':              return 'outlet';
    case 'LightDimmerAction':         return 'light_mode';
    case 'OneDirectionalMotorAction': return 'toys_fan';
    case 'TemperatureAction':
    case 'AirTemperatureAction':      return 'thermometer';
    case 'HumidityAction':            return 'humidity_high';
    case 'WaterLevelAction':          return 'water';
    case 'PhLevelAction':             return 'science';
    case 'TdsLevelAction':            return 'water_drop';
    case 'CO2LevelAction':            return 'air';
    case 'CameraAction':              return 'photo_camera';
    default:                          return 'device_unknown';
  }
}

// Returns implementation_type only when the action has no Google traits assigned.
// Use as a rendering fallback for capability-activated actions with no Google traits.
export function implTypeOf(action: DeviceActionView): string | null {
  return action.googleTraits.length === 0 ? (action.implementation_type ?? null) : null;
}
