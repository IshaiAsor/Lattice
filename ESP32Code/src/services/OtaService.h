#ifndef OTA_SERVICE_H
#define OTA_SERVICE_H

#include <Arduino.h>
#include <HTTPClient.h>
#include <HTTPUpdate.h>
#include <WiFiClientSecure.h>
#include <ArduinoJson.h>

class OtaService {
public:
    OtaService(const char* currentVersion, const char* deviceType, const char* rootCa)
        : _currentVersion(currentVersion), _deviceType(deviceType), _rootCa(rootCa) {}

    void handleUpdateMessage(const char* payload, const char* authToken = "") {
        JsonDocument doc;
        DeserializationError error = deserializeJson(doc, payload);

        if (error) {
            Serial.print("OTA: Failed to parse update payload: ");
            Serial.println(error.c_str());
            return;
        }

        const char* newVersion = doc["version"];
        const char* downloadUrl = doc["url"];

        if (!newVersion || !downloadUrl) {
            Serial.println("OTA: Invalid payload format");
            return;
        }

        if (!isNewerVersion(newVersion, _currentVersion)) {
            Serial.printf("OTA: Skipping — current=%s, received=%s\n", _currentVersion, newVersion);
            return;
        }

        if (!authToken || !*authToken) {
            Serial.println("OTA: No device token available — refusing to download unauthenticated.");
            return;
        }

        Serial.printf("OTA: Upgrading %s → %s\n", _currentVersion, newVersion);
        Serial.print("OTA: Downloading from: ");
        Serial.println(downloadUrl);

        performUpdate(downloadUrl, authToken);
    }

private:
    const char* _currentVersion;
    const char* _deviceType;
    const char* _rootCa;

    // Returns true only when newVer is strictly greater than curVer (semver "Vmajor.minor.patch").
    // Rejects downgrades and same-version re-flashes.
    static bool isNewerVersion(const char* newVer, const char* curVer) {
        int nMaj = 0, nMin = 0, nPat = 0;
        int cMaj = 0, cMin = 0, cPat = 0;
        // Accept optional leading 'V' or 'v'
        const char* n = (*newVer == 'V' || *newVer == 'v') ? newVer + 1 : newVer;
        const char* c = (*curVer  == 'V' || *curVer  == 'v') ? curVer  + 1 : curVer;
        if (sscanf(n, "%d.%d.%d", &nMaj, &nMin, &nPat) != 3) return false;
        if (sscanf(c, "%d.%d.%d", &cMaj, &cMin, &cPat) != 3) return false;
        if (nMaj != cMaj) return nMaj > cMaj;
        if (nMin != cMin) return nMin > cMin;
        return nPat > cPat;
    }

    void performUpdate(const char* url, const char* authToken = "") {
        WiFiClientSecure client;
        client.setCACert(_rootCa);

        // Optional: set timeout for large downloads
        client.setTimeout(12000);

        Serial.println("OTA: Starting update process...");

        // Authenticate the download against the OTA manager with the device's JWT.
        // HTTPUpdate has no setAuthorization(), so inject the header via the request callback.
        String auth = (authToken && *authToken) ? (String("Bearer ") + authToken) : String();

        // This is a blocking call that will restart the ESP32 on success
        t_httpUpdate_return ret = httpUpdate.update(client, url, "", [auth](HTTPClient *http) {
            if (auth.length())
                http->addHeader("Authorization", auth);
        });

        switch (ret) {
            case HTTP_UPDATE_FAILED:
                Serial.printf("OTA: Update failed! Error (%d): %s\n", 
                              httpUpdate.getLastError(), 
                              httpUpdate.getLastErrorString().c_str());
                break;

            case HTTP_UPDATE_NO_UPDATES:
                Serial.println("OTA: No updates available.");
                break;

            case HTTP_UPDATE_OK:
                Serial.println("OTA: Update successful! Rebooting...");
                break;
        }
    }
};

#endif
