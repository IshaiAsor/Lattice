export type ControlType =
  | 'onoff'    // toggle switch
  | 'dimmer'   // arc dial / slider (0-100%)
  | 'temp'     // °C read-only
  | 'humidity' // % read-only
  | 'level'    // % read-only (water/liquid level)
  | 'ph'       // pH read-only
  | 'tds'      // ppm read-only
  | 'co2'      // ppm read-only
  | 'camera'   // camera frame display
  | 'value';   // generic read-only

/** Derive the dashboard control type from the action capability string. */
export function controlTypeFor(capability: string | undefined): ControlType {
  if (!capability) return 'value';
  const c = capability.toLowerCase();
  if (c.includes('camera') || c.includes('doorbell'))        return 'camera';
  if (c.includes('dimmer') || c.includes('brightness'))      return 'dimmer';
  if (c.includes('speed') || c.includes('fan'))              return 'dimmer';
  if (c.includes('temperature'))                             return 'temp';
  if (c.includes('humidity'))                                return 'humidity';
  if (c.includes('liquidlevel') || c.includes('waterlevel')) return 'level';
  if (c.includes('phlevel') || c.includes('ph'))             return 'ph';
  if (c.includes('tdslevel') || c.includes('tds'))           return 'tds';
  if (c.includes('co2') || c.includes('carbon'))             return 'co2';
  // All pump/outlet/mist/light-toggle/motor types
  if (c.includes('pump') || c.includes('outlet') || c.includes('mist')
    || c.includes('onoff') || c.includes('motor') || c.includes('switch')
    || c.includes('light') || c.includes('relay'))           return 'onoff';
  return 'value';
}

/** Material icon name for a capability string. */
export function iconForCapability(capability: string | undefined): string {
  const t = controlTypeFor(capability);
  switch (t) {
    case 'camera':   return 'photo_camera';
    case 'temp':     return 'thermometer';
    case 'humidity': return 'humidity_high';
    case 'level':    return 'water';
    case 'ph':       return 'science';
    case 'tds':      return 'water_drop';
    case 'co2':      return 'air';
    case 'dimmer':   return 'light_mode';
    case 'onoff':    return 'power_settings_new';
    default:         return 'device_unknown';
  }
}

/** Sensor-type units for display */
export function unitFor(capability: string | undefined): string {
  const c = (capability ?? '').toLowerCase();
  if (c.includes('temperature'))  return '°C';
  if (c.includes('humidity'))     return '%';
  if (c.includes('level'))        return '%';
  if (c.includes('ph'))           return 'pH';
  if (c.includes('tds'))          return 'ppm';
  if (c.includes('co2'))          return 'ppm';
  return '';
}

export const COLOR_OPTIONS = ['red', 'green', 'blue', 'orange', 'off'] as const;
