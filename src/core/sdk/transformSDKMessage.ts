import type { SDKToolUseResult, UsageInfo } from '../types';
import { getContextWindowSize } from '../types';
import type { SDKMessage, SDKResultError } from './compat';
import type { TransformEvent } from './types';

export interface TransformOptions {
  /** The intended model from settings/query (used for context window size). */
  intendedModel?: string;
  /** Custom context limits from settings (model ID → tokens). */
  customContextLimits?: Record<string, number>;
}

interface MessageUsage {
  input_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
}

interface ContextWindowEntry {
  model: string;
  contextWindow: number;
}

function isResultError(message: { type: 'result'; subtype: string }): message is SDKResultError {
  return !!message.subtype && message.subtype !== 'success';
}

function getBuiltInModelSignature(
  model: string
): { family: 'gpt-5.1-codex-mini' | 'gpt-5.2' | 'gpt-5.3-codex' | 'gpt-5.4'; is1M: boolean } | null {
  const normalized = model.trim().toLowerCase();
  if (normalized === 'gpt-5.1-codex-mini') {
    return { family: 'gpt-5.1-codex-mini', is1M: false };
  }
  if (normalized === 'gpt-5.2' || normalized === 'gpt-5.2[1m]') {
    return { family: 'gpt-5.2', is1M: normalized.endsWith('[1m]') };
  }
  if (normalized === 'gpt-5.3-codex' || normalized === 'gpt-5.3-codex[1m]') {
    return { family: 'gpt-5.3-codex', is1M: normalized.endsWith('[1m]') };
  }
  if (normalized === 'gpt-5.4' || normalized === 'gpt-5.4[1m]') {
    return { family: 'gpt-5.4', is1M: normalized.endsWith('[1m]') };
  }
  return null;
}

function getModelUsageSignature(
  model: string
): { family: 'gpt-5.1-codex-mini' | 'gpt-5.2' | 'gpt-5.3-codex' | 'gpt-5.4'; is1M: boolean } | null {
  const normalized = model.trim().toLowerCase();
  if (normalized.includes('gpt-5.1-codex-mini')) {
    return { family: 'gpt-5.1-codex-mini', is1M: false };
  }
  if (normalized.includes('gpt-5.2')) {
    return { family: 'gpt-5.2', is1M: normalized.endsWith('[1m]') };
  }
  if (normalized.includes('gpt-5.3-codex')) {
    return { family: 'gpt-5.3-codex', is1M: normalized.endsWith('[1m]') };
  }
  if (normalized.includes('gpt-5.4')) {
    return { family: 'gpt-5.4', is1M: normalized.endsWith('[1m]') };
  }
  return null;
}

function selectContextWindowEntry(
  modelUsage: Record<string, { contextWindow?: number }>,
  intendedModel?: string
): ContextWindowEntry | null {
  const entries: ContextWindowEntry[] = Object.entries(modelUsage)
    .flatMap(([model, usage]) =>
      typeof usage?.contextWindow === 'number' && usage.contextWindow > 0
        ? [{ model, contextWindow: usage.contextWindow }]
        : []
    );

  if (entries.length === 0) {
    return null;
  }

  if (entries.length === 1) {
    return entries[0];
  }

  if (!intendedModel) {
    return null;
  }

  const exactMatches = entries.filter((entry) => entry.model === intendedModel);
  if (exactMatches.length === 1) {
    return exactMatches[0];
  }

  const intendedSignature = getBuiltInModelSignature(intendedModel);
  if (!intendedSignature) {
    return null;
  }

  const signatureMatches = entries.filter((entry) => {
    const entrySignature = getModelUsageSignature(entry.model);
    return entrySignature?.family === intendedSignature.family && entrySignature.is1M === intendedSignature.is1M;
  });

  return signatureMatches.length === 1 ? signatureMatches[0] : null;
}

/**
 * Transform SDK message to StreamChunk format.
 * One SDK message can yield multiple chunks (e.g., text + tool_use blocks).
 */
export function* transformSDKMessage(
  message: SDKMessage,
  options?: TransformOptions
): Generator<TransformEvent> {
  const sdkMessage = message as any;
  const messageType = String((sdkMessage as any).type ?? '');

  switch (messageType) {
    case 'system':
      if (sdkMessage.subtype === 'init' && sdkMessage.session_id) {
        yield {
          type: 'session_init',
          sessionId: sdkMessage.session_id,
          agents: sdkMessage.agents,
          permissionMode: sdkMessage.permissionMode,
        };
      } else if (sdkMessage.subtype === 'compact_boundary') {
        yield { type: 'compact_boundary' };
      }
      break;

    case 'assistant': {
      const parentToolUseId = sdkMessage.parent_tool_use_id ?? null;

      // Errors on assistant messages (e.g. rate_limit, billing_error)
      if (sdkMessage.error) {
        yield { type: 'error', content: sdkMessage.error };
      }

      if (sdkMessage.message?.content && Array.isArray(sdkMessage.message.content)) {
        for (const block of sdkMessage.message.content) {
          if (block.type === 'thinking' && block.thinking) {
            yield { type: 'thinking', content: block.thinking, parentToolUseId };
          } else if (block.type === 'text' && block.text && block.text.trim() !== '(no content)') {
            yield { type: 'text', content: block.text, parentToolUseId };
          } else if (block.type === 'tool_use') {
            yield {
              type: 'tool_use',
              id: block.id || `tool-${Date.now()}-${Math.random().toString(36).substring(2, 11)}`,
              name: block.name || 'unknown',
              input: block.input || {},
              parentToolUseId,
            };
          }
        }
      }

      // Extract usage from main agent assistant messages only (not subagent)
      // This gives accurate per-turn context usage without subagent token pollution
      const usage = (sdkMessage.message as { usage?: MessageUsage } | undefined)?.usage;
      if (parentToolUseId === null && usage) {
        const inputTokens = usage.input_tokens ?? 0;
        const cacheCreationInputTokens = usage.cache_creation_input_tokens ?? 0;
        const cacheReadInputTokens = usage.cache_read_input_tokens ?? 0;
        const contextTokens = inputTokens + cacheCreationInputTokens + cacheReadInputTokens;

        const model = options?.intendedModel ?? 'gpt-5.3-codex';
        const contextWindow = getContextWindowSize(model, options?.customContextLimits);
        const percentage = Math.min(100, Math.max(0, Math.round((contextTokens / contextWindow) * 100)));

        const usageInfo: UsageInfo = {
          model,
          inputTokens,
          cacheCreationInputTokens,
          cacheReadInputTokens,
          contextWindow,
          contextTokens,
          percentage,
        };
        yield { type: 'usage', usage: usageInfo };
      }
      break;
    }

    case 'user': {
      const userMessage: any = sdkMessage;
      const parentToolUseId = userMessage.parent_tool_use_id ?? null;

      // Check for blocked tool calls (from hook denials)
      if (userMessage.type === 'user' && userMessage._blocked === true && '_blockReason' in userMessage) {
        yield {
          type: 'blocked',
          content: userMessage._blockReason,
        };
        break;
      }
      // User messages can contain tool results
      if (userMessage.tool_use_result !== undefined && userMessage.parent_tool_use_id) {
        yield {
          type: 'tool_result',
          id: userMessage.parent_tool_use_id,
          content: typeof userMessage.tool_use_result === 'string'
            ? userMessage.tool_use_result
            : JSON.stringify(userMessage.tool_use_result, null, 2),
          isError: false,
          parentToolUseId,
          toolUseResult: (userMessage.tool_use_result ?? undefined) as SDKToolUseResult | undefined,
        };
      }
      // Also check message.message.content for tool_result blocks
      if (userMessage.message?.content && Array.isArray(userMessage.message.content)) {
        for (const block of userMessage.message.content) {
          if (block.type === 'tool_result') {
            yield {
              type: 'tool_result',
              id: block.tool_use_id || userMessage.parent_tool_use_id || '',
              content: typeof block.content === 'string'
                ? block.content
                : JSON.stringify(block.content, null, 2),
              isError: block.is_error || false,
              parentToolUseId,
              toolUseResult: (userMessage.tool_use_result ?? undefined) as SDKToolUseResult | undefined,
            };
          }
        }
      }
      break;
    }

    case 'stream_event': {
      const parentToolUseId = sdkMessage.parent_tool_use_id ?? null;
      const event = sdkMessage.event;
      if (event?.type === 'content_block_start' && event.content_block?.type === 'tool_use') {
        yield {
          type: 'tool_use',
          id: event.content_block.id || `tool-${Date.now()}`,
          name: event.content_block.name || 'unknown',
          input: event.content_block.input || {},
          parentToolUseId,
        };
      } else if (event?.type === 'content_block_start' && event.content_block?.type === 'thinking') {
        if (event.content_block.thinking) {
          yield { type: 'thinking', content: event.content_block.thinking, parentToolUseId };
        }
      } else if (event?.type === 'content_block_start' && event.content_block?.type === 'text') {
        if (event.content_block.text) {
          yield { type: 'text', content: event.content_block.text, parentToolUseId };
        }
      } else if (event?.type === 'content_block_delta') {
        if (event.delta?.type === 'thinking_delta' && event.delta.thinking) {
          yield { type: 'thinking', content: event.delta.thinking, parentToolUseId };
        } else if (event.delta?.type === 'text_delta' && event.delta.text) {
          yield { type: 'text', content: event.delta.text, parentToolUseId };
        }
      }
      break;
    }

    case 'result':
      if (isResultError(sdkMessage)) {
        const content = (sdkMessage.errors as string[]).filter((e: string) => e.trim().length > 0).join('\n');
        yield {
          type: 'error',
          content: content || `Result error: ${sdkMessage.subtype}`,
        };
      }

      // Usage is now extracted from assistant messages for accuracy (excludes subagent tokens)
      // Result message usage is aggregated across main + subagents, causing inaccurate spikes

      if ('modelUsage' in sdkMessage && sdkMessage.modelUsage) {
        const modelUsage = sdkMessage.modelUsage as Record<string, { contextWindow?: number }>;
        const selectedEntry = selectContextWindowEntry(modelUsage, options?.intendedModel);
        if (selectedEntry) {
          yield { type: 'context_window_update', contextWindow: selectedEntry.contextWindow };
        }
      }
      break;

    default:
      break;
  }
}
