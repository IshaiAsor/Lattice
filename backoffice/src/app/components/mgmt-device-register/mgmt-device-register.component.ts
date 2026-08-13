import { Component, inject, OnInit, OnDestroy } from '@angular/core';
import { MAT_DIALOG_DATA, MatDialogRef } from '@angular/material/dialog';
import { MatCheckboxModule } from '@angular/material/checkbox';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import { Subject, timer, Subscription } from 'rxjs';
import { takeUntil } from 'rxjs/operators';
import { SHARED_MATERIAL } from 'src/app/shared-ui';
import {
  ProvisioningService,
  ProvisioningStep,
  ProvisioningProgress,
  SetupPhase,
  SETUP_PHASE_ORDER,
  WifiNetwork,
  phaseOfStep,
  phaseLabel,
  isFailureStep,
} from 'src/app/services/provisioning.service';
import { DeviceMgmtService, DeviceView, CapabilityView } from 'src/app/services/device.mgmt.service';
import { DeviceSocketService } from 'src/app/services/device.socket.service';
import { CapabilityFieldsComponent } from '../capability-fields/capability-fields.component';
import {
  CapabilityFieldValues,
  defaultFieldValues,
  fieldsValid,
  toActivationBody,
} from '../capability-fields/capability-fields';

/** One capability row in the Configure section. */
export interface SetupRow {
  cap: CapabilityView;
  selected: boolean;
  values: CapabilityFieldValues;
}

/**
 * Device setup, start to finish.
 *
 * Provisioning used to end here — the dialog closed on PROVISIONING_COMPLETE and left the user with
 * a registered device that did nothing, because provisioning deliberately creates no actions. This
 * carries straight on into configuration and does not claim success until the device reports back.
 *
 * Presented as one sheet rather than a stepper: completed phases collapse to a ticked line, so
 * re-entering from "Finish setup" is the same view with the first lines already ticked instead of a
 * special resume mode.
 */
@Component({
  // Checkbox and spinner are not in SHARED_MATERIAL; imported here rather than added to the shared
  // array so the rest of the app doesn't pull them in for one screen.
  imports: [
    SHARED_MATERIAL,
    MatCheckboxModule,
    MatProgressSpinnerModule,
    CapabilityFieldsComponent,
  ],
  selector: 'app-mgmt-device-register',
  templateUrl: './mgmt-device-register.component.html',
  styleUrls: ['./mgmt-device-register.component.css'],
})
export class MgmtDeviceRegisterComponent implements OnInit, OnDestroy {
  dialogRef = inject(MatDialogRef<MgmtDeviceRegisterComponent>);
  /** `{ deviceId }` re-enters at Configure for an already-registered device ("Finish setup"). */
  data: { deviceId?: number } | null = inject(MAT_DIALOG_DATA, { optional: true });
  private provisioningService = inject(ProvisioningService);
  private deviceMgmt = inject(DeviceMgmtService);
  private socket = inject(DeviceSocketService);

  /**
   * How long to wait for the device to come back before saying so. The device reboots to load its
   * config — there is no MQTT config topic — so this covers a full restart plus Wi-Fi and MQTT
   * reconnect, not just a round trip.
   */
  private static readonly REPORT_TIMEOUT_MS = 30_000;

  readonly phaseOrder = SETUP_PHASE_ORDER;
  readonly phaseLabel = phaseLabel;

  /** Phases finished so far. */
  completed = new Set<SetupPhase>();
  currentPhase: SetupPhase = 'connect';

  started = false;
  error: string | null = null;
  showDetails = false;
  /** Raw step stream — the diagnostic, kept behind "Show details". */
  progressLog: ProvisioningProgress[] = [];

  // ── Wi-Fi step ──────────────────────────────────────────────────────────
  /** 'scanning' | 'choose' (list + password) | 'joining' | 'portal' (device-side setup) | null. */
  wifiStage: 'scanning' | 'choose' | 'joining' | 'portal' | null = null;
  networks: WifiNetwork[] = [];
  selectedSsid: string | null = null;
  wifiPassword = '';
  wifiError: string | null = null;
  /** True once the device answers a scan — firmware without it goes straight to the portal. */
  scanSupported = false;

  device: DeviceView | null = null;
  rows: SetupRow[] = [];
  loadingCapabilities = false;

  applying = false;
  /** Set once config is applied and we are waiting for the device to come back. */
  awaitingReport = false;
  reportTimedOut = false;
  done = false;

  private destroy$ = new Subject<void>();
  private reportWatch?: Subscription;
  private knownDeviceIds = new Set<number>();

  ngOnInit(): void {
    this.provisioningService
      .getProgressObservable()
      .pipe(takeUntil(this.destroy$))
      .subscribe((progress) => this.onProgress(progress));

    if (this.data?.deviceId) {
      // Re-entry: the device is already registered, so the BLE phases are history.
      this.completed = new Set<SetupPhase>(['connect', 'network', 'register']);
      this.currentPhase = 'configure';
      this.started = true;
      this.loadDevice(this.data.deviceId);
    }
  }

  ngOnDestroy(): void {
    this.reportWatch?.unsubscribe();
    // The characteristic is held open across the whole flow now, so closing the sheet has to
    // release it — otherwise the device stays paired to a dialog that no longer exists.
    this.provisioningService.disconnect();
    this.destroy$.next();
    this.destroy$.complete();
  }

  // ── Phase presentation ──────────────────────────────────────────────────
  isComplete(phase: SetupPhase): boolean {
    return this.completed.has(phase);
  }
  isCurrent(phase: SetupPhase): boolean {
    return !this.completed.has(phase) && this.currentPhase === phase;
  }
  /** Only phases reached so far are worth showing — the rest are noise until they are relevant. */
  get visiblePhases(): SetupPhase[] {
    const upto = this.phaseOrder.indexOf(this.currentPhase);
    return this.phaseOrder.slice(0, Math.max(upto, 0) + 1);
  }

  // ── Provisioning (BLE) ──────────────────────────────────────────────────
  startProvisioning(): void {
    this.started = true;
    this.error = null;
    this.progressLog = [];
    this.completed.clear();
    this.currentPhase = 'connect';

    // Remember what we already had, so the device that appears afterwards can be identified
    // without guessing. A re-provision of a known device shows up as no new id, which the
    // fallback below handles.
    this.deviceMgmt.getDevices().subscribe({
      next: (devices) => (this.knownDeviceIds = new Set(devices.map((d) => d.id))),
      error: () => (this.knownDeviceIds = new Set()),
    });

    this.provisioningService.connect().subscribe({
      next: () => {
        this.completed.add('connect');
        this.currentPhase = 'network';
        this.beginWifiStep();
      },
      error: (err) => {
        this.error = typeof err === 'string' ? err : (err?.message ?? 'Could not connect');
      },
    });
  }

  // ── Wi-Fi step ──────────────────────────────────────────────────────────
  /**
   * Ask the device what it can see. Firmware that doesn't answer scans is not an error — it just
   * means the only route is its own captive portal, which is what we then explain.
   */
  private beginWifiStep(): void {
    this.wifiStage = 'scanning';
    this.wifiError = null;

    this.provisioningService.scanNetworks().subscribe({
      next: (networks) => {
        this.scanSupported = true;
        this.networks = networks;
        // A device that can see nothing has nothing to offer — send the user to the portal, where
        // they can at least type an SSID by hand.
        this.wifiStage = networks.length ? 'choose' : 'portal';
      },
      error: () => {
        this.scanSupported = false;
        this.wifiStage = 'portal';
      },
    });
  }

  get portalApName(): string {
    return this.provisioningService.portalApName;
  }

  selectNetwork(ssid: string): void {
    this.selectedSsid = ssid;
    this.wifiPassword = '';
    this.wifiError = null;
  }

  get selectedNetwork(): WifiNetwork | null {
    return this.networks.find((n) => n.ssid === this.selectedSsid) ?? null;
  }

  get canJoin(): boolean {
    if (!this.selectedSsid || this.wifiStage === 'joining') return false;
    // Open networks take no password; secured ones need something.
    return !this.selectedNetwork?.secured || this.wifiPassword.length > 0;
  }

  /** Signal bars from dBm: >= -60 strong, -60..-75 fair, weaker than that is poor. */
  signalIcon(rssi: number): string {
    if (rssi >= -60) return 'signal_wifi_4_bar';
    if (rssi >= -75) return 'network_wifi_3_bar';
    return 'network_wifi_1_bar';
  }

  joinNetwork(): void {
    if (!this.selectedSsid || !this.canJoin) return;
    this.wifiStage = 'joining';
    this.wifiError = null;

    this.provisioningService.sendWifiCredentials(this.selectedSsid, this.wifiPassword).subscribe({
      next: () => {
        this.wifiStage = null;
        this.completed.add('network');
        this.currentPhase = 'register';
        this.runProvisioning();
      },
      error: (err) => {
        // Recoverable: the password may simply be wrong, so return to the list rather than
        // failing the whole setup.
        this.wifiStage = 'choose';
        this.wifiError = err?.message ?? 'Could not join that network';
      },
    });
  }

  /** Fall back to the device's own captive portal (also the only route on older firmware). */
  useDevicePortal(): void {
    this.wifiStage = null;
    this.runProvisioning();
  }

  showPortalInstructions(): void {
    this.wifiStage = 'portal';
  }

  backToNetworks(): void {
    this.wifiStage = 'choose';
    this.wifiError = null;
  }

  private runProvisioning(): void {
    this.provisioningService.provision().subscribe({
      error: (err) => {
        this.error = typeof err === 'string' ? err : (err?.message ?? 'Setup failed');
      },
    });
  }

  /**
   * While probing for scan support, the device's rejections are answers, not failures.
   *
   * Firmware without the scan command reads `{"cmd":"scan"}` as a malformed provisioning payload
   * and replies MISSING_PARAMS. That is precisely how we detect it and switch to portal
   * instructions — so surfacing it as an error would put a red banner over a flow that just
   * recovered. The scan subscription owns the outcome of this stage.
   */
  private isExpectedDuringScan(step: ProvisioningStep): boolean {
    return (
      this.wifiStage === 'scanning' &&
      (step === ProvisioningStep.MISSING_PARAMS ||
        step === ProvisioningStep.JSON_ERROR ||
        step === ProvisioningStep.JSON_PARSE_ERROR ||
        step === ProvisioningStep.WIFI_ERROR)
    );
  }

  private onProgress(progress: ProvisioningProgress): void {
    this.progressLog.push(progress);

    if (isFailureStep(progress.step)) {
      if (this.isExpectedDuringScan(progress.step)) return;
      this.error = progress.message || 'The device reported a problem.';
      return;
    }

    const phase = phaseOfStep(progress.step);
    if (phase) {
      // Reaching a phase means every earlier one finished.
      const idx = this.phaseOrder.indexOf(phase);
      for (let i = 0; i < idx; i++) this.completed.add(this.phaseOrder[i]);
      this.currentPhase = phase;
    }

    if (progress.step === ProvisioningStep.PROVISIONING_COMPLETE) {
      this.completed.add('register');
      this.currentPhase = 'configure';
      this.findProvisionedDevice();
    }
  }

  /** The device that just registered: the id we did not have before, else the newest in setup. */
  private findProvisionedDevice(): void {
    this.loadingCapabilities = true;
    this.deviceMgmt.getDevices().subscribe({
      next: (devices) => {
        const fresh = devices.filter((d) => !this.knownDeviceIds.has(d.id));
        const candidate =
          fresh.at(-1) ?? devices.filter((d) => d.status === 'provisioning').at(-1) ?? null;
        if (!candidate) {
          this.loadingCapabilities = false;
          this.error = 'The device registered, but it is not showing up in your devices yet.';
          return;
        }
        this.device = candidate;
        this.loadCapabilities(candidate);
      },
      error: () => {
        this.loadingCapabilities = false;
        this.error = 'Could not load the device that just registered.';
      },
    });
  }

  private loadDevice(deviceId: number): void {
    this.loadingCapabilities = true;
    this.deviceMgmt.getDevices().subscribe({
      next: (devices) => {
        this.device = devices.find((d) => d.id === deviceId) ?? null;
        if (!this.device) {
          this.loadingCapabilities = false;
          this.error = 'That device is no longer in your devices.';
          return;
        }
        this.loadCapabilities(this.device);
      },
      error: () => {
        this.loadingCapabilities = false;
        this.error = 'Could not load this device.';
      },
    });
  }

  // ── Configure ───────────────────────────────────────────────────────────
  private loadCapabilities(device: DeviceView): void {
    // A sealed device's actions come from its admin template — there is nothing to choose.
    if (device.is_sealed) {
      this.loadingCapabilities = false;
      this.completed.add('configure');
      this.currentPhase = 'live';
      this.watchForReport();
      return;
    }

    this.deviceMgmt.getDeviceCapabilities(device.id).subscribe({
      next: (caps) => {
        // Pre-tick only what is ready to apply as it stands — capabilities that need no GPIO
        // chosen. Ticking everything sounds friendlier but isn't: the catalog cannot supply pin
        // numbers, so it would open the sheet with Apply disabled behind a dozen empty fields.
        // A capability already activated (a resumed setup) keeps its instance and isn't offered.
        this.rows = caps.map((cap) => {
          const values = defaultFieldValues(cap);
          return {
            cap,
            selected: cap.instances.length === 0 && fieldsValid(cap, values),
            values,
          };
        });
        this.loadingCapabilities = false;
      },
      error: () => {
        this.loadingCapabilities = false;
        this.error = 'Could not load what this device can do.';
      },
    });
  }

  alreadyActive(row: SetupRow): boolean {
    return row.cap.instances.length > 0;
  }

  toggleRow(row: SetupRow, selected: boolean): void {
    row.selected = selected;
  }

  rowValid(row: SetupRow): boolean {
    return fieldsValid(row.cap, row.values);
  }

  get selectedRows(): SetupRow[] {
    return this.rows.filter((r) => r.selected && !this.alreadyActive(r));
  }

  get selectedCount(): number {
    return this.selectedRows.length;
  }

  /** Every ticked row must be complete — an unticked row's half-filled pins do not block Apply. */
  get canApply(): boolean {
    if (this.applying || this.awaitingReport) return false;
    return this.selectedRows.every((r) => this.rowValid(r));
  }

  typeChip(cap: CapabilityView): string {
    return cap.mqtt_action_type === 'telemetry' ? 'sensor' : 'command';
  }

  apply(): void {
    if (!this.device || !this.canApply) return;
    this.applying = true;
    this.error = null;

    const selections = this.selectedRows.map((r) => toActivationBody(r.cap, r.values));

    this.deviceMgmt.applySetup(this.device.id, selections).subscribe({
      next: () => {
        this.applying = false;
        this.completed.add('configure');
        this.currentPhase = 'live';
        this.watchForReport();
      },
      error: () => {
        this.applying = false;
        this.error = 'Could not save this configuration. Nothing was changed on the device.';
      },
    });
  }

  /**
   * Wait for evidence, not for an HTTP 200.
   *
   * Applying config restarts the device, so it drops off and comes back. Coming back online is the
   * signal that it booted with the new config. If it does not, say so and offer a retry — never
   * silently claim success.
   */
  private watchForReport(): void {
    if (!this.device) return;
    const deviceId = this.device.id;

    this.awaitingReport = true;
    this.reportTimedOut = false;
    this.reportWatch?.unsubscribe();

    const sub = new Subscription();

    sub.add(
      this.socket
        .onDeviceOnlineStatusChange()
        .pipe(takeUntil(this.destroy$))
        .subscribe(({ deviceId: id, online }) => {
          if (id === deviceId && online) this.markLive();
        }),
    );

    sub.add(
      timer(MgmtDeviceRegisterComponent.REPORT_TIMEOUT_MS)
        .pipe(takeUntil(this.destroy$))
        .subscribe(() => {
          if (!this.awaitingReport) return;
          this.awaitingReport = false;
          this.reportTimedOut = true;
        }),
    );

    this.reportWatch = sub;
  }

  private markLive(): void {
    this.awaitingReport = false;
    this.reportTimedOut = false;
    this.done = true;
    this.completed.add('live');
    this.reportWatch?.unsubscribe();
  }

  /** Re-send the restart. The config is already saved, so this only nudges the device again. */
  retryReport(): void {
    if (!this.device) return;
    this.reportTimedOut = false;
    this.deviceMgmt.restartDevice(this.device.id).subscribe({
      next: () => this.watchForReport(),
      error: () => (this.error = 'Could not reach the device to restart it.'),
    });
  }

  finish(): void {
    this.dialogRef.close({ deviceId: this.device?.id ?? null, configured: this.done });
  }

  onClose(): void {
    this.dialogRef.close();
  }

  // ── Details disclosure ──────────────────────────────────────────────────
  toggleDetails(): void {
    this.showDetails = !this.showDetails;
  }

  stepName(step: ProvisioningStep): string {
    return String(step);
  }
}
