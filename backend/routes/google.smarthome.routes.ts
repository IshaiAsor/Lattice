import { smarthome } from "actions-on-google";
import express, { Request, Response, NextFunction } from 'express';
import { verifyToken } from "../middlewares/auth.middleware";
import { deviceActionsService } from "../services/device.actions.service";
import { JwtPurpose } from "../services/jwt.service";
import socketActionsService from "../services/socket.actions.service";
import { googleStateService } from "../services/google.state.service";

const router = express.Router();
const appSmarthome = smarthome();
appSmarthome.onSync(async (body: any, headers: any, frameworkData: any) => {
  const userId = frameworkData.express.request.user.id;
  console.log('Received sync request:', body);

  const actions = await deviceActionsService.getUserActions(userId);

  const syncDevices = actions.map((d) => (
    {
      id: d.id.toString(),
      type: d.googleType?.value || '',
      traits: d.googleTraits.map((t) => t.value),
      name: { name: d.name, defaultNames: [], nicknames: [] },
      willReportState: d.googleType?.value == 'action.devices.types.SENSOR',
      attributes: d.googleType?.value == 'action.devices.types.SENSOR' ? {
        "queryOnlyTemperatureSetting": true,
        "thermostatTemperatureUnit": "C"
      } : undefined
    }));

  console.log('Sync response devices:', syncDevices);
  return {
    requestId: body.requestId,
    payload: { agentUserId: userId, devices: syncDevices },
  };
});

appSmarthome.onQuery(async (body: any, headers: any, frameworkData: any) => {
  const userId = frameworkData.express.request.user.id;
  console.log('Received query request:', body);
  const queryDevices: Record<string, any> = {};

  const actions = await deviceActionsService.getUserActions(userId);
  actions.forEach((action) => queryDevices[action.id.toString()] = googleStateService.buildState(action));

  console.log('Query response devices:', queryDevices);
  return { requestId: body.requestId, payload: { devices: queryDevices } };
});

appSmarthome.onExecute(async (body: any, headers: any, frameworkData: any) => {
  const userId = frameworkData.express.request.user.id;
  const actions = await deviceActionsService.getUserActions(userId);

  console.log('Received execute request:', body);

  const command = body.inputs[0].payload.commands[0];
  const execution = command.execution[0];
  const isTurnedOn = execution.params.on ? 'on' : 'off';

  const successfulIds: string[] = [];

  for (const action of command.devices) {
    try {
      let userAction = actions.find((a) => a.id === parseInt(action.id));
      if (!userAction) {
        console.error(`Action ${action.id} not found for user ${userId}`);
        continue;
      }

      console.log(`Executing on ${action.id}`);
      socketActionsService.handleActionUpdate(userId, userAction.id, isTurnedOn);
      successfulIds.push(action.id);
    } catch (err) {
      console.error(`Failed to execute on ${action.id}`);
    }
  }

  return {
    requestId: body.requestId,
    payload: {
      commands: [
        {
          ids: successfulIds,
          status: 'SUCCESS',
          states: { on: isTurnedOn, online: true },
        },
      ],
    },
  };
});

router.post('/', verifyToken(JwtPurpose.google_cloud_to_cloud_login), appSmarthome);

export default router;
