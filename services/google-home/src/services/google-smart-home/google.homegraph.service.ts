import { google } from 'googleapis';
import { createLogger } from '@lattice/logger';
import config from '../../config/env.config';
import { DeviceActionView } from '../device.actions.service';
import { googleStateService } from './google.state.service';

const log = createLogger('google-home:homegraph');

class GoogleHomegraphService {
  private homegraph: ReturnType<typeof google.homegraph> | undefined;

  constructor() {
    try {
      let credentials: object | undefined;
      if (config.google.serviceAccountKey) {
        try {
          credentials = JSON.parse(config.google.serviceAccountKey);
        } catch {
          log.warn('GOOGLE_SERVICE_ACCOUNT_KEY is not valid JSON — ignored');
        }
      }

      const keyFilename = process.env['GOOGLE_APPLICATION_CREDENTIALS'];
      const authConfig: Record<string, unknown> = {
        scopes: ['https://www.googleapis.com/auth/homegraph'],
      };
      if (credentials) {
        authConfig['credentials'] = credentials;
      } else if (keyFilename) {
        authConfig['keyFilename'] = keyFilename;
      }

      const auth = new google.auth.GoogleAuth(authConfig);

      this.homegraph = google.homegraph({ version: 'v1', auth: auth as any });
      log.info(
        { source: credentials ? 'env key' : keyFilename ? 'key file' : 'ADC' },
        'initialized',
      );
    } catch (error) {
      log.error({ err: error }, 'failed to initialize — check service account config');
    }
  }

  async reportState(agentUserId: string, action: DeviceActionView): Promise<void> {
    if (!this.homegraph) {
      log.error('not initialized, skipping reportState');
      return;
    }

    const state = googleStateService.buildState(action);
    if (Object.keys(state).length <= 1 && state.online) return;

    const requestBody = {
      requestId: Math.random().toString(36).substring(2, 15),
      agentUserId,
      payload: {
        devices: {
          states: { [action.id.toString()]: state },
        },
      },
    };

    try {
      const res = await this.homegraph.devices.reportStateAndNotification({ requestBody });
      log.info({ agentUserId, actionId: action.id, data: res.data }, 'reportState succeeded');
    } catch (error: any) {
      log.error(
        {
          agentUserId,
          actionId: action.id,
          err: error.message,
          googleErr: error.response?.data?.error,
        },
        'reportState failed',
      );
    }
  }
}

export const googleHomegraphService = new GoogleHomegraphService();
