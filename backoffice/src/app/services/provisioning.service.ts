/// <reference types="web-bluetooth" />

import { HttpClient } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';

interface ProvisionTokenResponse {
  userId: string;
  provisioningToken: string;
  server: string;
  mqttPort: number;
  provisioningCallbackUrl: string;
  validateCACert: boolean;
}
import { environment } from 'src/environments/environment';
import { from, Observable, Subject, switchMap, throwError } from 'rxjs';

export enum ProvisioningStep {
  BLE_PAIRING_READY = 'BLE_PAIRING_READY',
  BLE_PAIRING_COMPLETE = 'BLE_PAIRING_COMPLETE',
  NETWORK_SCANNING = 'NETWORK_SCANNING',
  NETWORK_FOUND = 'NETWORK_FOUND',
  NETWORK_CONNECTING = 'NETWORK_CONNECTING',
  NETWORK_CONNECTED = 'NETWORK_CONNECTED',
  REQUESTING_PROV_TOKEN = 'REQUESTING_PROV_TOKEN',
  PROV_TOKEN_RECEIVED = 'PROV_TOKEN_RECEIVED',
  EXCHANGING_TOKENS = 'EXCHANGING_TOKENS',
  TOKENS_EXCHANGED = 'TOKENS_EXCHANGED',
  TESTING_MQTT = 'TESTING_MQTT',
  MQTT_CONNECTED_SUCCESS = 'MQTT_CONNECTED_SUCCESS',
  PROVISIONING_COMPLETE = 'PROVISIONING_COMPLETE',
  PROVISIONING_FAILED = 'PROVISIONING_FAILED',
  UNDEFINED = "UNDEFINED",
  PROCESSING = "PROCESSING",
  JSON_PARSE_ERROR = "JSON_PARSE_ERROR",
  JSON_ERROR = "JSON_ERROR",
  MISSING_PARAMS = "MISSING_PARAMS",
  WIFI_ERROR = "WIFI_ERROR",
  MQTT_COMMAND_RESPONSE = "MQTT_COMMAND_RESPONSE",
  WIFI_PROVISIONING_IN_PROGRESS = "WIFI_PROVISIONING_IN_PROGRESS",
  MQTT_ERROR = "MQTT_ERROR",
  SUCCESS = "SUCCESS",
}

export interface ProvisioningProgress {
  step: ProvisioningStep;
  message: string;
  timestamp: number;
}

@Injectable({
  providedIn: 'root',
})
export class ProvisioningService {
  private apiUrl = `${environment.apiUrl}`;
  private get gatewayUrl(): string {
    return environment.deviceGatewayUrl ||
      (environment.production ? `${window.location.protocol}//device.${window.location.hostname}` : '');
  }
  private provisioningProgress$ = new Subject<ProvisioningProgress>();
  private http = inject(HttpClient);

  // Public observable to track provisioning progress
  getProgressObservable(): Observable<ProvisioningProgress> {
    return this.provisioningProgress$.asObservable();
  }

  private onProvisionSuccess(): void {
    console.log('Provisioning successful!');
  }

  private mapResponseTypeToStep(responseType: number): ProvisioningStep {
    const typeMap: Record<number, ProvisioningStep> = {
      0: ProvisioningStep.UNDEFINED,
      1: ProvisioningStep.PROCESSING,
      2: ProvisioningStep.JSON_PARSE_ERROR,
      3: ProvisioningStep.JSON_ERROR,
      4: ProvisioningStep.MISSING_PARAMS,
      5: ProvisioningStep.WIFI_ERROR,
      6: ProvisioningStep.MQTT_COMMAND_RESPONSE,
      7: ProvisioningStep.WIFI_PROVISIONING_IN_PROGRESS,
      8: ProvisioningStep.MQTT_ERROR,
      9: ProvisioningStep.SUCCESS,

      // Step-by-step provisioning status updates
    10: ProvisioningStep.BLE_PAIRING_READY,
    11: ProvisioningStep.BLE_PAIRING_COMPLETE,
    12: ProvisioningStep.NETWORK_SCANNING,
    13: ProvisioningStep.NETWORK_FOUND,
    14: ProvisioningStep.NETWORK_CONNECTING,
    15: ProvisioningStep.NETWORK_CONNECTED,
    16: ProvisioningStep.REQUESTING_PROV_TOKEN,
    17: ProvisioningStep.PROV_TOKEN_RECEIVED,
    18: ProvisioningStep.EXCHANGING_TOKENS,
    19: ProvisioningStep.TOKENS_EXCHANGED,
    20: ProvisioningStep.TESTING_MQTT,
    21: ProvisioningStep.MQTT_CONNECTED_SUCCESS,
    22: ProvisioningStep.PROVISIONING_COMPLETE,
    23: ProvisioningStep.PROVISIONING_FAILED
    };
    return typeMap[responseType] || ProvisioningStep.PROVISIONING_FAILED;
  }

  setupDevice(): Observable<string> {
    const SERVICE_UUID = '12345678-1234-5678-1234-56789abcdef0';
    const CHAR_UUID = 'abcdef01-1234-5678-1234-56789abcdef0';

    return this.http
      .get<ProvisionTokenResponse>(`${this.gatewayUrl}/api/provisioning/provision-token`)
      .pipe(
        switchMap((result) =>
          from(
            navigator.bluetooth.requestDevice({
              filters: [
                { namePrefix: 'ESP32' }
              ],
              optionalServices: [SERVICE_UUID],
            }),
          ).pipe(
            switchMap((device) => {
              if (!device.gatt) {
                return throwError(() => new Error('GATT server not found on device.'));
              }
              return from(device.gatt.connect());
            }),
            switchMap((server) => from(server.getPrimaryService(SERVICE_UUID))),
            switchMap((service) => from(service.getCharacteristic(CHAR_UUID))),
            switchMap((char) =>
              this.handleCharacteristic(
                char,
                result.userId,
                result.provisioningToken,
                result.server,
                result.mqttPort,
                result.provisioningCallbackUrl,
                result.validateCACert
              )
            ),
          ),
        ),
      );
  }

  private handleCharacteristic(
    char: BluetoothRemoteGATTCharacteristic,
    userId: string,
    token: string,
    server: string,
    mqttPort: number,
    provisioningCallbackUrl: string,
    validateCACert: boolean
  ): Observable<string> {
    return new Observable<string>((subscriber) => {
      const listener = (event: Event) => {
        try {
          const dataView = (event.target as BluetoothRemoteGATTCharacteristic).value;
          const data = new TextDecoder().decode(dataView ?? undefined);
          const parsedData = JSON.parse(data);
         // console.log('Received BLE notification:', parsedData);
          const step = this.mapResponseTypeToStep(parsedData.type);
          const message = parsedData.response;

          const progress: ProvisioningProgress = {
            step,
            message,
            timestamp: Date.now(),
          };
          // console.log('Received provisioning progress:', progress);
          this.provisioningProgress$.next(progress);

          if (step === ProvisioningStep.PROVISIONING_COMPLETE) {
            this.onProvisionSuccess();
            subscriber.next('SUCCESS');
            subscriber.complete();
          } else if (step === ProvisioningStep.PROVISIONING_FAILED) {
            subscriber.error(`Provisioning failed: ${message}`);
          }
        } catch (error) {
          console.error('Error parsing BLE response:', error);
          subscriber.error(error);
        }
      };

      char.addEventListener('characteristicvaluechanged', listener);

      char
        .startNotifications()
        .then(() => {
          const payload = JSON.stringify({
            server: server,
            mqttPort: mqttPort,
            userId: userId,
            provisioningToken: token,
            validateCACert: validateCACert,
            provisioningCallbackUrl: provisioningCallbackUrl,
          });
          console.log('Writing to characteristic with payload:', payload);
          return char.writeValue(new TextEncoder().encode(payload));
        })
        .catch((error) => subscriber.error(error));

      // Return a teardown function to be called on unsubscribe.
      return () => {
        char.removeEventListener('characteristicvaluechanged', listener);
        if (char.service.device.gatt?.connected) {
          char.service.device.gatt.disconnect();
        }
      };
    });
  }
}
