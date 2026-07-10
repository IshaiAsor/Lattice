// Emits the device capability manifest for one device-type as JSON on stdout:
//   { "deviceType": "...", "version": "...", "capabilities": [ ... ] }
//
// Compiled per device-type with the same -DHAS_CAMERA gating as the firmware, so the
// manifest is exactly what that firmware would report at provisioning — without a board.
#include <ArduinoJson.h>
#include <iostream>
#include <string>
#include "actions/manifest/CapabilityRegistry.h"
#include "models/CapabilitySerializer.h"

#define STR2(x) #x
#define STR(x) STR2(x)

#ifndef GEN_DEVICE_TYPE
#define GEN_DEVICE_TYPE UNKNOWN
#endif
#ifndef GEN_DEVICE_VERSION
#define GEN_DEVICE_VERSION 0.0.0
#endif

int main()
{
    JsonDocument doc;
    doc["deviceType"] = STR(GEN_DEVICE_TYPE);
    doc["version"]    = STR(GEN_DEVICE_VERSION);
    JsonArray caps    = doc["capabilities"].to<JsonArray>();
    for (const auto& d : CapabilityRegistry::all())
        serializeCapability(caps, d);

    std::string out;
    serializeJson(doc, out);
    std::cout << out << std::endl;
    return 0;
}
