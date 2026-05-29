import { smarthome } from "actions-on-google";
import express, { Request, Response, NextFunction } from 'express';
import { verifyToken } from "../middlewares/auth.middleware";
import { deviceActionsService } from "../services/device.actions.service";
import { JwtPurpose } from "../services/jwt.service";
import { googleStateService } from "../services/google-smart-home/google.state.service";
import { googleSyncDevicesService } from "../services/google-smart-home/google.sync.device.service";
import { googleExecuteDeviceService } from "../services/google-smart-home/google.execute.device";

const router = express.Router();
const appSmarthome = smarthome();
appSmarthome.onSync(async (body: any, headers: any, frameworkData: any) => {
  console.log('Received sync request:', body , headers, frameworkData);
  const userId = frameworkData.express.request.user.id;
  const syncDevices = await googleSyncDevicesService.SyncUserDevices(parseInt(userId));
  const response = {
    requestId: body.requestId,
    payload: { agentUserId: userId, devices: syncDevices },
  };
  console.log('Sync response devices:', response);
  return response;
});

appSmarthome.onQuery(async (body: any, headers: any, frameworkData: any) => {
  console.log('Received query request:', body, headers, frameworkData);
  const userId = frameworkData.express.request.user.id;
  const queryDevices: Record<string, any> = {};

  const actions = await deviceActionsService.getUserActions(parseInt(userId));
  actions.forEach((action) => queryDevices[action.id.toString()] = googleStateService.buildState(action));

  const response = { requestId: body.requestId, payload: { devices: queryDevices } };
  console.log('Query response devices:', response);
  return response;
});

appSmarthome.onExecute(async (body: any, headers: any, frameworkData: any) => {
  console.log('Received execute request:', body, headers, frameworkData);
  const userId = frameworkData.express.request.user.id;
  const commands = body.inputs[0].payload.commands;
  const response = {
    requestId: body.requestId,
    payload: {
      commands: await googleExecuteDeviceService.ExecuteDeviceCommands(parseInt(userId), commands),
    },
  };
  console.log('Execute response:', response);
  return response;
});

router.post('/', verifyToken(JwtPurpose.google_cloud_to_cloud_login), appSmarthome);

export default router;
