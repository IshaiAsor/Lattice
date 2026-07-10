#pragma once
// Single source of truth for the device capability manifest.
//
// This header is deliberately free of Arduino / sensor-library includes so it can be
// compiled BOTH on the ESP32 (firmware) and on a host (the manifest generator under
// tools/manifest-gen/). It pulls in only the descriptor structs from ActionPinsSetup.h
// and uses OUTPUT/INPUT, which the host build supplies via a tiny Arduino.h shim.
//
// Each action class forwards its blueprint()/supportedTraits()/googleActionType()/
// capability() statics to the matching function here, so runtime callers
// (DynamicDeviceActionsService, DeviceCapabilitiesService) and the host generator all
// read the exact same data — no drift.
#include <vector>
#include "actions/ActionPinsSetup.h"
#include "actions/manifest/GoogleTraits.h"

namespace CapabilityRegistry
{

// ---- Commands ----

inline CapabilityDescriptor outlet()
{
    static const PinSlotDef     pins[]   = {{"relay", "Relay", OUTPUT}, {nullptr}};
    static const GoogleTraitDef traits[] = {GoogleTraits::OnOff(), {nullptr}};
    return {"outlet", "Outlet", "OutletCommandAction", "command", "outlet", "action.devices.types.OUTLET", traits,
            0,        pins};
}

inline CapabilityDescriptor fan()
{
    static const PinSlotDef     pins[]   = {{"in1", "Direction Pin 1 (IN1)", OUTPUT},
                                            {"in2", "Direction Pin 2 (IN2)", OUTPUT},
                                            {"pwm", "Speed Pin (PWM)", OUTPUT},
                                            {nullptr}};
    static const GoogleTraitDef traits[] = {GoogleTraits::OnOff(), GoogleTraits::FanSpeed(), {nullptr}};
    return {"fan", "Fan", "OneDirectionalMotorAction", "command", "fan", "action.devices.types.FAN", traits, 0, pins};
}

inline CapabilityDescriptor dimmer()
{
    static const PinSlotDef     pins[]   = {{"pwm", "PWM", OUTPUT}, {nullptr}};
    static const GoogleTraitDef traits[] = {GoogleTraits::OnOff(), GoogleTraits::Brightness(), {nullptr}};
    return {"dimmer", "Light Dimmer", "LightDimmerAction", "command", "dimmer", "action.devices.types.LIGHT", traits, 0,
            pins};
}

// Generic single-pin PWM output — a raw 0-100% duty-cycle actuator not bound to a specific
// device role. OnOff + Brightness model the on/off + analog-level surface; the neutral SWITCH
// device type keeps it domain-agnostic (unlike dimmer=LIGHT / fan=FAN).
inline CapabilityDescriptor pwm()
{
    static const PinSlotDef     pins[]   = {{"pwm", "PWM", OUTPUT}, {nullptr}};
    static const GoogleTraitDef traits[] = {GoogleTraits::OnOff(), GoogleTraits::Brightness(), {nullptr}};
    return {"pwm", "PWM Output", "PwmOutputAction", "command", "pwm", "action.devices.types.SWITCH", traits, 0, pins};
}

// One relay/socket channel on a PCF8574 8-bit I2C expander (e.g. KinCony KC868-A8's relay bank).
// Modeled as an independent OnOff outlet; the address+channel are configured per instance via the
// pin slots so several sockets can share one expander. sda/scl are the I2C bus; `address` and
// `channel` are values (not GPIO) carried through the same pin-config mechanism.
inline CapabilityDescriptor i2cSocket8()
{
    static const PinSlotDef     pins[]   = {{"sda", "I2C SDA (KC868-A8 = 4)", INPUT},
                                            {"scl", "I2C SCL (KC868-A8 = 5)", INPUT},
                                            {"address", "I2C Address (e.g. 32=0x20; KC868-A8 relays=36/0x24)", OUTPUT},
                                            {"channel", "Channel (0-7)", OUTPUT},
                                            {nullptr}};
    static const GoogleTraitDef traits[] = {GoogleTraits::OnOff(), {nullptr}};
    return {"i2c_socket_8",
            "I2C Socket (PCF8574, 8-ch)",
            "I2cSocket8Action",
            "command",
            "socket",
            "action.devices.types.OUTLET",
            traits,
            0,
            pins};
}

// One relay/socket channel on an MCP23017 16-bit I2C expander — same model as i2cSocket8(), for
// boards with up to 16 relays. `channel` ranges 0-15.
inline CapabilityDescriptor i2cSocket16()
{
    static const PinSlotDef     pins[]   = {{"sda", "I2C SDA", INPUT},
                                            {"scl", "I2C SCL", INPUT},
                                            {"address", "I2C Address (e.g. 32=0x20)", OUTPUT},
                                            {"channel", "Channel (0-15)", OUTPUT},
                                            {nullptr}};
    static const GoogleTraitDef traits[] = {GoogleTraits::OnOff(), {nullptr}};
    return {"i2c_socket_16",
            "I2C Socket (MCP23017, 16-ch)",
            "I2cSocket16Action",
            "command",
            "socket",
            "action.devices.types.OUTLET",
            traits,
            0,
            pins};
}

// ---- Telemetry ----

inline CapabilityDescriptor temperature()
{
    static const PinSlotDef     pins[]   = {{"data", "1-Wire Data", INPUT}, {nullptr}};
    static const GoogleTraitDef traits[] = {
        GoogleTraits::TemperatureSetting(), GoogleTraits::HumiditySetting(), {nullptr}};
    return {"temperature",
            "Temperature Sensor",
            "TemperatureAction",
            "telemetry",
            "sensor1",
            "action.devices.types.SENSOR",
            traits,
            10000,
            pins};
}

inline CapabilityDescriptor waterLevel()
{
    static const PinSlotDef     pins[]   = {{"adc", "ADC Input", INPUT}, {nullptr}};
    static const GoogleTraitDef traits[] = {GoogleTraits::WaterLevel(), {nullptr}};
    return {"water_level",
            "Water Level Sensor",
            "WaterLevelAction",
            "telemetry",
            "water_level",
            "action.devices.types.SENSOR",
            traits,
            10000,
            pins};
}

inline CapabilityDescriptor phLevel()
{
    static const PinSlotDef     pins[]   = {{"adc", "ADC Input", INPUT}, {nullptr}};
    static const GoogleTraitDef traits[] = {GoogleTraits::PhLevel(), {nullptr}};
    return {"ph_level", "pH Sensor", "PhLevelAction", "telemetry", "ph_level", "action.devices.types.SENSOR", traits,
            5000,       pins};
}

inline CapabilityDescriptor tdsLevel()
{
    static const PinSlotDef     pins[]   = {{"adc", "ADC Input", INPUT}, {nullptr}};
    static const GoogleTraitDef traits[] = {GoogleTraits::TdsLevel(), {nullptr}};
    return {"tds_level", "TDS Sensor", "TdsLevelAction",
            "telemetry", "tds_level",  "action.devices.types.SENSOR",
            traits,      5000,         pins};
}

inline CapabilityDescriptor humidity()
{
    static const PinSlotDef pins[] = {{"sda", "I2C SDA (SHT41)", INPUT}, {"scl", "I2C SCL (SHT41)", INPUT}, {nullptr}};
    static const GoogleTraitDef traits[] = {GoogleTraits::HumiditySetting(), {nullptr}};
    return {"humidity",
            "Humidity Sensor",
            "HumidityAction",
            "telemetry",
            "humidity",
            "action.devices.types.SENSOR",
            traits,
            2000,
            pins};
}

inline CapabilityDescriptor airTemp()
{
    static const PinSlotDef pins[] = {{"sda", "I2C SDA (SHT41)", INPUT}, {"scl", "I2C SCL (SHT41)", INPUT}, {nullptr}};
    static const GoogleTraitDef traits[] = {GoogleTraits::TemperatureSetting(), {nullptr}};
    return {"air_temp",
            "Air Temperature Sensor",
            "AirTemperatureAction",
            "telemetry",
            "air_temp",
            "action.devices.types.SENSOR",
            traits,
            2000,
            pins};
}

inline CapabilityDescriptor co2Level()
{
    static const PinSlotDef pins[] = {
        {"rx", "UART RX (MH-Z19B)", INPUT}, {"tx", "UART TX (MH-Z19B)", OUTPUT}, {nullptr}};
    static const GoogleTraitDef traits[] = {GoogleTraits::CO2Level(), {nullptr}};
    return {"co2_level", "CO2 Sensor", "CO2LevelAction",
            "telemetry", "co2_level",  "action.devices.types.SENSOR",
            traits,      5000,         pins};
}

// ---- Camera (HAS_CAMERA builds only) ----
// One unified capability — a device has at most one physical camera, and CameraAction
// itself picks WS vs HTTP delivery + resolution from per-instance config (camera_transport/
// camera_resolution), not from separate capability types. minIntervalMs is a periodic-
// snapshot floor, not a streaming frame rate — continuous streaming was dropped in favor of
// periodic snapshot + on-demand capture (see CameraAction::triggerCapture).
inline CapabilityDescriptor camera()
{
    static const PinSlotDef     pins[]   = {{nullptr}}; // camera GPIO owned by board macros
    static const GoogleTraitDef traits[] = {GoogleTraits::CameraStream(), {nullptr}};
    return {"camera", "Camera", "CameraAction", "telemetry", "camera", "action.devices.types.CAMERA", traits,
            1000,     pins};
}

// Full manifest for the current build. The HAS_CAMERA gating mirrors the firmware exactly,
// so a host build compiled with -D HAS_CAMERA emits the camera capability and a build
// without it does not.
inline std::vector<CapabilityDescriptor> all()
{
    std::vector<CapabilityDescriptor> caps;
    caps.push_back(outlet());
    caps.push_back(fan());
    caps.push_back(dimmer());
    caps.push_back(pwm());
    caps.push_back(i2cSocket8());
    caps.push_back(i2cSocket16());
    caps.push_back(temperature());
    caps.push_back(waterLevel());
    caps.push_back(phLevel());
    caps.push_back(tdsLevel());
    caps.push_back(humidity());
    caps.push_back(airTemp());
    caps.push_back(co2Level());
#ifdef HAS_CAMERA
    caps.push_back(camera());
#endif
    return caps;
}

} // namespace CapabilityRegistry
