import { Component, inject, OnInit, OnDestroy } from '@angular/core';
import { AbstractControl, FormBuilder, FormGroup, ValidationErrors, ValidatorFn, Validators } from '@angular/forms';
import { MAT_DIALOG_DATA, MatDialogRef } from '@angular/material/dialog';
import { SHARED_MATERIAL } from 'src/app/shared-ui';
import type { ModelAction } from 'src/app/models';
import { GoogleActionsTypesService, GoogleActionType } from 'src/app/services/google.actions.types.service';
import { GoogleActionsTraitsService, GoogleActionTrait } from 'src/app/services/google.actions.traits.service';
import { Subscription } from 'rxjs';

export interface ActionDialogData {
  action: ModelAction | null;
  usedPins: Map<number, string>; // GPIO number → mqtt_name of the action using it
}

export const IMPLEMENTATION_TYPES = [
  { label: 'Outlet (on/off)',       value: 'OutletAction',              actionType: 'command'   },
  { label: 'Light Dimmer (PWM)',    value: 'LightDimmerAction',         actionType: 'command'   },
  { label: 'Motor (directional)',   value: 'OneDirectionalMotorAction', actionType: 'command'   },
  { label: 'Temperature Sensor',   value: 'TemperatureAction',         actionType: 'telemetry' },
  { label: 'Water Level Sensor',    value: 'WaterLevelAction',          actionType: 'telemetry' },
  { label: 'pH Sensor',             value: 'PhLevelAction',             actionType: 'telemetry' },
  { label: 'TDS Sensor',            value: 'TdsLevelAction',            actionType: 'telemetry' },
  { label: 'Humidity (SHT41)',      value: 'HumidityAction',            actionType: 'telemetry' },
  { label: 'Air Temperature (SHT41)', value: 'AirTemperatureAction',   actionType: 'telemetry' },
  { label: 'CO2 Sensor (MH-Z19B)', value: 'CO2LevelAction',            actionType: 'telemetry' },
  { label: 'Camera (JPEG)',        value: 'TakePictureAction',         actionType: 'telemetry' },
  { label: 'Camera (Live Stream)', value: 'LiveStreamAction',          actionType: 'telemetry' },
];

export interface PinSlot {
  key: string;
  label: string;
  mode: 'OUTPUT' | 'INPUT';
  description: string;
}

export const PIN_BLUEPRINTS: Record<string, PinSlot[]> = {
  OutletAction: [
    { key: 'relay', label: 'Relay Pin',             mode: 'OUTPUT',
      description: 'GPIO pin connected to the relay coil' },
  ],
  LightDimmerAction: [
    { key: 'pwm',   label: 'PWM Pin',               mode: 'OUTPUT',
      description: 'GPIO pin for PWM brightness control (analogWrite)' },
  ],
  OneDirectionalMotorAction: [
    { key: 'in1',   label: 'Direction Pin 1 (IN1)', mode: 'OUTPUT',
      description: 'Motor driver IN1 — forward direction control' },
    { key: 'in2',   label: 'Direction Pin 2 (IN2)', mode: 'OUTPUT',
      description: 'Motor driver IN2 — reverse direction control' },
    { key: 'pwm',   label: 'Speed Pin (PWM)',        mode: 'OUTPUT',
      description: 'Motor driver enable/speed pin (analogWrite)' },
  ],
  TemperatureAction: [
    { key: 'data',  label: '1-Wire Data Pin',        mode: 'INPUT',
      description: 'DS18B20 one-wire data line (requires 4.7 kΩ pull-up to 3.3 V)' },
  ],
  WaterLevelAction: [
    { key: 'adc',   label: 'ADC Input Pin',            mode: 'INPUT',
      description: 'Analog GPIO pin connected to the water level sensor' },
  ],
  PhLevelAction: [
    { key: 'adc',   label: 'ADC Input Pin',            mode: 'INPUT',
      description: 'Analog GPIO pin connected to the pH sensor' },
  ],
  TdsLevelAction: [
    { key: 'adc',   label: 'ADC Input Pin',            mode: 'INPUT',
      description: 'Analog GPIO pin connected to the TDS probe' },
  ],
  HumidityAction: [
    { key: 'sda',   label: 'I2C SDA (SHT41)',          mode: 'INPUT',
      description: 'I2C data line for the SHT41 sensor' },
    { key: 'scl',   label: 'I2C SCL (SHT41)',          mode: 'INPUT',
      description: 'I2C clock line for the SHT41 sensor' },
  ],
  AirTemperatureAction: [
    { key: 'sda',   label: 'I2C SDA (SHT41)',          mode: 'INPUT',
      description: 'I2C data line for the SHT41 sensor (same pin as Humidity)' },
    { key: 'scl',   label: 'I2C SCL (SHT41)',          mode: 'INPUT',
      description: 'I2C clock line for the SHT41 sensor (same pin as Humidity)' },
  ],
  CO2LevelAction: [
    { key: 'rx',    label: 'UART RX (MH-Z19B)',        mode: 'INPUT',
      description: 'ESP32 RX pin connected to MH-Z19B TX' },
    { key: 'tx',    label: 'UART TX (MH-Z19B)',        mode: 'OUTPUT',
      description: 'ESP32 TX pin connected to MH-Z19B RX' },
  ],
  TakePictureAction: [],
  LiveStreamAction:  [],
};

// No two pin slots may share the same GPIO number
const noDuplicatePinsValidator: ValidatorFn = (group: AbstractControl): ValidationErrors | null => {
  const fg = group as FormGroup;
  const values = Object.values(fg.controls).map(c => Number(c.value)).filter(v => v > 0);
  return values.length !== new Set(values).size ? { duplicatePin: true } : null;
};

// Per-control validator: reports if the entered GPIO number is already claimed by another action
function pinInUseValidator(usedPins: Map<number, string>): ValidatorFn {
  return (control: AbstractControl): ValidationErrors | null => {
    const pin = Number(control.value);
    if (!pin || pin < 1) return null;
    const owner = usedPins.get(pin);
    return owner ? { pinInUse: owner } : null;
  };
}

@Component({
  selector: 'app-action-dialog',
  imports: [SHARED_MATERIAL],
  template: `
    <h2 mat-dialog-title>{{ data ? 'Edit' : 'Add' }} Action</h2>
    <mat-dialog-content>
      <form [formGroup]="form" class="dialog-form">

        <mat-form-field appearance="outline">
          <mat-label>Action Key (e.g. TemperatureAction)</mat-label>
          <input matInput formControlName="action_key" />
        </mat-form-field>

        <mat-form-field appearance="outline">
          <mat-label>MQTT Name</mat-label>
          <input matInput formControlName="mqtt_name" placeholder="e.g. outlet1, temp_sensor"
                 (input)="onMqttNameInput()" />
          @if (!mqttNameUserEdited && !data) {
            <mat-hint>Auto-derived from Default Name</mat-hint>
          }
          @if (form.get('mqtt_action_name')?.hasError('pattern')) {
            <mat-error>Only lowercase letters, digits, and underscores (e.g. outlet1, temp_sensor)</mat-error>
          }
        </mat-form-field>

        <mat-form-field appearance="outline">
          <mat-label>Implementation Type</mat-label>
          <mat-select formControlName="capability">
            @for (t of implTypes; track t.value) {
              <mat-option [value]="t.value">{{ t.label }}</mat-option>
            }
          </mat-select>
        </mat-form-field>

        <div class="readonly-row">
          <span class="label">MQTT Type</span>
          <span class="chip" [class.telemetry]="form.get('mqtt_type')?.value === 'telemetry'">
            {{ form.get('mqtt_type')?.value }}
          </span>
          <span class="muted">(auto-set by implementation type)</span>
        </div>

        <!-- ── GPIO Pin Blueprint ── -->
        <p class="section-label">GPIO Pin Assignment</p>

        @if (currentBlueprint.length === 0) {
          <div class="info-box">
            <mat-icon>info</mat-icon>
            Camera GPIO pins are defined by the board-level hardware configuration.
            No pin assignment needed here.
          </div>
        } @else {
          <div [formGroup]="pinForm" class="pin-blueprint">
            @for (slot of currentBlueprint; track slot.key) {
              <div class="pin-slot">
                <div class="pin-slot-header">
                  <span class="pin-label">{{ slot.label }}</span>
                  <span class="mode-badge" [class.input-mode]="slot.mode === 'INPUT'">{{ slot.mode }}</span>
                </div>
                <mat-form-field appearance="outline" class="pin-number-field">
                  <mat-label>GPIO Pin Number</mat-label>
                  <input matInput type="number" [formControlName]="slot.key" min="1" max="48" />
                  @if (pinForm.get(slot.key)?.hasError('required') || pinForm.get(slot.key)?.hasError('min')) {
                    <mat-error>Enter a valid GPIO pin (1–48)</mat-error>
                  }
                  @if (pinForm.get(slot.key)?.hasError('max')) {
                    <mat-error>ESP32-S3 GPIOs go up to 48</mat-error>
                  }
                  @if (pinForm.get(slot.key)?.hasError('pinInUse')) {
                    <mat-error>GPIO {{ pinForm.get(slot.key)?.value }} is already used by action '{{ pinForm.get(slot.key)?.getError('pinInUse') }}'</mat-error>
                  }
                  <mat-hint>{{ slot.description }}</mat-hint>
                </mat-form-field>
              </div>
            }
            @if (pinForm.hasError('duplicatePin')) {
              <mat-error class="group-error">Two or more slots share the same GPIO pin number — each slot must use a unique pin.</mat-error>
            }
          </div>
        }

        <!-- ── Telemetry Interval ── -->
        @if (form.get('mqtt_type')?.value === 'telemetry') {
          <mat-form-field appearance="outline">
            <mat-label>Read Interval (ms)</mat-label>
            <input matInput type="number" formControlName="telemetry_interval_ms" min="0" />
            <mat-hint>
              @if (!form.get('telemetry_interval_ms')?.value) {
                Firmware default will be used (0 = default)
              } @else {
                Sensor sampled every {{ form.get('telemetry_interval_ms')?.value }} ms
              }
            </mat-hint>
            @if (form.get('telemetry_interval_ms')?.hasError('min')) {
              <mat-error>Interval cannot be negative</mat-error>
            }
            @if (form.get('telemetry_interval_ms')?.hasError('max')) {
              <mat-error>Maximum interval is 3 600 000 ms (1 hour)</mat-error>
            }
          </mat-form-field>
        }

        <!-- ── Google Home ── -->
        <p class="section-label">Google Home</p>
        <mat-form-field appearance="outline">
          <mat-label>Google Action Type</mat-label>
          <mat-select formControlName="google_action_type_id">
            @for (t of googleTypes; track t.id) {
              <mat-option [value]="t.id">{{ t.name }}</mat-option>
            }
          </mat-select>
          @if (form.get('google_action_type_id')?.hasError('required')) {
            <mat-error>Google Action Type is required</mat-error>
          }
        </mat-form-field>

        <mat-form-field appearance="outline">
          <mat-label>Google Traits</mat-label>
          <mat-select formControlName="trait_ids" multiple>
            @for (t of googleTraits; track t.id) {
              <mat-option [value]="t.id">{{ t.name }}</mat-option>
            }
          </mat-select>
          @if (compatibleTraitNames.length) {
            <mat-hint>Compatible with this implementation: {{ compatibleTraitNames.join(', ') }}</mat-hint>
          }
        </mat-form-field>

      </form>
    </mat-dialog-content>
    <mat-dialog-actions align="end">
      <button mat-button mat-dialog-close>Cancel</button>
      <button mat-flat-button color="primary" [disabled]="!isFormValid()" (click)="save()">Save</button>
    </mat-dialog-actions>
  `,
  styles: [`
    .dialog-form { display: flex; flex-direction: column; gap: 10px; min-width: 460px; padding-top: 8px; }
    .section-label { margin: 6px 0 2px; font-weight: 600; font-size: 13px; color: #444; }
    .readonly-row { display: flex; align-items: center; gap: 8px; font-size: 13px; color: #555; }
    .readonly-row .label { font-weight: 500; }
    .muted { color: #999; font-size: 12px; }
    .chip { padding: 2px 8px; border-radius: 12px; font-size: 12px; background: #e3f2fd; color: #1565c0; }
    .chip.telemetry { background: #f3e5f5; color: #6a1b9a; }
    .info-box { display: flex; align-items: flex-start; gap: 8px; padding: 10px 12px;
                background: #e8f5e9; border-radius: 6px; font-size: 13px; color: #2e7d32; }
    .info-box mat-icon { font-size: 18px; height: 18px; width: 18px; margin-top: 1px; }
    .pin-blueprint { display: flex; flex-direction: column; gap: 12px; }
    .pin-slot { display: flex; flex-direction: column; gap: 4px; }
    .pin-slot-header { display: flex; align-items: center; gap: 8px; }
    .pin-label { font-size: 13px; font-weight: 500; color: #333; }
    .mode-badge { padding: 1px 7px; border-radius: 10px; font-size: 11px; font-weight: 600;
                  background: #fff3e0; color: #e65100; }
    .mode-badge.input-mode { background: #e8eaf6; color: #283593; }
    .pin-number-field { width: 100%; }
    .group-error { font-size: 12px; color: #d32f2f; margin-top: -4px; }
  `],
})
export class ActionDialogComponent implements OnInit, OnDestroy {
  private fb = inject(FormBuilder);
  private dialogRef = inject(MatDialogRef<ActionDialogComponent>);
  dialogData: ActionDialogData = inject(MAT_DIALOG_DATA);
  get data(): ModelAction | null { return this.dialogData.action; }
  private typesService = inject(GoogleActionsTypesService);
  private traitsService = inject(GoogleActionsTraitsService);
  private subs = new Subscription();

  implTypes = IMPLEMENTATION_TYPES;
  googleTypes: GoogleActionType[] = [];
  googleTraits: GoogleActionTrait[] = [];
  currentBlueprint: PinSlot[] = [];
  compatibleTraitNames: string[] = [];

  // Compatible traits per implementation type (mirrors firmware supportedTraits())
  private readonly COMPATIBLE_TRAITS: Record<string, string[]> = {
    OutletAction:              ['action.devices.traits.OnOff', 'action.devices.traits.LockUnlock', 'action.devices.traits.StartStop', 'action.devices.traits.OpenClose'],
    LightDimmerAction:         ['action.devices.traits.OnOff', 'action.devices.traits.Brightness'],
    OneDirectionalMotorAction: ['action.devices.traits.OnOff', 'action.devices.traits.FanSpeed', 'action.devices.traits.StartStop'],
    TemperatureAction:         ['action.devices.traits.TemperatureSetting', 'action.devices.traits.HumiditySetting'],
    WaterLevelAction:          ['action.devices.traits.WaterLevel'],
    PhLevelAction:             ['action.devices.traits.PhLevel'],
    TdsLevelAction:            ['action.devices.traits.TdsLevel'],
    HumidityAction:            ['action.devices.traits.HumiditySetting'],
    AirTemperatureAction:      ['action.devices.traits.TemperatureSetting'],
    CO2LevelAction:            ['action.devices.traits.CO2Level'],
    TakePictureAction:         ['action.devices.traits.CameraStream'],
    LiveStreamAction:          ['action.devices.traits.CameraStream'],
  };

  mqttNameUserEdited = false;

  pinForm: FormGroup = this.fb.group({});

  form = this.fb.group({
    action_key:            [this.data?.action_key ?? '', Validators.required],
    mqtt_name:             [this.data?.mqtt_name ?? '', [Validators.required, Validators.pattern(/^[a-z0-9_]+$/)]],
    mqtt_type:             [{ value: this.data?.mqtt_type ?? 'command', disabled: true }],
    capability:            [this.data?.capability ?? '', Validators.required],
    telemetry_interval_ms: [this.data?.telemetry_interval_ms ?? null, [Validators.min(0), Validators.max(3_600_000)]],
    google_action_type_id: [this.data?.google_action_type_id ?? null, Validators.required],
    trait_ids:             [([] as number[])],
  });

  ngOnInit() {
    this.typesService.getGoogleActionTypes().subscribe(t => {
      this.googleTypes = t;
    });
    this.traitsService.getGoogleActionTraits().subscribe(t => {
      this.googleTraits = t;
      this.updateCompatibleTraits(this.data?.capability ?? '');
    });

    const initType = this.data?.capability ?? '';
    this.rebuildPinForm(initType);

    if (!this.data) {
      this.subs.add(
        this.form.get('action_key')!.valueChanges.subscribe(name => {
          if (this.mqttNameUserEdited) return;
          const derived = (name ?? '').toLowerCase().replace(/\s+/g, '_').replace(/[^a-z0-9_]/g, '');
          this.form.get('mqtt_name')!.setValue(derived, { emitEvent: false });
        })
      );
    }

    this.subs.add(
      this.form.get('capability')!.valueChanges.subscribe(implType => {
        this.rebuildPinForm(implType ?? '');
        const entry = this.implTypes.find(t => t.value === implType);
        this.form.get('mqtt_type')!.setValue(entry?.actionType ?? 'command');
        this.updateCompatibleTraits(implType ?? '');
      })
    );
  }

  ngOnDestroy() { this.subs.unsubscribe(); }

  private rebuildPinForm(implType: string) {
    const slots = PIN_BLUEPRINTS[implType] ?? [];
    this.currentBlueprint = slots;
    const controls: Record<string, any> = {};
    slots.forEach((slot, i) => {
      const existing = (this.data?.pins as any)?.[i]?.pinNumber ?? null;
      controls[slot.key] = [existing, [Validators.required, Validators.min(1), Validators.max(48), pinInUseValidator(this.dialogData.usedPins)]];
    });
    this.pinForm = this.fb.group(controls, { validators: slots.length > 1 ? noDuplicatePinsValidator : [] });
  }

  private updateCompatibleTraits(implType: string) {
    const compatible = this.COMPATIBLE_TRAITS[implType] ?? [];
    this.compatibleTraitNames = this.googleTraits
      .filter(t => compatible.includes((t as any).key ?? (t as any).value))
      .map(t => t.name);
  }

  onMqttNameInput() { this.mqttNameUserEdited = true; }

  isFormValid(): boolean {
    return this.form.valid && this.pinForm.valid;
  }

  save() {
    if (!this.isFormValid()) return;
    const v = this.form.getRawValue();
    const pins = this.currentBlueprint.map(slot => ({
      pinNumber: Number(this.pinForm.value[slot.key]),
      pinMode: slot.mode,
    }));
    const result = {
      action_key:            v.action_key!,
      capability:            v.capability!,
      mqtt_name:             v.mqtt_name!,
      mqtt_type:             v.mqtt_type!,
      pins,
      telemetry_interval_ms: v.telemetry_interval_ms ?? null,
      google_action_type_id: v.google_action_type_id ?? null,
      trait_ids:             v.trait_ids ?? [],
    };
    this.dialogRef.close(result);
  }
}
