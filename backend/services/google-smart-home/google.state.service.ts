import { DeviceActionView } from '../device.actions.service';

class GoogleStateService {
  public buildState(action: DeviceActionView): any {
    const state: any = { online: action.online ?? false };

    const hasTrait = (value: string) =>
      action.googleTraits.some((t) => t.value === value);

    if (hasTrait('action.devices.traits.OnOff')) {
      state.on = action.state === 'on' || action.state === '1';
    }

    if (hasTrait('action.devices.traits.Brightness')) {
      const brightness = parseInt(action.state, 10);
      if (!isNaN(brightness)) state.brightness = brightness;
    }

    if (hasTrait('action.devices.traits.FanSpeed')) {
      const fanSpeed = parseInt(action.state, 10);
      if (!isNaN(fanSpeed)) state.currentFanSpeedPercent = fanSpeed;
    }

    if (
      action.googleType?.value === 'action.devices.types.SENSOR' &&
      hasTrait('action.devices.traits.TemperatureSetting')
    ) {
      const temp = parseFloat(action.state);
      if (!isNaN(temp)) state.thermostatTemperatureAmbient = temp;
    }

    if (hasTrait('action.devices.traits.OpenClose')) {
      const pct = parseInt(action.state, 10);
      state.openPercent = isNaN(pct)
        ? (action.state === 'on' ? 100 : 0)
        : pct;
    }

    if (hasTrait('action.devices.traits.LockUnlock')) {
      state.isLocked = action.state === 'lock';
      state.isJammed = false;
    }

    if (hasTrait('action.devices.traits.HumiditySetting')) {
      const humidity = parseFloat(action.state);
      if (!isNaN(humidity)) state.humidityAmbientPercent = humidity;
    }

    if (hasTrait('action.devices.traits.ArmDisarm')) {
      state.isArmed = action.state === 'arm';
      state.currentArmLevel = action.state === 'arm' ? 'armed' : 'disarmed';
    }

    if (hasTrait('action.devices.traits.WaterLevel')) {
      const pct = parseFloat(action.state);
      if (!isNaN(pct)) state.waterLevelPercent = pct;
    }

    if (hasTrait('action.devices.traits.PhLevel')) {
      const ph = parseFloat(action.state);
      if (!isNaN(ph)) state.phValue = ph;
    }

    if (hasTrait('action.devices.traits.TdsLevel')) {
      const tds = parseFloat(action.state);
      if (!isNaN(tds)) state.tdsPpm = tds;
    }

    if (hasTrait('action.devices.traits.CO2Level')) {
      const co2 = parseFloat(action.state);
      if (!isNaN(co2)) state.co2Ppm = co2;
    }

    if (hasTrait('action.devices.traits.StartStop')) {
      state.isRunning = action.state === 'on';
      state.isPaused = false;
    }

    if (hasTrait('action.devices.traits.ColorSetting')) {
      const COLOR_MAP: Record<string, number> = {
        red: 0xFF0000, green: 0x00FF00, blue: 0x0000FF,
        orange: 0xFF6A00, off: 0x000000,
      };
      const rgb = COLOR_MAP[action.state as string];
      if (rgb !== undefined) state.color = { spectrumRGB: rgb };
    }

    return state;
  }
}

export const googleStateService = new GoogleStateService();
