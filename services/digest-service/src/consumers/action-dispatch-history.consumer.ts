import type { ActionDispatchPayload } from '@lattice/queue';
import { recordDispatch } from '../command-history';

// A second consumer of action.dispatch, alongside mqtt-service's publisher.
//
// Dispatch is the one point every command passes through — the dashboard's, a rule's, a scene's, a
// pipeline's — so recording here catches all of them without each publisher having to remember to,
// and without changing the paths that bypass digest's request side (automation-worker publishes
// action.dispatch directly). mqtt-service has no database, which is why the recorder lives here
// rather than beside the MQTT publish.
export function actionDispatchHistoryConsumer() {
  return async (payload: ActionDispatchPayload): Promise<void> => {
    await recordDispatch(payload);
  };
}
