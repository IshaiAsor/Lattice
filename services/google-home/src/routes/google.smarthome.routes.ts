import { smarthome } from 'actions-on-google';
import express from 'express';
import { Channel } from 'amqplib';
import { verifyToken } from '../middlewares/auth.middleware';
import { JwtPurpose } from '@lattice/jwt';
import { deviceActionsService } from '../services/device.actions.service';
import { googleStateService } from '../services/google-smart-home/google.state.service';
import { googleSyncDevicesService } from '../services/google-smart-home/google.sync.device.service';
import { googleExecuteDeviceService } from '../services/google-smart-home/google.execute.device';

export function createSmarthomeRouter(ch: Channel) {
  const router = express.Router();
  const appSmarthome = smarthome();

  appSmarthome.onSync(async (body: any, _headers: any, frameworkData: any) => {
    const userId = frameworkData.express.request.user.id;
    const syncDevices = await googleSyncDevicesService.SyncUserDevices(parseInt(userId));
    return {
      requestId: body.requestId,
      payload: { agentUserId: userId, devices: syncDevices },
    };
  });

  appSmarthome.onQuery(async (body: any, _headers: any, frameworkData: any) => {
    const userId = frameworkData.express.request.user.id;
    const actions = await deviceActionsService.getUserActions(parseInt(userId), '');
    const queryDevices: Record<string, any> = {};
    actions.forEach((action) => {
      queryDevices[action.id.toString()] = googleStateService.buildState(action);
    });
    return { requestId: body.requestId, payload: { devices: queryDevices } };
  });

  appSmarthome.onExecute(async (body: any, _headers: any, frameworkData: any) => {
    const userId = frameworkData.express.request.user.id;
    const commands = body.inputs[0].payload.commands;
    return {
      requestId: body.requestId,
      payload: {
        commands: await googleExecuteDeviceService.ExecuteDeviceCommands(
          ch,
          parseInt(userId),
          commands,
        ),
      },
    };
  });

  router.post('/', verifyToken(JwtPurpose.google_cloud_to_cloud_login), appSmarthome);
  return router;
}
