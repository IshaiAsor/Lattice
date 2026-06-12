// Manual mock for @lattice/prisma-client.
// jest.config.ts maps the real package to this file so no DB connection is made.
// resetMocks:true in jest.config.ts resets these jest.fn() instances between tests.

export const db = {
  userDevice: {
    findUnique: jest.fn(),
    findFirst:  jest.fn(),
    findMany:   jest.fn(),
    create:     jest.fn(),
    update:     jest.fn(),
  },
  userDeviceModel: {
    findFirst: jest.fn(),
    create:    jest.fn(),
  },
  userAction: {
    findMany:    jest.fn(),
    createMany:  jest.fn(),
  },
  userActionDef: {
    findMany: jest.fn(),
  },
  emergencyEvent: {
    create: jest.fn(),
  },
  emergencyRule: {
    findMany: jest.fn(),
  },
};
