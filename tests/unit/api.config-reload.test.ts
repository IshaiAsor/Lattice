// Unit: the config-reload debouncer (F3.11) — api/src/services/config-reload.ts.
//
// Regression context: a device-facing config write used to be followed by a *client*-issued
// restart, so any non-browser caller left the device running the old config. Moving the reload
// server-side puts it behind every writer at once, and the debounce is what keeps one user edit
// (an action update plus its behaviors, two writes) from costing the device two boot cycles.

import { requestConfigReload } from '../../services/api/src/services/config-reload';
import { dispatchDeviceCommand } from '../../services/api/src/services/device-command.dispatch';

jest.mock('../../services/api/src/services/device-command.dispatch', () => ({
  dispatchDeviceCommand: jest.fn(async () => undefined),
}));

const dispatch = dispatchDeviceCommand as jest.MockedFunction<typeof dispatchDeviceCommand>;

describe('requestConfigReload', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    dispatch.mockClear();
    dispatch.mockResolvedValue(undefined);
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('reloads the device with restart, never reprovision', () => {
    requestConfigReload(7, 42);
    jest.runAllTimers();

    // reprovision is aliased to soft-reset in firmware and wipes credentials, which drops real
    // hardware into BLE provisioning mode — the single most important thing this must not do.
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(dispatch).toHaveBeenCalledWith(7, 42, 'restart');
  });

  it('collapses the writes of one edit into a single restart', () => {
    // What the device-config editor actually does: update the action, then save its behaviors.
    requestConfigReload(7, 42);
    requestConfigReload(7, 42);
    requestConfigReload(7, 42);
    jest.runAllTimers();

    expect(dispatch).toHaveBeenCalledTimes(1);
  });

  it('dispatches after the last write, not the first', () => {
    // Trailing edge on purpose: a leading dispatch would race the device's config fetch against a
    // write still in flight, and the device would come back up on config it read a moment early.
    requestConfigReload(7, 42);
    jest.advanceTimersByTime(1_000);
    expect(dispatch).not.toHaveBeenCalled();

    requestConfigReload(7, 42);
    jest.advanceTimersByTime(1_000);
    expect(dispatch).not.toHaveBeenCalled();

    jest.advanceTimersByTime(500);
    expect(dispatch).toHaveBeenCalledTimes(1);
  });

  it('debounces per device, so one device never swallows another reload', () => {
    requestConfigReload(7, 42);
    requestConfigReload(7, 43);
    jest.runAllTimers();

    expect(dispatch).toHaveBeenCalledTimes(2);
    expect(dispatch).toHaveBeenCalledWith(7, 42, 'restart');
    expect(dispatch).toHaveBeenCalledWith(7, 43, 'restart');
  });

  it('reloads again after the previous one has fired', () => {
    requestConfigReload(7, 42);
    jest.runAllTimers();
    requestConfigReload(7, 42);
    jest.runAllTimers();

    expect(dispatch).toHaveBeenCalledTimes(2);
  });

  it('swallows a failed dispatch — the config write has already committed', async () => {
    dispatch.mockRejectedValueOnce(new Error('device offline'));
    requestConfigReload(7, 42);

    expect(() => jest.runAllTimers()).not.toThrow();
    await Promise.resolve(); // let the rejection settle; an unhandled one would fail the run
    expect(dispatch).toHaveBeenCalledTimes(1);
  });
});
