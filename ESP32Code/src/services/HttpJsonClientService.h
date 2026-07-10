#pragma once
#include <HTTPClient.h>
#include <WiFiClient.h>
#include <WiFiClientSecure.h>
#include <ArduinoJson.h>
#include <type_traits>
#include "models/JsonModel.h"
#include "config/Log.h"
extern const char* root_ca;

template <typename TIn, typename TOut> class HttpJsonClientService
{
    static_assert(std::is_base_of<JsonModel, TIn>::value, "TIn must inherit from JsonModel");
    static_assert(std::is_base_of<JsonModel, TOut>::value, "TOut must inherit from JsonModel");

  private:
    HTTPClient       httpClient;
    WiFiClientSecure secureClient;
    WiFiClient       plainClient;

  public:
    HttpJsonClientService() {}
    ~HttpJsonClientService() {}

    TOut PostJson(const String url, const String token, const TIn* payload)
    {
        // Never log the token itself — length only.
        LOG_D("Http", "POST %s (token %u chars)", url.c_str(), token.length());

        if (url.startsWith("https://"))
        {
            // Prod always validates against the pinned CA (no insecure fallback).
            secureClient.setCACert(root_ca);
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
        LOG_D("Http", "payload: %s", payloadString.c_str());

        int httpResponseCode = httpClient.POST(payloadString);

        if (httpResponseCode == 200)
        {
            String responseBody = httpClient.getString();
            LOG_D("Http", "response: %s", responseBody.c_str());

            JsonDocument         doc;
            DeserializationError error = deserializeJson(doc, responseBody);

            if (error)
            {
                LOG_W("Http", "failed to parse JSON response: %s", error.c_str());
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
            LOG_W("Http", "POST failed, code: %d", httpResponseCode);
            httpClient.end();
            return TOut();
        }
    }

    TOut GetJson(const String url, const String token)
    {
        LOG_D("Http", "GET %s (token %u chars)", url.c_str(), token.length());

        if (url.startsWith("https://"))
        {
            // Prod always validates against the pinned CA (no insecure fallback).
            secureClient.setCACert(root_ca);
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
            LOG_D("Http", "response: %s", responseBody.c_str());

            JsonDocument         doc;
            DeserializationError error = deserializeJson(doc, responseBody);

            if (error)
            {
                LOG_W("Http", "failed to parse JSON response: %s", error.c_str());
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
            LOG_W("Http", "GET failed, code: %d", httpResponseCode);
            httpClient.end();
            return TOut();
        }
    }
};