#pragma once
#include <HTTPClient.h>
#include <WiFiClientSecure.h>
#include <ArduinoJson.h>
#include <type_traits>
#include "models/JsonModel.h" // Ensure this path points to your JsonModel definition
extern const char *root_ca;

template <typename TIn, typename TOut>
class HttpJsonClientService
{
    static_assert(std::is_base_of<JsonModel, TIn>::value, "TIn must inherit from JsonModel");
    static_assert(std::is_base_of<JsonModel, TOut>::value, "TOut must inherit from JsonModel");

private:
    HTTPClient httpClient;
    WiFiClientSecure secureClient;

public:
    HttpJsonClientService() {}
    ~HttpJsonClientService() {}

    TOut PostJson(const String url, const String token, const TIn *payload, bool validateCACert)
    {
         Serial.write("Post request");
        Serial.print("url : ");
        Serial.println(url);
        Serial.print("token : ");
        Serial.println(token);
        Serial.print("validateCACert : ");
        Serial.println(validateCACert);
        Serial.print("root_ca : ");
        Serial.println(root_ca);
        Serial.println(validateCACert);
        if (validateCACert)
        {
            secureClient.setCACert(root_ca);
            httpClient.begin(secureClient, url.c_str());
        }
        else
        {
            secureClient.setInsecure();
            httpClient.begin(secureClient, url.c_str());
        }

        httpClient.addHeader("Content-Type", "application/json");
        httpClient.addHeader("Authorization", String("Bearer ") + token.c_str());
        httpClient.addHeader("Accept", "application/json");

        JsonDocument reqDoc;
        payload->toJson(reqDoc); // We know this exists because of JsonModel

        String payloadString;
        serializeJson(reqDoc, payloadString);
        Serial.print("Payload:");
        Serial.println(payloadString);

        int httpResponseCode = httpClient.POST(payloadString);

        if (httpResponseCode == 200)
        {
            String responseBody = httpClient.getString();
            Serial.println("Received response:");
            Serial.println(responseBody);

            // FIX: Use JsonDocument without a fixed size.
            // It will automatically manage memory on the heap.
            JsonDocument doc;
            DeserializationError error = deserializeJson(doc, responseBody);

            if (error)
            {
                Serial.print("Failed to parse JSON response: ");
                Serial.println(error.c_str());
                httpClient.end();
                return TOut(); // Fixed: return default constructor for template type
            }

            TOut output;
            output.fromJson(doc); // Ensure your TOut classes implement this method
            httpClient.end();
            return output;
        }
        else
        {
            Serial.print("HTTP POST failed, code: ");
            Serial.println(httpResponseCode);
            httpClient.end(); // Always close the connection
            return TOut();    // Fixed: return default constructor
        }
    }

    TOut GetJson(const String url, const String token, bool validateCACert)
    {
        Serial.write("Get request");
        Serial.print("url : ");
        Serial.println(url);
        Serial.print("token : ");
        Serial.println(token);
        Serial.print("validateCACert : ");
        Serial.println(validateCACert);
        Serial.print("root_ca : ");
        Serial.println(root_ca);
        Serial.println(validateCACert);
        if (validateCACert)
        {
            secureClient.setCACert(root_ca);
            httpClient.begin(secureClient, url.c_str());
        }
        else
        {
            secureClient.setInsecure();
            httpClient.begin(secureClient, url.c_str());
        }

        httpClient.addHeader("Content-Type", "application/json");
        httpClient.addHeader("Authorization", String("Bearer ") + token.c_str());
        httpClient.addHeader("Accept", "application/json");

        int httpResponseCode = httpClient.GET();

        if (httpResponseCode == 200)
        {
            String responseBody = httpClient.getString();
            Serial.println("Received response:");
            Serial.println(responseBody);

            // FIX: Use JsonDocument without a fixed size.
            // It will automatically manage memory on the heap.
            JsonDocument doc;
            DeserializationError error = deserializeJson(doc, responseBody);

            if (error)
            {
                Serial.print("Failed to parse JSON response: ");
                Serial.println(error.c_str());
                httpClient.end();
                return TOut(); // Fixed: return default constructor for template type
            }

            TOut output;
            output.fromJson(doc); // Ensure your TOut classes implement this method
            httpClient.end();
            return output;
        }
        else
        {
            Serial.print("HTTP GET failed, code: ");
            Serial.println(httpResponseCode);
            httpClient.end(); // Always close the connection
            return TOut();    // Fixed: return default constructor
        }
    }
};