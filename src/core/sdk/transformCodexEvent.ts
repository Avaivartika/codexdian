import type { ServerNotification } from '../../../generated/ServerNotification';
import type { ThreadItem } from '../../../generated/v2/ThreadItem';
import type { StreamChunk, UsageInfo } from '../types';
import type { TransformEvent } from './types';

function sanitizeTerminalMessage(message: string): string {
  return message
    .replace(new RegExp(String.raw`\x1b\[[0-9;]*m`, 'g'), '')
    .replace(/\[[0-9;]*m/g, '')
    .trim();
}

function stringifyJson(value: unknown): string {
  if (typeof value === 'string') {
    return value;
  }

  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function summarizeFileChanges(item: Extract<ThreadItem, { type: 'fileChange' }>): string {
  if (!item.changes.length) {
    return 'No file changes recorded.';
  }

  return item.changes
    .map((change) => {
      const path = 'path' in change && typeof change.path === 'string' ? change.path : 'unknown';
      const kind = 'kind' in change && typeof change.kind === 'string' ? change.kind : 'updated';
      return `${kind}: ${path}`;
    })
    .join('\n');
}

function summarizeCommand(item: Extract<ThreadItem, { type: 'commandExecution' }>): string {
  const output = item.aggregatedOutput?.trim();
  if (output) {
    return output;
  }

  if (item.exitCode !== null) {
    return `Command finished with exit code ${item.exitCode}.`;
  }

  return `${item.command}`;
}

function mapThreadItemToChunks(item: ThreadItem): StreamChunk[] {
  switch (item.type) {
    case 'agentMessage':
      return item.text ? [{ type: 'text', content: item.text }] : [];

    case 'plan':
      return item.text ? [{ type: 'thinking', content: item.text }] : [];

    case 'reasoning':
      return item.summary.concat(item.content).map((part) => ({ type: 'thinking', content: part }));

    case 'commandExecution':
      return [
        {
          type: 'tool_use',
          id: item.id,
          name: 'Bash',
          input: { command: item.command, cwd: item.cwd },
        },
        {
          type: 'tool_result',
          id: item.id,
          content: summarizeCommand(item),
          isError: item.status === 'failed',
        },
      ];

    case 'fileChange':
      return [
        {
          type: 'tool_use',
          id: item.id,
          name: 'Write',
          input: { changes: item.changes.length },
        },
        {
          type: 'tool_result',
          id: item.id,
          content: summarizeFileChanges(item),
          isError: item.status === 'failed',
        },
      ];

    case 'mcpToolCall':
      return [
        {
          type: 'tool_use',
          id: item.id,
          name: item.tool,
          input: {
            server: item.server,
            arguments: item.arguments,
          },
        },
        {
          type: 'tool_result',
          id: item.id,
          content: item.error ? stringifyJson(item.error) : stringifyJson(item.result),
          isError: !!item.error,
        },
      ];

    case 'dynamicToolCall':
      return [
        {
          type: 'tool_use',
          id: item.id,
          name: item.tool,
          input: typeof item.arguments === 'object' && item.arguments !== null ? item.arguments as Record<string, unknown> : { arguments: item.arguments },
        },
        {
          type: 'tool_result',
          id: item.id,
          content: stringifyJson(item.contentItems),
          isError: item.success === false,
        },
      ];

    case 'userMessage':
      return item.content
        .filter((part): part is Extract<typeof part, { type: 'text' }> => part.type === 'text')
        .map((part) => ({ type: 'text', content: part.text }));

    case 'contextCompaction':
      return [{ type: 'compact_boundary' }];

    default:
      return [];
  }
}

function mapTokenUsage(notification: Extract<ServerNotification, { method: 'thread/tokenUsage/updated' }>): StreamChunk | null {
  const usage = notification.params.tokenUsage;
  const contextWindow = usage.modelContextWindow ?? 200_000;
  const contextTokens = usage.total.inputTokens + usage.total.cachedInputTokens + usage.total.outputTokens;
  const normalized: UsageInfo = {
    inputTokens: usage.total.inputTokens,
    cacheCreationInputTokens: 0,
    cacheReadInputTokens: usage.total.cachedInputTokens,
    contextWindow,
    contextTokens,
    percentage: Math.min(100, Math.max(0, Math.round((contextTokens / contextWindow) * 100))),
  };
  return { type: 'usage', usage: normalized, sessionId: notification.params.threadId };
}

export function* transformCodexNotification(notification: ServerNotification): Generator<TransformEvent> {
  switch (notification.method) {
    case 'item/agentMessage/delta':
      yield { type: 'text', content: notification.params.delta };
      break;

    case 'item/reasoning/textDelta':
    case 'item/reasoning/summaryTextDelta':
      yield { type: 'thinking', content: notification.params.delta };
      break;

    case 'item/started':
    case 'item/completed':
      yield* mapThreadItemToChunks(notification.params.item);
      break;

    case 'thread/tokenUsage/updated': {
      const chunk = mapTokenUsage(notification);
      if (chunk) yield chunk;
      break;
    }

    case 'turn/completed':
      if (notification.params.turn.status === 'failed' && notification.params.turn.error?.message) {
        yield { type: 'error', content: sanitizeTerminalMessage(notification.params.turn.error.message) };
      } else if (notification.params.turn.status === 'interrupted') {
        yield { type: 'blocked', content: 'Turn interrupted.' };
      }
      yield { type: 'done' };
      break;

    case 'thread/compacted':
      yield { type: 'compact_boundary' };
      break;

    case 'error':
      yield { type: 'error', content: sanitizeTerminalMessage(notification.params.error.message) };
      break;
  }
}
