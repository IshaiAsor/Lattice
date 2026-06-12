#pragma once
#include <HTTPClient.h>
#include <WiFiClient.h>
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
    WiFiClient plainClient;

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

        if (url.startsWith("https://"))
        {
            if (validateCACert)
            {
                secureClient.setCACert(root_ca);
            }
            else
            {
                secureClient.setInsecure();
            }
            httpClient.begin(secureClient, url.c_str());
        }
        else
        {
            httpClient.begin(plainClient, url.c_str());
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

        httpClient.setTimeout(10000); // Set timeout to 10 seconds for potentially long operations
        int httpResponseCode = httpClient.POST(payloadString);

        if (httpResponseCode == 200)
        {
            String responseBody = httpClient.getString();
            Serial.println("Received response:");
            Serial.println(responseBody);

            JsonDocument doc;
            DeserializationError error = deserializeJson(doc, responseBody);

            if (error)
            {
                Serial.print("Failed to parse JSON response: ");
                Serial.println("Response body:");
                Serial.println(responseBody);
                Serial.println("Payload:");
                Serial.println(payloadString);
                Serial.println("URL:");
                Serial.println(url);
                Serial.println("Token:");
                Serial.println(token);
                Serial.println("ValidateCACert:");
                Serial.println(validateCACert);
                Serial.println("HTTP Response Code:");
                Serial.println(error.c_str());
                httpClient.end();
                return TOut(); 
            }

            TOut output;
            output.fromJson(doc); 
            httpClient.end();
            return output;
        }
        else
        {
            Serial.print("HTTP POST failed, code: ");
            Serial.println(httpResponseCode);
            httpClient.end(); 
            return TOut();    
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

        if (url.startsWith("https://"))
        {
            if (validateCACert)
            {
                secureClient.setCACert(root_ca);
            }
            else
            {
                secureClient.setInsecure();
            }
            httpClient.begin(secureClient, url.c_str());
        }
        else
        {
            httpClient.begin(plainClient, url.c_str());
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

            JsonDocument doc;
            DeserializationError error = deserializeJson(doc, responseBody);

            if (error)
            {
                Serial.print("Failed to parse JSON response: ");
                Serial.println(error.c_str());
                httpClient.end();
                return TOut(); 
            }

            TOut output;
            output.fromJson(doc); 
            httpClient.end();
            return output;
        }
        else
        {
            Serial.print("HTTP GET failed, code: ");
            Serial.println(httpResponseCode);
            httpClient.end(); 
            return TOut();    
        }
    }
};