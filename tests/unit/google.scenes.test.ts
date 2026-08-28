// Unit: scenes over Google Home (F7.12) — google-home's SYNC/EXECUTE handling of a scene.
//
// Two things here are worth protecting with a test rather than a comment.
//
// (1) **The id namespace.** Google addresses everything by one opaque device id, and until this
// feature that id was always a `user_device_actions.id`. Scenes are a separate autoincrement, so
// without a prefix scene 12 and action 12 arrive as the same `"12"` and EXECUTE commands whichever
// it finds first — a voice command that silently operates the wrong hardware.
//
// (2) **That google-home delegates.** The value of routing a scene through @lattice/scenes is that
// the lifecycle/phase gates and the `@param.` resolution are the same code the dashboard tile runs.
// A future refactor that "simplifies" this into a local fan-out would still pass an end-to-end
// smoke test on a hand-written scene and quietly break every derived one, so the assertion is
// specifically that the shared executor is what gets called.

import {
  parseGoogleDeviceId,
  sceneDeviceId,
  actionDeviceId,
} from '../../services/google-home/src/services/google-smart-home/google.device-id';

jest.mock('@lattice/prisma-client', () => ({
  db: { scene: { findMany: jest.fn() } },
}));
jest.mock('@lattice/scenes', () => ({ executeScene: jest.fn() }));
jest.mock('../../services/google-home/src/services/device.actions.service', () => ({
  deviceActionsService: { getUserActions: jest.fn() },
}));
jest.mock('../../services/google-home/src/services/command.dispatch', () => ({
  dispatchAction: jest.fn(async () => undefined),
}));

import { db } from '@lattice/prisma-client';
import { executeScene } from '@lattice/scenes';
import { googleSyncDevicesService } from '../../services/google-home/src/services/google-smart-home/google.sync.device.service';
import { googleExecuteDeviceService } from '../../services/google-home/src/services/google-smart-home/google.execute.device';
import { deviceActionsService } from '../../services/google-home/src/services/device.actions.service';
import { dispatchAction } from '../../services/google-home/src/services/command.dispatch';

const findScenes = db.scene.findMany as jest.Mock;
const runScene = executeScene as jest.Mock;
const getUserActions = deviceActionsService.getUserActions as jest.Mock;
const dispatch = dispatchAction as jest.Mock;

const ACTIVATE = 'action.devices.commands.ActivateScene';
const ch = {} as never;

// The one action shape EXECUTE needs: an outlet that accepts on/off.
const outletAction = {
  id: 12,
  name: 'Pump',
  implementation_type: 'OutletAction',
  googleTraits: [],
  validParameters: undefined,
};

beforeEach(() => {
  jest.clearAllMocks();
  findScenes.mockResolvedValue([]);
  getUserActions.mockResolvedValue([]);
  runScene.mockResolvedValue({ queued: 2 });
});

describe('google device ids', () => {
  it('round-trips both kinds', () => {
    expect(parseGoogleDeviceId(sceneDeviceId(12))).toEqual({ kind: 'scene', id: 12 });
    expect(parseGoogleDeviceId(actionDeviceId(12))).toEqual({ kind: 'action', id: 12 });
  });

  it('keeps scene 12 and action 12 apart', () => {
    expect(sceneDeviceId(12)).not.toBe(actionDeviceId(12));
  });

  it('leaves an action id in its original wire format, so a linked account keeps working', () => {
    expect(actionDeviceId(12)).toBe('12');
  });

  it('rejects ids that are not ours instead of coercing them', () => {
    // parseInt would read each of these as a number: 12, NaN, 12, 0.
    expect(parseGoogleDeviceId('12abc')).toBeNull();
    expect(parseGoogleDeviceId('scene:')).toBeNull();
    expect(parseGoogleDeviceId('scene:12abc')).toBeNull();
    expect(parseGoogleDeviceId('')).toBeNull();
    expect(parseGoogleDeviceId('scene:0')).toBeNull();
  });
});

describe('SYNC', () => {
  it('emits a scene as a SCENE device with a namespaced id', async () => {
    findScenes.mockResolvedValue([{ id: 3, name: 'Evening' }]);

    const [scene] = await googleSyncDevicesService.SyncUserDevices(7);

    expect(scene).toEqual({
      id: 'scene:3',
      type: 'action.devices.types.SCENE',
      traits: ['action.devices.traits.Scene'],
      name: { name: 'Evening', defaultNames: [], nicknames: [] },
      willReportState: false,
      attributes: { sceneReversible: false },
    });
  });

  it('offers a scene that cannot run right now, because SYNC is cached and phases move', async () => {
    // Nothing in the platform calls requestSync, so a scene filtered out here would stay missing
    // from the user's home long after its setup started or its phase came round. The gate answers
    // at EXECUTE instead, where it can say why.
    findScenes.mockResolvedValue([{ id: 3, name: 'Harvest' }]);

    const devices = await googleSyncDevicesService.SyncUserDevices(7);

    expect(findScenes).toHaveBeenCalledWith(
      expect.objectContaining({ where: { user_id: 7 } }), // no lifecycle/phase filter
    );
    expect(devices).toHaveLength(1);
  });
});

describe('EXECUTE', () => {
  const activate = (ids: string[]) => [
    { devices: ids.map((id) => ({ id })), execution: [{ command: ACTIVATE, params: {} }] },
  ];

  it('runs the scene through the shared executor, not a local fan-out', async () => {
    const responses = await googleExecuteDeviceService.ExecuteDeviceCommands(
      ch,
      7,
      activate(['scene:3']),
    );

    expect(runScene).toHaveBeenCalledWith(ch, 7, 3);
    expect(responses).toEqual([{ ids: ['scene:3'], status: 'SUCCESS', states: { online: true } }]);
  });

  it('separates a scene from an action carrying the same number', async () => {
    getUserActions.mockResolvedValue([outletAction]);

    await googleExecuteDeviceService.ExecuteDeviceCommands(ch, 7, [
      {
        devices: [{ id: 'scene:12' }, { id: '12' }],
        execution: [{ command: 'action.devices.commands.OnOff', params: { on: true } }],
      },
    ]);

    // The action was commanded; the scene was not touched by the OnOff path.
    expect(dispatch).toHaveBeenCalledWith(ch, 7, 12, 'on');
    expect(runScene).not.toHaveBeenCalled();
  });

  it('reports a gated scene as an error rather than claiming success', async () => {
    // What scenesService throws when the setup is stopped or out of phase.
    runScene.mockRejectedValue(Object.assign(new Error('not in phase'), { statusCode: 409 }));

    const responses = await googleExecuteDeviceService.ExecuteDeviceCommands(
      ch,
      7,
      activate(['scene:3']),
    );

    expect(responses).toEqual([{ ids: ['scene:3'], status: 'ERROR', errorCode: 'notSupported' }]);
  });

  it('reports a scene owned by someone else as deviceNotFound', async () => {
    runScene.mockRejectedValue(Object.assign(new Error('Forbidden'), { statusCode: 403 }));

    const [response] = await googleExecuteDeviceService.ExecuteDeviceCommands(
      ch,
      7,
      activate(['scene:3']),
    );

    expect(response).toMatchObject({ status: 'ERROR', errorCode: 'deviceNotFound' });
  });

  it('does not call a scene that dispatched nothing a success', async () => {
    // Every member was an unresolvable `@param.` reference — the executor drops those rather than
    // sending raw text, so nothing reached a device.
    runScene.mockResolvedValue({ queued: 0 });

    const [response] = await googleExecuteDeviceService.ExecuteDeviceCommands(
      ch,
      7,
      activate(['scene:3']),
    );

    expect(response).toMatchObject({ status: 'ERROR' });
  });

  it('refuses to deactivate a scene, which has no stored "before" to restore', async () => {
    const [response] = await googleExecuteDeviceService.ExecuteDeviceCommands(ch, 7, [
      {
        devices: [{ id: 'scene:3' }],
        execution: [{ command: ACTIVATE, params: { deactivate: true } }],
      },
    ]);

    expect(runScene).not.toHaveBeenCalled();
    expect(response).toMatchObject({ status: 'ERROR', errorCode: 'notSupported' });
  });

  it('answers an unknown id instead of coercing it into an action id', async () => {
    const [response] = await googleExecuteDeviceService.ExecuteDeviceCommands(
      ch,
      7,
      activate(['scene:nope']),
    );

    expect(response).toEqual({
      ids: ['scene:nope'],
      status: 'ERROR',
      errorCode: 'deviceNotFound',
    });
  });
});
