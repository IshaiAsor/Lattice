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
import { from, map, Observable, Subject, switchMap, throwError } from 'rxjs';

const SERVICE_UUID = '12345678-1234-5678-1234-56789abcdef0';
const CHAR_UUID = 'abcdef01-1234-5678-1234-56789abcdef0';

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
  // Wi-Fi chosen in the app rather than on the device's captive portal.
  WIFI_SCAN_RESULT = "WIFI_SCAN_RESULT",
  WIFI_SCAN_COMPLETE = "WIFI_SCAN_COMPLETE",
  WIFI_CONNECTING = "WIFI_CONNECTING",
}

/** One network the device can see. */
export interface WifiNetwork {
  ssid: string;
  /** dBm. */
  rssi: number;
  secured: boolean;
}

export interface ProvisioningProgress {
  step: ProvisioningStep;
  message: string;
  timestamp: number;
}

/**
 * The five phases setup is presented as.
 *
 * The 24-member step enum stays on the wire — it is a genuinely useful diagnostic, and the device
 * is the only thing that knows which of `JSON_PARSE_ERROR` / `MISSING_PARAMS` / `WIFI_ERROR` it
 * hit. But it is a debug log, not an onboarding screen, so the UI shows these five and keeps the
 * raw steps behind a "Show details" disclosure.
 */
export type SetupPhase = 'connect' | 'network' | 'register' | 'configure' | 'live';

export const SETUP_PHASE_ORDER: SetupPhase[] = [
  'connect',
  'network',
  'register',
  'configure',
  'live',
];

const PHASE_BY_STEP: Partial<Record<ProvisioningStep, SetupPhase>> = {
  [ProvisioningStep.BLE_PAIRING_READY]: 'connect',
  [ProvisioningStep.BLE_PAIRING_COMPLETE]: 'connect',
  [ProvisioningStep.PROCESSING]: 'connect',

  [ProvisioningStep.NETWORK_SCANNING]: 'network',
  [ProvisioningStep.NETWORK_FOUND]: 'network',
  [ProvisioningStep.NETWORK_CONNECTING]: 'network',
  [ProvisioningStep.NETWORK_CONNECTED]: 'network',
  [ProvisioningStep.WIFI_PROVISIONING_IN_PROGRESS]: 'network',

  [ProvisioningStep.REQUESTING_PROV_TOKEN]: 'register',
  [ProvisioningStep.PROV_TOKEN_RECEIVED]: 'register',
  [ProvisioningStep.EXCHANGING_TOKENS]: 'register',
  [ProvisioningStep.TOKENS_EXCHANGED]: 'register',
  [ProvisioningStep.TESTING_MQTT]: 'register',
  [ProvisioningStep.MQTT_CONNECTED_SUCCESS]: 'register',
  [ProvisioningStep.PROVISIONING_COMPLETE]: 'register',
  [ProvisioningStep.SUCCESS]: 'register',
};

/** Which phase a raw step belongs to. Anything unmapped is a failure of the phase it occurred in. */
export function phaseOfStep(step: ProvisioningStep): SetupPhase | null {
  return PHASE_BY_STEP[step] ?? null;
}

const PHASE_LABELS: Record<SetupPhase, string> = {
  connect: 'Paired over Bluetooth',
  network: 'Joined your Wi-Fi network',
  register: 'Registered with Lattice',
  configure: 'Configured',
  live: 'Reporting',
};

export function phaseLabel(phase: SetupPhase): string {
  return PHASE_LABELS[phase];
}

/** Steps that mean the device gave up. Everything else is progress or diagnostic noise. */
export function isFailureStep(step: ProvisioningStep): boolean {
  return (
    step === ProvisioningStep.PROVISIONING_FAILED ||
    step === ProvisioningStep.WIFI_ERROR ||
    step === ProvisioningStep.MQTT_ERROR ||
    step === ProvisioningStep.JSON_ERROR ||
    step === ProvisioningStep.JSON_PARSE_ERROR ||
    step === ProvisioningStep.MISSING_PARAMS
  );
}

@Injectable({
  providedIn: 'root',
})
export class ProvisioningService {
  private get gatewayUrl(): string {
    return environment.deviceGatewayUrl ||
      (environment.production ? `${window.location.protocol}//device.${window.location.hostname}` : 'http://localhost:3004');
  }
  private provisioningProgress$ = new Subject<ProvisioningProgress>();
  private http = inject(HttpClient);

  // Public observable to track provisioning progress
  getProgressObservable(): Observable<ProvisioningProgress> {
    return this.provisioningProgress$.asObservable();
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
    24: ProvisioningStep.WIFI_SCAN_RESULT,
    25: ProvisioningStep.WIFI_SCAN_COMPLETE,
    26: ProvisioningStep.WIFI_CONNECTING,

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

  // ── BLE session ─────────────────────────────────────────────────────────
  //
  // Setup is several exchanges, not one write: ask the device what networks it can see, send the
  // one the user picked, then provision. So the characteristic is held open for the whole flow
  // rather than written once and dropped.
  private char: BluetoothRemoteGATTCharacteristic | null = null;
  private tokenData: ProvisionTokenResponse | null = null;
  /** The BLE advertised name is the DEVICE_TYPE, which is also its captive-portal AP prefix. */
  private deviceName = '';

  get connectedDeviceName(): string {
    return this.deviceName;
  }

  /** The AP the device raises for its own Wi-Fi portal — `<DEVICE_TYPE>_Setup`, open network. */
  get portalApName(): string {
    return this.deviceName ? `${this.deviceName}_Setup` : 'the device’s setup network';
  }

  /** Pick a device in the browser's chooser, connect, and start listening. */
  connect(): Observable<string> {
    return this.http
      .get<ProvisionTokenResponse>(`${this.gatewayUrl}/api/provisioning/provision-token`)
      .pipe(
        switchMap((result) => {
          this.tokenData = result;
          return from(
            navigator.bluetooth.requestDevice({
              // Filter by the provisioning service every Lattice device advertises, not a name
              // prefix — sealed device types advertise their DEVICE_TYPE (e.g. MULTI_SOCKET_8_CH,
              // HYDRO_FARM_*) as the BLE name, so an 'ESP32' prefix would hide them from the picker.
              filters: [{ services: [SERVICE_UUID] }],
              optionalServices: [SERVICE_UUID],
            }),
          );
        }),
        switchMap((device) => {
          if (!device.gatt) {
            return throwError(() => new Error('GATT server not found on device.'));
          }
          this.deviceName = device.name ?? '';
          return from(device.gatt.connect());
        }),
        switchMap((server) => from(server.getPrimaryService(SERVICE_UUID))),
        switchMap((service) => from(service.getCharacteristic(CHAR_UUID))),
        switchMap((char) => {
          this.char = char;
          char.addEventListener('characteristicvaluechanged', this.onNotification);
          return from(char.startNotifications());
        }),
        map(() => this.deviceName),
      );
  }

  /**
   * Ask the device which networks it can see.
   *
   * The device answers one notification per network then a completion marker, so this collects
   * until that marker arrives. Firmware without this command reads the write as a malformed
   * provisioning payload and answers MISSING_PARAMS — which is how we detect an older device and
   * fall back to offering its captive portal instead.
   */
  scanNetworks(timeoutMs = 20000): Observable<WifiNetwork[]> {
    return new Observable<WifiNetwork[]>((subscriber) => {
      const found: WifiNetwork[] = [];

      const sub = this.provisioningProgress$.subscribe((p) => {
        if (p.step === ProvisioningStep.WIFI_SCAN_RESULT) {
          const parsed = parseScanResult(p.message);
          if (parsed) found.push(parsed);
        } else if (p.step === ProvisioningStep.WIFI_SCAN_COMPLETE) {
          subscriber.next(dedupeStrongest(found));
          subscriber.complete();
        } else if (
          p.step === ProvisioningStep.MISSING_PARAMS ||
          p.step === ProvisioningStep.JSON_ERROR
        ) {
          subscriber.error(new Error('SCAN_UNSUPPORTED'));
        } else if (p.step === ProvisioningStep.WIFI_ERROR) {
          subscriber.error(new Error(p.message || 'Scan failed'));
        }
      });

      const timer = setTimeout(() => {
        // Treat silence as "this firmware doesn't answer scans" rather than a hard failure — the
        // portal route still works, and that is what the caller falls back to.
        subscriber.error(new Error('SCAN_UNSUPPORTED'));
      }, timeoutMs);

      this.write({ cmd: 'scan' }).catch((err) => subscriber.error(err));

      return () => {
        clearTimeout(timer);
        sub.unsubscribe();
      };
    });
  }

  /** Send the network the user picked. Resolves once the device is actually on Wi-Fi. */
  sendWifiCredentials(ssid: string, password: string, timeoutMs = 40000): Observable<void> {
    return new Observable<void>((subscriber) => {
      const sub = this.provisioningProgress$.subscribe((p) => {
        if (p.step === ProvisioningStep.NETWORK_CONNECTED) {
          subscriber.next();
          subscriber.complete();
        } else if (
          p.step === ProvisioningStep.WIFI_ERROR ||
          p.step === ProvisioningStep.MISSING_PARAMS
        ) {
          subscriber.error(new Error(p.message || 'Could not join that network'));
        }
      });

      const timer = setTimeout(
        () => subscriber.error(new Error('Timed out joining that network')),
        timeoutMs,
      );

      this.write({ cmd: 'wifi', ssid, password }).catch((err) => subscriber.error(err));

      return () => {
        clearTimeout(timer);
        sub.unsubscribe();
      };
    });
  }

  /**
   * Send the provisioning payload — deliberately the same bytes it has always been.
   *
   * This characteristic has no chunk reassembly on the device side, so the Wi-Fi credentials ride
   * in their own small write above rather than being folded in here.
   */
  provision(): Observable<string> {
    return new Observable<string>((subscriber) => {
      const sub = this.provisioningProgress$.subscribe((p) => {
        if (p.step === ProvisioningStep.PROVISIONING_COMPLETE) {
          subscriber.next('SUCCESS');
          subscriber.complete();
        } else if (p.step === ProvisioningStep.PROVISIONING_FAILED) {
          subscriber.error(new Error(p.message || 'Provisioning failed'));
        }
      });

      const t = this.tokenData;
      if (!t) {
        subscriber.error(new Error('Not connected to a device'));
        return;
      }

      this.write({
        server: t.server,
        mqttPort: t.mqttPort,
        userId: t.userId,
        provisioningToken: t.provisioningToken,
        validateCACert: t.validateCACert,
        provisioningCallbackUrl: t.provisioningCallbackUrl,
      }).catch((err) => subscriber.error(err));

      return () => sub.unsubscribe();
    });
  }

  disconnect(): void {
    const char = this.char;
    this.char = null;
    this.tokenData = null;
    this.deviceName = '';
    if (!char) return;
    char.removeEventListener('characteristicvaluechanged', this.onNotification);
    if (char.service.device.gatt?.connected) {
      char.service.device.gatt.disconnect();
    }
  }

  private write(body: unknown): Promise<void> {
    if (!this.char) return Promise.reject(new Error('Not connected to a device'));
    return this.char.writeValue(new TextEncoder().encode(JSON.stringify(body)));
  }

  // Arrow property: used as an addEventListener handler, so it must keep `this`.
  private onNotification = (event: Event): void => {
    try {
      const dataView = (event.target as BluetoothRemoteGATTCharacteristic).value;
      const parsed = JSON.parse(new TextDecoder().decode(dataView ?? undefined));
      this.provisioningProgress$.next({
        step: this.mapResponseTypeToStep(parsed.type),
        message: parsed.response,
        timestamp: Date.now(),
      });
    } catch (error) {
      console.error('Error parsing BLE response:', error);
    }
  };
}

/** `"<rssi>|<secured>|<ssid>"` — SSID last so a '|' inside it survives the split. */
function parseScanResult(raw: string): WifiNetwork | null {
  if (!raw) return null;
  const first = raw.indexOf('|');
  const second = raw.indexOf('|', first + 1);
  if (first < 0 || second < 0) return null;
  const ssid = raw.slice(second + 1);
  if (!ssid) return null;
  return {
    rssi: Number(raw.slice(0, first)) || 0,
    secured: raw.slice(first + 1, second) === '1',
    ssid,
  };
}

/** Mesh APs advertise the same SSID from several radios; show each name once, at its best signal. */
function dedupeStrongest(networks: WifiNetwork[]): WifiNetwork[] {
  const best = new Map<string, WifiNetwork>();
  for (const n of networks) {
    const seen = best.get(n.ssid);
    if (!seen || n.rssi > seen.rssi) best.set(n.ssid, n);
  }
  return [...best.values()].sort((a, b) => b.rssi - a.rssi);
}
