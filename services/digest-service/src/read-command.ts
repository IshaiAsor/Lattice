// State read-backs (F23) mint their commandId with this prefix so a read can be told apart from a
// real command by looking at the wire alone.
//
// The pending_read Valkey entry is how a read is *correlated* back to its request, but it is not a
// safe discriminator: it expires, and it is gone after a restart. The prefix is echoed back by the
// device inside the ack, so it still identifies a read at exactly the moment the cache has
// forgotten — which is when command history would otherwise fabricate a `source: 'device'` row
// for it.
export const READ_COMMAND_PREFIX = 'rd-';

export function isReadCommandId(commandId: string | undefined): boolean {
  return commandId?.startsWith(READ_COMMAND_PREFIX) ?? false;
}
