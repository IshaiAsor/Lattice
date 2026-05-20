#pragma once

#include <Arduino.h>
#include <ArduinoJson.h>

#define PROVISIONING_DATA_STR_MAX 256

struct ProvisioningData
{
  char server[PROVISIONING_DATA_STR_MAX];
  uint32_t mqttPort;
  char userId[PROVISIONING_DATA_STR_MAX];
  char provisioningToken[PROVISIONING_DATA_STR_MAX];
  bool validateCACert;
  char provisioningCallbackUrl[PROVISIONING_DATA_STR_MAX];
  
  ProvisioningData()
  {
    server[0] = '\0';
    mqttPort = 0;
    userId[0] = '\0';
    provisioningToken[0] = '\0';
    validateCACert = false;
    provisioningCallbackUrl[0] = '\0';
  }
  
  void fromJson(JsonVariantConst src)
  {
    strncpy(server, src["server"] | "", PROVISIONING_DATA_STR_MAX - 1);
    server[PROVISIONING_DATA_STR_MAX - 1] = '\0';
    
    mqttPort = src["mqttPort"] | 0;
    
    strncpy(userId, src["userId"] | "", PROVISIONING_DATA_STR_MAX - 1);
    userId[PROVISIONING_DATA_STR_MAX - 1] = '\0';
    
    strncpy(provisioningToken, src["provisioningToken"] | "", PROVISIONING_DATA_STR_MAX - 1);
    provisioningToken[PROVISIONING_DATA_STR_MAX - 1] = '\0';
    
    validateCACert = src["validateCACert"] | false;
    
    strncpy(provisioningCallbackUrl, src["provisioningCallbackUrl"] | "", PROVISIONING_DATA_STR_MAX - 1);
    provisioningCallbackUrl[PROVISIONING_DATA_STR_MAX - 1] = '\0';
  }

  void toJson(JsonVariant dst) const
  {    
    dst["server"] = server;
    dst["mqttPort"] = mqttPort;
    dst["userId"] = userId;
    dst["provisioningToken"] = provisioningToken;
    dst["validateCACert"] = validateCACert;
    dst["provisioningCallbackUrl"] = provisioningCallbackUrl;
  }

  bool valid(){
    return strlen(server) > 0 && mqttPort > 0 && strlen(userId) > 0 && strlen(provisioningToken) > 0 && strlen(provisioningCallbackUrl) > 0;
  }
} ;
