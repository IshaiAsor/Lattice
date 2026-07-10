#pragma once
#include <vector>
#include <Arduino.h>
#include <ArduinoJson.h>
#include "JsonModel.h"
#include "actions/ActionPinsSetup.h"
#include "models/CapabilitySerializer.h"

struct ProvisionRequest : public JsonModel
{
    String                            macAddress;
    String                            deviceType;
    String                            version;
    std::vector<CapabilityDescriptor> capabilities;

    void fromJson(JsonVariantConst src) override {}

    void toJson(JsonVariant dst) const override
    {
        dst["macAddress"] = macAddress;
        dst["deviceType"] = deviceType;
        dst["version"]    = version;
        JsonArray caps    = dst["capabilities"].to<JsonArray>();
        for (const auto& d : capabilities)
            serializeCapability(caps, d);
    }
};
