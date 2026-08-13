import { CapabilityView, PinSlot } from 'src/app/services/device.mgmt.service';

/**
 * The per-capability inputs a user fills in before a capability becomes a real action: which GPIO
 * goes in each declared pin slot, how often a sensor reads, and (cameras only) resolution and
 * transport.
 *
 * Shared by the device-config page and the first-run setup sheet. Those two have different
 * *interactions* — expand-one-and-add vs. tick-many-and-apply — but identical fields and identical
 * rules about when they are complete, so the fields and the validation live here rather than being
 * written twice and drifting.
 */
export interface CapabilityFieldValues {
  /** GPIO number per capability pin slot id. */
  pins: Record<number, number | null>;
  intervalMs: number | null;
  resolution: string | null;
  transport: string | null;
}

export const CAMERA_RESOLUTION_OPTIONS = [
  { value: 'QQVGA', label: 'QQVGA (160x120)' },
  { value: 'QVGA', label: 'QVGA (320x240)' },
  { value: 'VGA', label: 'VGA (640x480)' },
  { value: 'SVGA', label: 'SVGA (800x600)' },
  { value: 'XGA', label: 'XGA (1024x768)' },
  { value: 'HD', label: 'HD (1280x720)' },
  { value: 'SXGA', label: 'SXGA (1280x1024)' },
  { value: 'UXGA', label: 'UXGA (1600x1200)' },
  { value: 'FHD', label: 'FHD (1920x1080)' },
  { value: 'QXGA', label: 'QXGA (2048x1536)' },
  { value: 'QHD', label: 'QHD (2560x1440)' },
  { value: 'WQXGA', label: 'WQXGA (2560x1600)' },
  { value: 'QSXGA', label: 'QSXGA (2560x1920)' },
];

export const CAMERA_TRANSPORT_OPTIONS = [
  { value: 'http', label: 'HTTP' },
  { value: 'ws', label: 'WebSocket' },
];

export function isCameraCapability(cap: CapabilityView): boolean {
  return cap.implementation_type === 'CameraAction';
}

export function pinSlots(cap: CapabilityView): PinSlot[] {
  return cap.configurable_pins ?? [];
}

export function isTelemetry(cap: CapabilityView): boolean {
  return cap.mqtt_action_type === 'telemetry';
}

/**
 * Starting values for a capability the user has not touched.
 *
 * Pin slots start empty: the catalog describes a slot's role and mode, not which GPIO the board
 * actually wires it to, so there is nothing to prefill and no way to guess. The interval does have
 * a catalog-supplied floor, so it starts there.
 */
export function defaultFieldValues(cap: CapabilityView): CapabilityFieldValues {
  const pins: Record<number, number | null> = {};
  for (const slot of pinSlots(cap)) {
    pins[slot.id] = null;
  }
  const camera = isCameraCapability(cap);
  return {
    pins,
    intervalMs: cap.min_telemetry_interval_ms ?? null,
    resolution: camera ? 'SVGA' : null,
    transport: camera ? 'http' : null,
  };
}

/**
 * Whether these values can be submitted.
 *
 * `requireInterval` exists because the two callers disagree, correctly: adding a telemetry
 * capability always sets an interval, while editing an existing action only needs one when the
 * `interval` behavior is actually switched on.
 */
export function fieldsValid(
  cap: CapabilityView,
  values: CapabilityFieldValues,
  opts: { requireInterval?: boolean } = {},
): boolean {
  const requireInterval = opts.requireInterval ?? isTelemetry(cap);

  const allPinsFilled = pinSlots(cap).every((s) => {
    const v = values.pins[s.id];
    return v != null && v > 0;
  });

  const intervalOk =
    !requireInterval ||
    (values.intervalMs != null && values.intervalMs >= (cap.min_telemetry_interval_ms ?? 0));

  const cameraOk = !isCameraCapability(cap) || (!!values.resolution && !!values.transport);

  return allPinsFilled && intervalOk && cameraOk;
}

/** Field values → the `pins` array the activate/update endpoints expect. */
export function toPinInputs(
  cap: CapabilityView,
  values: CapabilityFieldValues,
): { capability_pin_id: number; pin_number: number }[] {
  return pinSlots(cap).map((slot) => ({
    capability_pin_id: slot.id,
    pin_number: values.pins[slot.id] as number,
  }));
}

/** Field values → the body shape shared by activateCapability and the setup-apply selections. */
export function toActivationBody(cap: CapabilityView, values: CapabilityFieldValues) {
  const camera = isCameraCapability(cap);
  return {
    capability_id: cap.id,
    telemetry_interval_ms: isTelemetry(cap) ? values.intervalMs : null,
    pins: toPinInputs(cap, values),
    camera_resolution: camera ? values.resolution : null,
    camera_transport: camera ? values.transport : null,
  };
}

export function resolutionLabel(value: string | null | undefined): string | null {
  if (!value) return null;
  return CAMERA_RESOLUTION_OPTIONS.find((r) => r.value === value)?.label ?? value;
}
