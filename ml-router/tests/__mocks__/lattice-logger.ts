const noop = jest.fn();
export const createLogger = jest.fn(() => ({ info: noop, warn: noop, error: noop, debug: noop }));
