import { ComponentFixture, TestBed, fakeAsync, tick } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { provideHttpClientTesting } from '@angular/common/http/testing';
import { MAT_DIALOG_DATA, MatDialogRef } from '@angular/material/dialog';
import { NoopAnimationsModule } from '@angular/platform-browser/animations';
import { NEVER, Subject, of } from 'rxjs';
import { MgmtDeviceRegisterComponent } from './mgmt-device-register.component';
import {
  ProvisioningService,
  ProvisioningProgress,
  ProvisioningStep,
} from 'src/app/services/provisioning.service';
import { DeviceMgmtService, DeviceView } from 'src/app/services/device.mgmt.service';
import { DeviceSocketService } from 'src/app/services/device.socket.service';

function deviceView(id: number, status = 'provisioning'): DeviceView {
  return {
    id,
    deviceName: `device-${id}`,
    online: true,
    lastOnlineDate: new Date(0),
    type: 'ESP32_WROOM32E',
    version: 'v2.0.438',
    is_sealed: false,
    status,
    current_firmware_version: 'v2.0.438',
    update_available: false,
    update_in_progress: false,
    pending_firmware_version: null,
    rssi: -60,
    area_id: null,
  };
}

function progress(step: ProvisioningStep): ProvisioningProgress {
  return { step, message: '', timestamp: 0 };
}

describe('MgmtDeviceRegisterComponent', () => {
  let component: MgmtDeviceRegisterComponent;
  let fixture: ComponentFixture<MgmtDeviceRegisterComponent>;
  let progress$: Subject<ProvisioningProgress>;
  let getDevices: jasmine.Spy;

  beforeEach(async () => {
    progress$ = new Subject<ProvisioningProgress>();
    getDevices = jasmine.createSpy('getDevices').and.returnValue(of([]));

    await TestBed.configureTestingModule({
      imports: [MgmtDeviceRegisterComponent, NoopAnimationsModule],
      providers: [
        provideHttpClient(),
        provideHttpClientTesting(),
        { provide: MatDialogRef, useValue: { close: jasmine.createSpy('close') } },
        { provide: MAT_DIALOG_DATA, useValue: null },
        {
          provide: ProvisioningService,
          useValue: {
            getProgressObservable: () => progress$.asObservable(),
            // The board under test releases BLE mid-provision, so this never emits.
            provision: () => NEVER,
            disconnect: () => undefined,
          },
        },
        {
          provide: DeviceMgmtService,
          useValue: { getDevices, getDeviceCapabilities: () => of([]) },
        },
        {
          provide: DeviceSocketService,
          useValue: { onDeviceOnlineStatusChange: () => NEVER },
        },
      ],
    }).compileComponents();

    fixture = TestBed.createComponent(MgmtDeviceRegisterComponent);
    component = fixture.componentInstance;
    fixture.detectChanges();
  });

  it('should create', () => {
    expect(component).toBeTruthy();
  });

  /**
   * The FREE_BLE_BEFORE_TLS boards release the BLE stack at TESTING_MQTT, so
   * PROVISIONING_COMPLETE never arrives — the device registers and reboots in silence.
   */
  it('completes registration from the device list when BLE goes dark at TESTING_MQTT', fakeAsync(() => {
    const known = deviceView(1, 'active');
    component['knownDeviceIds'] = new Set([known.id]);

    getDevices.and.returnValue(of([known]));
    progress$.next(progress(ProvisioningStep.TESTING_MQTT));

    expect(component.awaitingRegistration).toBeTrue();
    expect(component.currentPhase).toBe('register');

    tick(2000); // one poll, device not registered yet
    expect(component.currentPhase).toBe('register');

    getDevices.and.returnValue(of([known, deviceView(7)]));
    tick(2000);

    expect(component.isComplete('register')).toBeTrue();
    expect(component.currentPhase).toBe('configure');
    expect(component.device?.id).toBe(7);
    expect(component.awaitingRegistration).toBeFalse();
    expect(component.error).toBeNull();
  }));

  it('stops polling once the device does confirm over BLE', fakeAsync(() => {
    component['knownDeviceIds'] = new Set<number>();
    getDevices.and.returnValue(of([deviceView(7)]));

    progress$.next(progress(ProvisioningStep.TESTING_MQTT));
    progress$.next(progress(ProvisioningStep.PROVISIONING_COMPLETE));

    expect(component.currentPhase).toBe('configure');
    expect(component.awaitingRegistration).toBeFalse();
    const callsAfterSettle = getDevices.calls.count();

    tick(10_000);
    expect(getDevices.calls.count()).toBe(callsAfterSettle);
  }));

  it('reports a device that never registers instead of spinning forever', fakeAsync(() => {
    component['knownDeviceIds'] = new Set([1]);
    getDevices.and.returnValue(of([deviceView(1, 'active')]));

    progress$.next(progress(ProvisioningStep.TESTING_MQTT));
    tick(60_000);

    expect(component.error).toContain('went quiet');
    expect(component.awaitingRegistration).toBeFalse();
    expect(component.currentPhase).toBe('register');
  }));
});
