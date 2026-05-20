#pragma once
#include <Arduino.h>
#include <ArduinoJson.h>

enum class ResponseType
{
    UNDEFINED = 0,
    PROCESSING = 1,
    JSON_PARSE_ERROR = 2,
    JSON_ERROR = 3,
    MISSING_PARAMS = 4,
    WIFI_ERROR = 5,
    MQTT_COMMAND_RESPONSE = 6,
    WIFI_PROVISIONING_IN_PROGRESS = 7,
    MQTT_ERROR = 8,
    // SUCCESS = 9, // Too generic, use more specific success codes
    WIFI_CONNECTED_SUCCESSFULLY = 15,
    REQUESTING_PROVISIONING_TOKEN = 16,
    EXCHANGING_TOKENS_WITH_SERVER = 18,
    TOKENS_EXCHANGED_SUCCESSFULLY = 19,
    TESTING_MQTT_CONNECTION = 20,
    MQTT_CONNECTION_SUCCESSFUL = 21,
    PROVISIONING_SUCCESSFUL = 22,
    PROVISIONING_FAILED = 23
};

#define BLE_RESPONSE_MAX_LEN 256

struct BluetoothResponse
{
    /* data */
    char response[BLE_RESPONSE_MAX_LEN];
    ResponseType type;

    BluetoothResponse() : type(ResponseType::UNDEFINED) 
    { 
        response[0] = '\0';
    }
    
    BluetoothResponse(ResponseType respType, const char *resp) : type(respType) 
    { 
        strncpy(response, resp, BLE_RESPONSE_MAX_LEN - 1);
        response[BLE_RESPONSE_MAX_LEN - 1] = '\0';
    }

    void fromJson(JsonVariantConst src)
    {     
        strncpy(response, src["response"] | "", BLE_RESPONSE_MAX_LEN - 1);
        response[BLE_RESPONSE_MAX_LEN - 1] = '\0';
        type = static_cast<ResponseType>(src["type"] | 0);
    }

    void toJson(JsonVariant dst) const
    {
        dst["response"] = response;
        dst["type"] = static_cast<int>(type);
    }

};
