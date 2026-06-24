export const CHAT_CHANNELS = {
  CHAT_REQUEST:  'chat:request',   // Socket.IO event: client → server
  CHAT_INTENT:   'chat:intent',    // Redis pub/sub: edge (socket-server) → orchestrator (no model)
  CHAT_RESPONSE: 'chat:response:', // Redis pub/sub prefix: orchestrator → socket-server (append requestId)
  CHAT_TOKEN:    'chat:token',     // Socket.IO event: server → client (streaming chunk)
  CHAT_DONE:     'chat:done',      // Socket.IO event: server → client (stream complete)
  CHAT_ERROR:    'chat:error',     // Socket.IO event: server → client (error)
} as const;

export const SOCKET_EVENTS = {
  ACTION_STATE_UPDATE:  'action_state_update',
  ACTION_STATE_PENDING: 'action_state_pending',
  ACTION_STATE_FAILED:  'action_state_failed',
  DEVICE_STATUS_CHANGE: 'device_status_change',
} as const;

export const INFER_CHANNELS = {
  INFER_JOBS:     'infer:jobs',      // Redis pub/sub: caller → ml-executor (single-shot)
  INFER_RESPONSE: 'infer:response:', // Redis pub/sub prefix: ml-executor → caller (append requestId)
} as const;

