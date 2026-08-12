// Pure action-migration compatibility + pin-mapping logic — extracted from
// action-migration.service.ts so it's unit-testable (tests/unit/action-compatibility.test.ts)
// without pulling in DB/queue.

export interface PinSlot {
  key: string;
}

export function isCompatible(
  implType: string,
  existingPins: PinSlot[],
  capability: { implementation_type: string; pins: PinSlot[] },
): { compatible: boolean; reason?: string } {
  if (implType !== capability.implementation_type) {
    return { compatible: false, reason: 'implementation type changed' };
  }
  const newPins = capability.pins ?? [];
  if (existingPins.length !== newPins.length) {
    return { compatible: false, reason: 'pin count changed' };
  }

  // Compared as sets, not position by position. A pin slot is identified by its key — which is
  // exactly how migratePins already remaps them — and the catalog rows these arrays come from
  // are loaded with no ORDER BY, so their order is whatever Postgres returns. Two byte-identical
  // capabilities really can arrive in different orders, and a positional compare would then
  // report a pin rename that never happened.
  const newKeys = new Set(newPins.map((p) => p.key));
  const missing = existingPins.map((p) => p.key).filter((k) => !newKeys.has(k));
  if (missing.length === 0) {
    return { compatible: true };
  }

  const existingKeys = new Set(existingPins.map((p) => p.key));
  const added = newPins.map((p) => p.key).filter((k) => !existingKeys.has(k));
  if (missing.length === 1 && added.length === 1) {
    return { compatible: false, reason: `pin slot "${missing[0]}" renamed to "${added[0]}"` };
  }
  return {
    compatible: false,
    reason: `pin slots ${missing.map((k) => `"${k}"`).join(', ')} no longer exist`,
  };
}

// Index a target version's capabilities for cross-version matching.
//
// MUST be keyed by capability_key — the unique identity within a device row
// (@@unique([device_id, capability_key])). mqtt_action_name is NOT unique: i2c_socket_8 and
// i2c_socket_16 both publish as "socket", so a Map keyed on it keeps only whichever was built
// last and silently compares actions against the wrong capability. That is what made an
// 8-channel socket board preview all 8 channels as "implementation type changed" against the
// 16-channel capability, on an upgrade where its own capability was unchanged.
export function indexCapabilitiesByKey<T extends { capability_key: string }>(
  capabilities: T[],
): Map<string, T> {
  return new Map(capabilities.map((c) => [c.capability_key, c]));
}

// Map a user action's configured pins from the old capability's catalog pins to the new
// version's, by pin key: old pin id → key (old catalog) → new pin id (new catalog).
// Pins whose key no longer exists in the new capability are dropped.
export function migratePins(
  oldCatalogPins: Array<{ id: number; key: string }>,
  newCatalogPins: Array<{ id: number; key: string }>,
  actionPins: Array<{ capability_pin_id: number; pin_number: number }>,
): Array<{ capability_pin_id: number; pin_number: number }> {
  const oldPinIdToKey = new Map(oldCatalogPins.map((p) => [p.id, p.key]));
  const newKeyToPinId = new Map(newCatalogPins.map((p) => [p.key, p.id]));
  return actionPins
    .map((p) => {
      const key = oldPinIdToKey.get(p.capability_pin_id);
      const newPinId = key !== undefined ? newKeyToPinId.get(key) : undefined;
      return newPinId !== undefined
        ? { capability_pin_id: newPinId, pin_number: p.pin_number }
        : null;
    })
    .filter((p): p is { capability_pin_id: number; pin_number: number } => p !== null);
}
