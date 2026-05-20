import { google } from 'googleapis';
import path from 'path';
import config from '../config/env.config';
import { googleStateService } from './google.state.service';
import { DeviceActionView } from './device.actions.service';

class GoogleHomegraphService {
    private homegraph = undefined;

    constructor() {
        try {
            // Temporarily disabled until infrastructure is ready
            /* 
            const auth = new google.auth.GoogleAuth({
                scopes: ['https://www.googleapis.com/auth/homegraph'],
            });

            this.homegraph = google.homegraph({
                version: 'v1',
                auth: auth,
            });
            */
        } catch (error) {
            console.error("Failed to initialize GoogleHomegraphService. Check your service account configuration.", error);
        }
    }

    async reportState(agentUserId: string, action: DeviceActionView) {
        // Temporarily disabled
        return;
        
      
        if (!this.homegraph) {
            console.error("GoogleHomegraphService not initialized. Cannot report state.");
            return;
        }

        /*  const state = googleStateService.buildState(action);

        // Don't report if there's nothing to report besides online status, unless it just went offline.
        if (Object.keys(state).length <= 1 && state.online) {
            return;
        }

        const requestBody = {
            requestId: Math.random().toString(36).substring(2, 15), // A unique request ID
            agentUserId: agentUserId,
            payload: {
                devices: {
                    states: {
                        [action.id.toString()]: state,
                    },
                },
            },
        };

        try {
            console.log(`Reporting state for user ${agentUserId}, action ${action.id}:`, JSON.stringify(requestBody, null, 2));
            const res = await this.homegraph.devices.reportStateAndNotification({ requestBody });
            console.log('Report state response:', res.data);
        } catch (error: any) {
            console.error('Error reporting state to Google Homegraph:', error.message, error.response?.data?.error);
        }
        */
    }
}

export const googleHomegraphService = new GoogleHomegraphService();