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
  for (let i = 0; i < existingPins.length; i++) {
    if (existingPins[i].key !== newPins[i].key) {
      return {
        compatible: false,
        reason: `pin slot "${existingPins[i].key}" renamed to "${newPins[i].key}"`,
      };
    }
  }
  return { compatible: true };
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
