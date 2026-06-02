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

export const COLOR_OPTIONS = ['red', 'green', 'blue', 'orange', 'off'] as const;
