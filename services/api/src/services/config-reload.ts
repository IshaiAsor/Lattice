import { createLogger } from '@lattice/logger';
import { dispatchDeviceCommand } from './device-command.dispatch';

const log = createLogger('api:config-reload');

// F3.11 — a device-facing config write reloads the device from the *server*.
//
// The device has no config topic: it subscribes to exactly two topics (command and OTA) and
// re-reads GET /device/configuration on boot. So "apply this config" means restart. It must be
// `restart` and never `reprovision` — firmware aliases reprovision to soft-reset and wipes the
// device's credentials, dropping real hardware into BLE provisioning mode.
//
// Why the server and not the caller: the backoffice used to fire restartDevice() itself after
// each edit, so every *other* API client — the mobile shell, a script, the assistant — wrote
// config and left the device running the old one indefinitely. Those two calls also had no
// transaction between them: if the second failed, the device was silently stranded on stale
// config with the write already committed.
//
// Debounced on the trailing edge, per device. One user edit can be several writes (an action
// update followed by its behaviors), and each restart costs the device a boot cycle. Trailing
// rather than leading so the reload always follows the *last* write — a leading dispatch would
// race the device's config fetch against a write still in flight, and the device would come back
// up on config it fetched a moment too early.
const RELOAD_DEBOUNCE_MS = 1_500;

const pending = new Map<number, NodeJS.Timeout>();

/**
 * Ask a device to reload its configuration. Fire-and-forget by design.
 *
 * Best-effort: an offline device picks the new config up on its next boot regardless, so a
 * failed dispatch must never turn into a failed config write — the write has already committed
 * and is the part the user asked for.
 *
 * In-process, so with several api replicas two edits routed to different pods can still produce
 * two restarts. That is exactly what the old client-driven path did on *every* edit, so this is
 * never worse than what it replaces; a cross-replica lock would need Valkey, which the api does
 * not currently have a client for.
 *
 * Callers must have verified ownership already (all of them resolve the device from an owned
 * action or device first) — this does not re-check, it only dispatches.
 */
export function requestConfigReload(userId: number, deviceId: number): void {
  const existing = pending.get(deviceId);
  if (existing) clearTimeout(existing);

  const timer = setTimeout(() => {
    pending.delete(deviceId);
    void dispatchDeviceCommand(userId, deviceId, 'restart').catch((err: unknown) => {
      log.warn({ err, deviceId }, 'config-reload dispatch failed — device reloads on next boot');
    });
  }, RELOAD_DEBOUNCE_MS);

  // A queued reload must never hold the process open — it is best-effort, and on shutdown the
  // device reloads on its next boot anyway.
  timer.unref();
  pending.set(deviceId, timer);
}
