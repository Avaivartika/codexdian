import type { SDKUserMessage } from '../sdk/compat';

export type { SDKMessage } from '../sdk/compat';

/** Runtime-only extension for blocked user messages (hook denials). */
export type BlockedUserMessage = SDKUserMessage & {
  _blocked: true;
  _blockReason: string;
};

export function isBlockedMessage(message: { type: string }): message is BlockedUserMessage {
  return (
    message.type === 'user' &&
    '_blocked' in message &&
    (message as Record<string, unknown>)._blocked === true &&
    '_blockReason' in message
  );
}
