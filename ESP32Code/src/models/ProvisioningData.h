#pragma once

#include <Arduino.h>
#include <ArduinoJson.h>

#define PROVISIONING_DATA_STR_MAX 256

struct ProvisioningData
{
  char userId[PROVISIONING_DATA_STR_MAX];
  char clientId[PROVISIONING_DATA_STR_MAX];
  char provisioningToken[PROVISIONING_DATA_STR_MAX];
  char mqttServer[PROVISIONING_DATA_STR_MAX];
  uint32_t mqttPort;
  bool validateCACert;

  char finalizeCallbackUrl[PROVISIONING_DATA_STR_MAX];
  
  ProvisioningData()
  {
    mqttServer[0] = '\0';
    mqttPort = 0;
    userId[0] = '\0';
    clientId[0] = '\0';
    provisioningToken[0] = '\0';
    validateCACert = false;
    finalizeCallbackUrl[0] = '\0';
  }
  
  void fromJson(JsonVariantConst src)
  {
    strncpy(mqttServer, src["mqttServer"] | "", PROVISIONING_DATA_STR_MAX - 1);
    mqttServer[PROVISIONING_DATA_STR_MAX - 1] = '\0';
    
    mqttPort = src["mqttPort"] | 0;
    
    strncpy(userId, src["userId"] | "", PROVISIONING_DATA_STR_MAX - 1);
    userId[PROVISIONING_DATA_STR_MAX - 1] = '\0';
    
    strncpy(clientId, src["clientId"] | "", PROVISIONING_DATA_STR_MAX - 1);
    clientId[PROVISIONING_DATA_STR_MAX - 1] = '\0';
    
    strncpy(provisioningToken, src["provisioningToken"] | "", PROVISIONING_DATA_STR_MAX - 1);
    provisioningToken[PROVISIONING_DATA_STR_MAX - 1] = '\0';
    
    validateCACert = src["validateCACert"] | false;
    
    strncpy(finalizeCallbackUrl, src["finalizeCallbackUrl"] | "", PROVISIONING_DATA_STR_MAX - 1);
    finalizeCallbackUrl[PROVISIONING_DATA_STR_MAX - 1] = '\0';
  }

  void toJson(JsonVariant dst) const
  {    
    dst["mqttServer"] = mqttServer;
    dst["mqttPort"] = mqttPort;
    dst["userId"] = userId;
    dst["clientId"] = clientId;
    dst["provisioningToken"] = provisioningToken;
    dst["validateCACert"] = validateCACert;
    dst["finalizeCallbackUrl"] = finalizeCallbackUrl;
  }

  bool valid(){
    return strlen(mqttServer) > 0 && mqttPort > 0 && strlen(userId) > 0 && strlen(clientId) > 0 && strlen(provisioningToken) > 0 && strlen(finalizeCallbackUrl) > 0;
  }
} ;
