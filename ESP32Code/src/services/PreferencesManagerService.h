#pragma once
#include <ArduinoJson.h>
#include <Preferences.h>
#include <type_traits>
#include <nvs_flash.h>

#include "models/JsonModel.h" // Ensure this path points to your JsonModel definition

struct DeviceConfig : public JsonModel
{
public:
    String deviceConfigUrl;
    String wsStreamUrl;
    String cameraHttpUrl;
    String refreshTokenCallbackUrl;
    bool validateCACert;
    String deviceId;
    void fromJson(JsonVariantConst src) override
    {
        deviceConfigUrl = src["deviceConfigUrl"] | "";
        wsStreamUrl = src["wsStreamUrl"] | "";
        cameraHttpUrl = src["cameraHttpUrl"] | "";
        refreshTokenCallbackUrl = src["refreshTokenCallbackUrl"] | "";
        validateCACert = src["validateCACert"] | false;
        deviceId = src["deviceId"] | "";
    }

    void toJson(JsonVariant dst) const override
    {
        dst["deviceConfigUrl"] = deviceConfigUrl;
        dst["wsStreamUrl"] = wsStreamUrl;
        dst["cameraHttpUrl"] = cameraHttpUrl;
        dst["refreshTokenCallbackUrl"] = refreshTokenCallbackUrl;
        dst["validateCACert"] = validateCACert;
        dst["deviceId"] = deviceId;
    }
};

struct MqttCredentials : public JsonModel
{
public:
    String server;
    uint32_t port;
    String clientId;
    String userId;
    bool validateCACert;

    void fromJson(JsonVariantConst src) override
    {
        server = src["mqtt_server"] | "";
        port = src["mqtt_port"] | 0;
        clientId = src["client_id"] | "";
        userId = src["user"] | "";
        validateCACert = src["validateCACert"] | false;
    }

    void toJson(JsonVariant dst) const override
    {
        dst["mqtt_server"] = server;
        dst["mqtt_port"] = port;
        dst["client_id"] = clientId;
        dst["user"] = userId;
        dst["validateCACert"] = validateCACert;
    }
};

struct JwtToken : public JsonModel
{
public:
    String token;
    String refreshToken;
    String refreshTokenCallbackUrl;
    bool validateCACert;

    void fromJson(JsonVariantConst src) override
    {
        token = src["token"] | "";
        refreshToken = src["refresh_token"] | "";
        refreshTokenCallbackUrl = src["ref_token_url"] | "";
        validateCACert = src["validateCACert"] | false;
    }

    void toJson(JsonVariant dst) const override
    {
        dst["token"] = token;
        dst["refresh_token"] = refreshToken;
        dst["ref_token_url"] = refreshTokenCallbackUrl;
        dst["validateCACert"] = validateCACert;
    }
};

struct ActionState : public JsonModel
{
public:
    String action;
    String state;
    ActionState(String a, String s)
    {
        action = a;
        state = s;
    }

    ActionState() {}

    void fromJson(JsonVariantConst src) override
    {
        action = src["action"] | "";
        state = src["state"] | "";
    }

    void toJson(JsonVariant dst) const override
    {
        dst["action"] = action;
        dst["state"] = state;
    }
};

template <typename T>

class PreferencesGenericService
{
    private:
    Preferences preferences;
    const char *PREF_NAMESPACE = "iot-creds";

    static_assert(std::is_base_of<JsonModel, T>::value, "T must inherit from JsonModel");

public:
    void SaveConfig(const String store, const T *config)
    {
        Serial.write("Saving config");
        Serial.println(store);
        
        JsonDocument reqDoc;
        config->toJson(reqDoc); // We know this exists because of JsonModel

        String payloadString;
        serializeJson(reqDoc, payloadString);
        Serial.print("Payload:");
        Serial.println(payloadString);

        preferences.begin(PREF_NAMESPACE, false);
        preferences.putString(store.c_str(), payloadString.c_str());
        preferences.end();
    }

    T *LoadConfig(const char *store)
    {
        Serial.write("Loading config");
        Serial.println(store);

        preferences.begin(PREF_NAMESPACE, false);
        if (!preferences.isKey(store))
        {
            Serial.println("No config found in storage.");
            preferences.clear();
            preferences.end();
            return nullptr;
        }
        String configJson = preferences.getString(store, "");
        JsonDocument doc;
        DeserializationError error = deserializeJson(doc, configJson);
        if (error)
        {
            Serial.print(F("Failed to parse JSON config: "));
            Serial.println(error.c_str());
            preferences.clear();
            preferences.end();
            return nullptr;
        }
        Serial.println("Config retrieved:");
        Serial.println(configJson);

        T *config = new T();
        config->fromJson(doc);
        preferences.end();

        return config;
    }
};

class PreferencesManagerService
{

    private:
    Preferences preferences;
    const char *PREF_NAMESPACE = "iot-creds";

public:
    PreferencesManagerService() {}
    ~PreferencesManagerService() {}

private:
    template <typename T>
    void SaveConfig(const String store, const T *config)
    {
        PreferencesGenericService<T> genericService;
        genericService.SaveConfig(store, config);
    }

    template <typename T>
    T *LoadConfig(const char *store)
    {
        PreferencesGenericService<T> genericService;
        return genericService.LoadConfig(store);
    }

public:
    void SaveDeviceConfig(DeviceConfig &config)
    {
        SaveConfig("Config", &config);
    }

    DeviceConfig *LoadDeviceConfig()
    {
        return LoadConfig<DeviceConfig>("Config");
    }

    void SaveMqttCredentials(MqttCredentials &creds)
    {
        SaveConfig("MqttCredentials", &creds);
    }

    MqttCredentials *LoadMqttCredentials()
    {
        return LoadConfig<MqttCredentials>("MqttCredentials");
    }

    void SaveJwtToken(JwtToken &jwt)
    {
        SaveConfig("JwtToken", &jwt);
    }

    JwtToken *LoadJwtToken()
    {
        return LoadConfig<JwtToken>("JwtToken");
    }

    void SaveActionState(ActionState &state)
    {
        SaveConfig("ActionState", &state);
    }

    ActionState *LoadActionState()
    {
        return LoadConfig<ActionState>("ActionState");
    }

    void ClearCredentials()
    {
        preferences.begin(PREF_NAMESPACE, false);
        preferences.clear();
        preferences.end();
    }

    void ClearAllCredentials()
    {
        preferences.begin(PREF_NAMESPACE, false);
        preferences.clear();
        preferences.end();
        nvs_flash_deinit();
        nvs_flash_erase();
        nvs_flash_init();
    }
};

// Global instance declaration
extern PreferencesManagerService prefService;