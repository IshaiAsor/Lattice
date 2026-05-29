import { DeviceActionView } from '../device.actions.service';


class GoogleStateService {
  public buildState(action: DeviceActionView): any {
    const state: any = { online: action.online ?? false };
//todo: This is a very basic implementation. You should expand this to handle all the traits and types you support, and to reflect the actual state of the device in your system.
    if (action.googleTraits.some((t) => t.value === 'action.devices.traits.OnOff')) {
      state.on = action.state === 'on' || action.state === '1' || action.state === 1; // Adjust this logic based on how you represent on/off states in your system
    }

    if (
      action.googleType?.value === 'action.devices.types.SENSOR' &&
      action.googleTraits.some((t) => t.value === 'action.devices.traits.TemperatureSetting')
    ) {
      const temp = parseFloat(action.state);
      if (!isNaN(temp)) {
        state.thermostatTemperatureAmbient = temp;
      }
    }

    if (
      action.googleType?.value === 'action.devices.types.FAN' &&
      action.googleTraits.some((t) => t.value === 'action.devices.traits.FanSpeed')
    ) {
      const fanSpeed = parseInt(action.state, 10);
      if (!isNaN(fanSpeed)) {
        state.fanSpeed = fanSpeed;
      }
    }

    // Add other trait handlers here as needed. For example, for brightness:
    // if (action.googleTraits.some(t => t.value === 'action.devices.traits.Brightness')) {
    //     const brightness = parseInt(action.state, 10);
    //     if (!isNaN(brightness)) {
    //         state.brightness = brightness;
    //     }
    // }

    return state;
  }
}

export const googleStateService = new GoogleStateService();
