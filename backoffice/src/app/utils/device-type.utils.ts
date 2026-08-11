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

// Which input widget an editor should render to set a target value for an action.
// Shared by the rule editor ("then do") and the scene editor (member target state).
export type ActionControlType = 'onoff' | 'dial' | 'sensor' | 'text';

export const TRAIT_ONOFF = 'action.devices.traits.OnOff';
export const TRAIT_BRIGHTNESS = 'action.devices.traits.Brightness';
export const TRAIT_FANSPEED = 'action.devices.traits.FanSpeed';
export const TYPE_SENSOR = 'action.devices.types.SENSOR';

export function actionControlType(action: DeviceActionView | undefined | null): ActionControlType {
  if (!action) return 'text';
  const traits = action.googleTraits.map(t => t.value);
  if (action.googleType?.value === TYPE_SENSOR) return 'sensor';
  if (traits.some(t => t === TRAIT_BRIGHTNESS || t === TRAIT_FANSPEED)) return 'dial';
  if (traits.some(t => t === TRAIT_ONOFF)) return 'onoff';
  return 'text';
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

// ── Compact summaries ───────────────────────────────────────────────────────
// The action card renders a reading as a big number with its unit; a summary strip has room for
// neither the widget nor the trait switcher, so these give the same value in one line. Kept here
// beside SENSOR_TRAIT_VALUES so a new sensor trait is declared once, not in two places that drift.

const SENSOR_TRAIT_UNITS: Record<string, { unit: string; digits: string }> = {
  'action.devices.traits.TemperatureSetting': { unit: '°C', digits: '1.0-1' },
  'action.devices.traits.HumiditySetting':    { unit: '%',  digits: '1.0-0' },
  'action.devices.traits.WaterLevel':         { unit: '%',  digits: '1.0-1' },
  'action.devices.traits.PhLevel':            { unit: 'pH', digits: '1.0-2' },
  'action.devices.traits.TdsLevel':           { unit: 'ppm', digits: '1.0-1' },
  'action.devices.traits.CO2Level':           { unit: 'ppm', digits: '1.0-0' },
};

export interface SensorReading {
  /** Trait-appropriate unit, e.g. '°C'. Empty for a sensor whose value is not a quantity. */
  unit: string;
  /** DecimalPipe format matching what the action card shows, so both surfaces round alike. */
  digits: string;
  /** Null when the device has not reported since load — the strip shows a dash, never a stale 0. */
  value: number | null;
}

/** The first sensor trait's current reading, or null for an action that reads nothing. */
export function sensorReadingOf(action: DeviceActionView): SensorReading | null {
  const trait = action.googleTraits.find(t => SENSOR_TRAIT_VALUES.has(t.value));
  if (!trait) return null;
  const spec = SENSOR_TRAIT_UNITS[trait.value] ?? { unit: '', digits: '1.0-1' };
  const raw = typeof action.state === 'number' ? action.state : Number(action.state);
  return { unit: spec.unit, digits: spec.digits, value: Number.isFinite(raw) ? raw : null };
}

/** True when the action's active control is in its "on" position — drives the chip's lit state. */
export function isActiveState(action: DeviceActionView): boolean {
  switch (activeTraitValue(action)) {
    case TRAIT_ONOFF:                           return action.state === 'on';
    case 'action.devices.traits.LockUnlock':    return action.state === 'lock';
    case 'action.devices.traits.OpenClose':     return action.state === 'on';
    case 'action.devices.traits.StartStop':     return action.state === 'on';
    case 'action.devices.traits.ArmDisarm':     return action.state === 'arm';
    case TRAIT_BRIGHTNESS:
    case TRAIT_FANSPEED:                        return Number(action.state) > 0;
    default:                                    return false;
  }
}

/** One-word state for a control chip: "On", "Locked", "45%". Empty when there is nothing to say. */
export function controlStateLabel(action: DeviceActionView): string {
  const on = isActiveState(action);
  switch (activeTraitValue(action)) {
    case TRAIT_ONOFF:                           return on ? 'On' : 'Off';
    case 'action.devices.traits.LockUnlock':    return on ? 'Locked' : 'Unlocked';
    case 'action.devices.traits.OpenClose':     return on ? 'Open' : 'Closed';
    case 'action.devices.traits.StartStop':     return on ? 'Running' : 'Stopped';
    case 'action.devices.traits.ArmDisarm':     return on ? 'Armed' : 'Disarmed';
    case TRAIT_BRIGHTNESS:
    case TRAIT_FANSPEED:                        return `${Number(action.state) || 0}%`;
    case 'action.devices.traits.ColorSetting':  return typeof action.state === 'string' ? action.state : '';
    default:                                    return '';
  }
}
