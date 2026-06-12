// No-op logger mock — avoids pino/transport noise during tests.
const noop = jest.fn();
const logger = { info: noop, warn: noop, error: noop, debug: noop, trace: noop, fatal: noop };
export const createLogger = jest.fn(() => logger);
