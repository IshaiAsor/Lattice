export const CHAT_CHANNELS = {
  CHAT_REQUEST: 'chat:request', // Socket.IO event: client → server
  CHAT_INTENT: 'chat:intent', // Redis pub/sub: edge (socket-server) → orchestrator (no model)
  CHAT_RESPONSE: 'chat:response:', // Redis pub/sub prefix: orchestrator → socket-server (append requestId)
  CHAT_TOKEN: 'chat:token', // Socket.IO event: server → client (streaming chunk)
  CHAT_DONE: 'chat:done', // Socket.IO event: server → client (stream complete)
  CHAT_ERROR: 'chat:error', // Socket.IO event: server → client (error)
} as const;

export const SOCKET_EVENTS = {
  ACTION_STATE_UPDATE: 'action_state_update',
  ACTION_STATE_PENDING: 'action_state_pending',
  ACTION_STATE_FAILED: 'action_state_failed',
  // A read-back confirmed the stored state was already correct (F23). Carries no state, because
  // nothing changed — only the fact that it was verified, so an open tab's "confirmed Xm ago"
  // keeps telling the truth instead of ageing past a check that did happen.
  ACTION_STATE_CONFIRMED: 'action_state_confirmed',
  DEVICE_STATUS_CHANGE: 'device_status_change',
  // A pending OTA settled — confirmed on the new version, or failed and rolled back. The UI
  // holds the Update control disabled from the moment it dispatches, so this is what releases
  // it; without it a failed update leaves the device looking like it is still updating.
  DEVICE_UPDATE_STATE: 'device_update_state',
  PIPELINE_RUN_UPDATE: 'pipeline_run_update',
  // In-app notification pushed to a user's room by notification-service's in-app channel.
  NOTIFICATION: 'notification',
} as const;

export const INFER_CHANNELS = {
  INFER_JOBS: 'infer:jobs', // Redis pub/sub: caller → ml-executor (single-shot)
  INFER_RESPONSE: 'infer:response:', // Redis pub/sub prefix: ml-executor → caller (append requestId)
} as const;
