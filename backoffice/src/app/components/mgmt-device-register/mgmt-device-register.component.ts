import { Component, Inject, OnInit, OnDestroy } from '@angular/core';
import { MAT_DIALOG_DATA, MatDialogRef } from '@angular/material/dialog';
// DeviceView removed — devices are UserDevice from models/index.ts
import { ProvisioningService, ProvisioningStep, ProvisioningProgress } from 'src/app/services/provisioning.service';
import { Subject } from 'rxjs';
import { takeUntil } from 'rxjs/operators';
import { SHARED_MATERIAL } from 'src/app/shared-ui';

@Component({
  imports: [SHARED_MATERIAL],
  selector: 'app-mgmt-device-register',
  templateUrl: './mgmt-device-register.component.html',
  styleUrls: ['./mgmt-device-register.component.css']
})
export class MgmtDeviceRegisterComponent implements OnInit, OnDestroy {
  isProvisioning = false;
  currentStep: ProvisioningStep | null = null;
  provisioningSteps: ProvisioningProgress[] = [];
  error: string | null = null;
  
  private destroy$ = new Subject<void>();

constructor(
    public dialogRef: MatDialogRef<MgmtDeviceRegisterComponent>,
    @Inject(MAT_DIALOG_DATA) public data: unknown,
    private provisioningService: ProvisioningService
  ) {}

  ngOnInit(): void {
    // Subscribe to provisioning progress updates
    this.provisioningService
      .getProgressObservable()
      .pipe(takeUntil(this.destroy$))
      .subscribe((progress: ProvisioningProgress) => {
        console.log('Received provisioning progress update:', progress);
        this.currentStep = progress.step;
        this.provisioningSteps.push(progress);
        if(progress.step === ProvisioningStep.PROVISIONING_COMPLETE)
        this.dialogRef.close({ registered: true });
      });
  }

  ngOnDestroy(): void {
    this.destroy$.next();
    this.destroy$.complete();
  }

  onClose(): void {
    this.dialogRef.close();
  }

  startProvisioning(): void {
    this.isProvisioning = true;
    this.error = null;
    this.provisioningSteps = [];

    this.provisioningService.setupDevice().subscribe({
      next: (status) => {
        console.log('Provisioning completed:', status);
      },
      error: (err) => {
        this.error = `An error occurred: ${err.message || err}`;
        this.isProvisioning = false;
      },
      complete: () => {
        this.isProvisioning = false;
      },
    });
  }

  getStepDisplayName(step: ProvisioningStep): string {
    const displayNames: Record<ProvisioningStep, string> = {
      [ProvisioningStep.UNDEFINED]: 'Undefined',
      [ProvisioningStep.PROCESSING]: 'Processing',
      [ProvisioningStep.JSON_PARSE_ERROR]: 'JSON Parse Error',
      [ProvisioningStep.JSON_ERROR]: 'JSON Error',
      [ProvisioningStep.MISSING_PARAMS]: 'Missing Parameters',
      [ProvisioningStep.WIFI_ERROR]: 'WiFi Error',
      [ProvisioningStep.MQTT_COMMAND_RESPONSE]: 'MQTT Command Response',
      [ProvisioningStep.WIFI_PROVISIONING_IN_PROGRESS]: 'WiFi Provisioning in Progress',
      [ProvisioningStep.MQTT_ERROR]: 'MQTT Error',
      [ProvisioningStep.SUCCESS]: 'Success',
      [ProvisioningStep.BLE_PAIRING_READY]: '1. BLE Pairing Ready',
      [ProvisioningStep.BLE_PAIRING_COMPLETE]: '1. BLE Pairing Complete',
      [ProvisioningStep.NETWORK_SCANNING]: '2. Scanning Networks',
      [ProvisioningStep.NETWORK_FOUND]: '2. Network Found',
      [ProvisioningStep.NETWORK_CONNECTING]: '2. Connecting to Network',
      [ProvisioningStep.NETWORK_CONNECTED]: '2. Network Connected',
      [ProvisioningStep.REQUESTING_PROV_TOKEN]: '3. Requesting Provisioning Token',
      [ProvisioningStep.PROV_TOKEN_RECEIVED]: '3. Provisioning Token Received',
      [ProvisioningStep.EXCHANGING_TOKENS]: '3. Exchanging Tokens',
      [ProvisioningStep.TOKENS_EXCHANGED]: '3. Tokens Exchanged',
      [ProvisioningStep.TESTING_MQTT]: '4. Testing MQTT Connection',
  
      [ProvisioningStep.MQTT_CONNECTED_SUCCESS]: '4. MQTT Connected',
      [ProvisioningStep.PROVISIONING_COMPLETE]: '✓ Provisioning Complete',
      [ProvisioningStep.PROVISIONING_FAILED]: '✗ Provisioning Failed',
    };
    return displayNames[step] || 'Unknown Step';
  }

  isStepSuccess(step: ProvisioningStep): boolean {
    return ![ProvisioningStep.PROVISIONING_FAILED].includes(step);
  }
}
