#include <ArduinoJson.h>
#pragma once
class JsonModel {
public:
    virtual ~JsonModel() = default;
    virtual void fromJson(JsonVariantConst src) = 0;
    virtual void toJson(JsonVariant dst) const = 0;
};