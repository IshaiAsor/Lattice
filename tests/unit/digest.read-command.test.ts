// A state read-back (F23) must never be recorded as a command. Two independent guards enforce
// that, and this covers the one that has to survive a restart.
//
// `readback: true` on the dispatch payload keeps recordDispatch from writing the outgoing row, but
// it cannot help on the way back: the device's ack carries no such flag, and digest correlates the
// reply through a Valkey `pending_read` entry that expires and does not survive a process restart.
// At exactly that moment recordAck's no-open-row branch would create a fresh `source: 'device'`
// row — one per action, per sweep, per device, forever. The commandId prefix is what still
// identifies a read then, because the device echoes it back inside the ack.

import {
  isReadCommandId,
  READ_COMMAND_PREFIX,
} from '../../services/digest-service/src/read-command';

describe('read commandId discriminator', () => {
  it('recognises a read-back id', () => {
    expect(isReadCommandId(`${READ_COMMAND_PREFIX}0f8b6c1e-1111-4222-8333-444455556666`)).toBe(
      true,
    );
  });

  it('does not claim an ordinary command id', () => {
    // The ids every other path mints are bare UUIDs (randomUUID) or test-authored strings.
    expect(isReadCommandId('0f8b6c1e-1111-4222-8333-444455556666')).toBe(false);
    expect(isReadCommandId('e2e-set-1755600000000')).toBe(false);
  });

  it('treats an absent commandId as not-a-read', () => {
    // An unsolicited ack — a duration releasing on-device, or a boot restore — has no commandId at
    // all, and those genuinely DO deserve their own history row. Answering true here would erase
    // the very records the duration feature exists to make visible.
    expect(isReadCommandId(undefined)).toBe(false);
    expect(isReadCommandId('')).toBe(false);
  });

  it('keeps the prefix distinguishable from a UUID', () => {
    // A bare UUID can never begin with the prefix, so the discriminator cannot collide with an id
    // minted by any other path.
    expect(READ_COMMAND_PREFIX).toMatch(/^[a-z]+-$/);
    expect(/^[0-9a-f]/.test(READ_COMMAND_PREFIX)).toBe(false);
  });
});
