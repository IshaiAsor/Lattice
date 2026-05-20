import { DeviceActionView } from "../services/device.actions.service";

class GoogleStateService {
    public buildState(action: DeviceActionView): any {
        const state: any = { online: action.online ?? false };

        if (action.googleTraits.some(t => t.value === 'action.devices.traits.OnOff')) {
            state.on = action.state === 'on';
        }
        
        if (action.googleType?.value === 'action.devices.types.SENSOR' && action.googleTraits.some(t => t.value === 'action.devices.traits.TemperatureSetting')) {
            const temp = parseFloat(action.state);
            if (!isNaN(temp)) {
                state.thermostatTemperatureAmbient = temp;
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