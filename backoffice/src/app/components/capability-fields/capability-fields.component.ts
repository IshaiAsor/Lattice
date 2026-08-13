import { Component, Input, Output, EventEmitter } from '@angular/core';
import { SHARED_MATERIAL } from 'src/app/shared-ui';
import { CapabilityView } from 'src/app/services/device.mgmt.service';
import {
  CapabilityFieldValues,
  CAMERA_RESOLUTION_OPTIONS,
  CAMERA_TRANSPORT_OPTIONS,
  isCameraCapability,
  isTelemetry,
  pinSlots,
} from './capability-fields';

/**
 * The pin / interval / camera inputs for one capability.
 *
 * Presentational: it mutates the `values` object it is handed and reports that something changed.
 * The owner decides what a change means — device-config enables its Confirm button, the setup
 * sheet re-checks whether the whole sheet can be applied.
 */
@Component({
  selector: 'app-capability-fields',
  imports: [SHARED_MATERIAL],
  templateUrl: './capability-fields.component.html',
  styleUrls: ['./capability-fields.component.css'],
})
export class CapabilityFieldsComponent {
  @Input({ required: true }) cap!: CapabilityView;
  @Input({ required: true }) values!: CapabilityFieldValues;
  /** Hide the interval field when the capability's `interval` behavior is switched off. */
  @Input() showInterval: boolean | null = null;
  @Input() disabled = false;
  @Output() valuesChange = new EventEmitter<CapabilityFieldValues>();

  readonly resolutionOptions = CAMERA_RESOLUTION_OPTIONS;
  readonly transportOptions = CAMERA_TRANSPORT_OPTIONS;

  get slots() {
    return pinSlots(this.cap);
  }
  get isCamera() {
    return isCameraCapability(this.cap);
  }
  get intervalVisible() {
    return this.showInterval ?? isTelemetry(this.cap);
  }

  changed(): void {
    this.valuesChange.emit(this.values);
  }
}
