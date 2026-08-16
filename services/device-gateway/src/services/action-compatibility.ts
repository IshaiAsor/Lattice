// Pure action-migration compatibility + pin-mapping logic — extracted from
// action-migration.service.ts so it's unit-testable (tests/unit/action-compatibility.test.ts)
// without pulling in DB/queue.

export interface PinSlot {
  key: string;
}

export interface ActionPreview {
  // null for an action the new template adds — there is no user_device_action row for it yet.
  id: number | null;
  name: string;
  mqttName: string;
  status: 'ok' | 'new' | 'deprecated';
  reason?: string;
}

export interface SealedTemplateEntry {
  capability_key: string;
  mqtt_action_name: string;
  action_label: string;
  sort_order: number;
}

export interface ExistingAction {
  id: number;
  action_name: string;
  mqtt_action_name: string;
}

/**
 * What a sealed device's update will actually do (F3.18).
 *
 * A sealed device does not name-match user actions across versions the way a self-configured one
 * does — its config IS the admin template for the target version. Running the generic capability
 * diff over it compares template-materialized actions against the target's raw catalog
 * capabilities, trips `isCompatible` on the first check, and reports "implementation type changed"
 * for *every* action: all 8 channels of MULTI_SOCKET_8_CH flagged at once under a deprecation
 * warning, describing a code path `applyUpdate` never takes (it short-circuits to
 * `stageSealedUpgrade`, which stages the template cleanly and deprecates nothing).
 *
 * So this mirrors the apply path instead of second-guessing it:
 *   - `stageSealedUpgrade` skips an entry whose capability the target version does not carry
 *     (`if (!cap) continue`), so `targetCapabilityKeys` filters those out here too;
 *   - `confirmOtaIfPending` re-identifies actions across the version by `mqtt_action_name`, so an
 *     entry matching an existing action is *carried* (keeps its row, name and grouping) rather
 *     than replaced — which is the difference between "ok" and a scary "deprecated";
 *   - an existing action with no entry in the new template is the one case that really is going
 *     away, and is the only thing that should raise a warning.
 */
export function diffSealedTemplate(
  entries: SealedTemplateEntry[],
  existing: ExistingAction[],
  targetCapabilityKeys: Set<string>,
): ActionPreview[] {
  const staged = entries
    .filter((e) => targetCapabilityKeys.has(e.capability_key))
    .sort((a, b) => a.sort_order - b.sort_order);
  const stagedNames = new Set(staged.map((e) => e.mqtt_action_name));

  // Lowest id wins per name, matching confirmOtaIfPending's `orderBy: { id: 'asc' }` survivor
  // pick. Sorted here rather than trusting the caller: naming a different row than the one the
  // confirm path keeps would report a rename that never happens — the same class of lie F3.18 is
  // about.
  const existingByName = new Map<string, ExistingAction>();
  for (const a of [...existing].sort((x, y) => x.id - y.id)) {
    if (!existingByName.has(a.mqtt_action_name)) existingByName.set(a.mqtt_action_name, a);
  }

  const preview: ActionPreview[] = staged.map((entry) => {
    const survivor = existingByName.get(entry.mqtt_action_name);
    return survivor
      ? {
          id: survivor.id,
          name: survivor.action_name,
          mqttName: entry.mqtt_action_name,
          status: 'ok' as const,
        }
      : {
          id: null,
          // No row yet, so the template's label is the only name this action has.
          name: entry.action_label,
          mqttName: entry.mqtt_action_name,
          status: 'new' as const,
          reason: 'added in this version',
        };
  });

  for (const a of existing) {
    if (stagedNames.has(a.mqtt_action_name)) continue;
    preview.push({
      id: a.id,
      name: a.action_name,
      mqttName: a.mqtt_action_name,
      status: 'deprecated',
      reason: 'not in the new template',
    });
  }

  return preview;
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
