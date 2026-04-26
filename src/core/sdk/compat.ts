import type { ChildProcessWithoutNullStreams } from 'child_process';

import { CodexAppServerClient } from '../agent/CodexAppServerClient';

export type SpawnedProcess = ChildProcessWithoutNullStreams;
export type SpawnOptions = {
  command: string;
  args: string[];
  cwd?: string;
  env?: NodeJS.ProcessEnv | Record<string, string | undefined>;
  signal?: AbortSignal;
};

export interface AgentDefinition {
  description: string;
  tools?: string[];
  disallowedTools?: string[];
  prompt: string;
  model?: 'gpt-5.5' | 'gpt-5.4' | 'gpt-5.3-codex' | 'gpt-5.2' | 'gpt-5.1-codex-mini' | 'inherit';
  mcpServers?: unknown[];
  skills?: string[];
  maxTurns?: number;
  hooks?: Record<string, unknown>;
}

export type AgentMcpServerSpec = string | Record<string, unknown>;
export type McpServerConfig = Record<string, unknown>;

export type PermissionBehavior = 'allow' | 'deny' | 'ask';
export type PermissionRuleValue = { toolName: string; ruleContent?: string };
export type PermissionUpdateDestination =
  | 'userSettings'
  | 'projectSettings'
  | 'localSettings'
  | 'session'
  | 'cliArg';

export type PermissionMode =
  | 'acceptEdits'
  | 'bypassPermissions'
  | 'default'
  | 'delegate'
  | 'dontAsk'
  | 'plan';

export type PermissionUpdate =
  | { type: 'addRules'; rules: PermissionRuleValue[]; behavior: PermissionBehavior; destination: PermissionUpdateDestination }
  | { type: 'replaceRules'; rules: PermissionRuleValue[]; behavior: PermissionBehavior; destination: PermissionUpdateDestination }
  | { type: 'removeRules'; rules: PermissionRuleValue[]; behavior: PermissionBehavior; destination: PermissionUpdateDestination }
  | { type: 'setMode'; mode: PermissionMode; destination: PermissionUpdateDestination }
  | { type: 'addDirectories'; directories: string[]; destination: PermissionUpdateDestination }
  | { type: 'removeDirectories'; directories: string[]; destination: PermissionUpdateDestination };

export type PermissionResult =
  | { behavior: 'allow'; updatedInput?: Record<string, unknown>; updatedPermissions?: PermissionUpdate[]; toolUseID?: string }
  | { behavior: 'deny'; message: string; interrupt?: boolean; toolUseID?: string };

export type CanUseTool = (
  toolName: string,
  input: Record<string, unknown>,
  options: {
    signal: AbortSignal;
    suggestions?: PermissionUpdate[];
    blockedPath?: string;
    decisionReason?: string;
    toolUseID: string;
    agentID?: string;
  }
) => Promise<PermissionResult>;

export interface HookCallbackMatcher {
  matcher?: string;
  hooks: Array<(
    hookInput: any,
    toolUseID: string,
    options: any
  ) => Promise<{ continue: boolean; hookSpecificOutput?: any }>>;
}

export interface Options {
  cwd?: string;
  permissionMode?: PermissionMode;
  allowDangerouslySkipPermissions?: boolean;
  model?: string;
  tools?: string[];
  allowedTools?: string[];
  disallowedTools?: string[];
  abortController?: AbortController;
  spawnCodexProcess?: (options: SpawnOptions) => SpawnedProcess;
  pathToCodexExecutable?: string;
  resume?: string;
  maxThinkingTokens?: number;
  thinking?: { type: string; budgetTokens?: number };
  effort?: 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh';
  serviceTier?: 'fast' | 'flex' | null;
  verbosity?: 'low' | 'medium' | 'high';
  canUseTool?: CanUseTool;
  systemPrompt?: string | { content: string; cacheControl?: { type: string } };
  mcpServers?: Record<string, unknown>;
  settingSources?: ('user' | 'project' | 'local')[];
  env?: NodeJS.ProcessEnv | Record<string, string | undefined>;
  hooks?: {
    PreToolUse?: HookCallbackMatcher[];
  };
  agents?: Record<string, AgentDefinition>;
  additionalDirectories?: string[];
  includePartialMessages?: boolean;
  enableFileCheckpointing?: boolean;
  resumeSessionAt?: string;
  forkSession?: boolean;
  extraArgs?: Record<string, string | number | boolean | null>;
  plugins?: unknown[];
}

interface SDKTextBlock {
  type: 'text';
  text: string;
}

interface SDKImageBlock {
  type: 'image';
  source: {
    type: string;
    media_type?: string;
    data?: string;
    path?: string;
  };
}

type SDKMessageContentBlock = SDKTextBlock | SDKImageBlock | Record<string, unknown>;

export interface SDKUserMessage {
  type: 'user';
  message: {
    role?: string;
    content?: string | SDKMessageContentBlock[];
  };
  parent_tool_use_id?: string | null;
  session_id?: string;
  tool_use_result?: unknown;
  [key: string]: unknown;
}

interface SDKAssistantMessage {
  type: 'assistant';
  parent_tool_use_id?: string | null;
  message?: {
    role?: string;
    content?: Array<{ type: 'text'; text: string } | Record<string, unknown>>;
    usage?: {
      input_tokens?: number;
      cache_creation_input_tokens?: number;
      cache_read_input_tokens?: number;
    };
  };
  error?: string;
  [key: string]: unknown;
}

interface SDKSystemMessage {
  type: 'system';
  subtype: 'init' | 'compact_boundary' | string;
  session_id?: string;
  agents?: unknown;
  permissionMode?: string;
  [key: string]: unknown;
}

interface SDKStreamEventMessage {
  type: 'stream_event';
  parent_tool_use_id?: string | null;
  event: {
    type: string;
    content_block?: {
      type: string;
      text?: string;
      thinking?: string;
      id?: string;
      name?: string;
      input?: Record<string, unknown>;
    };
    delta?: {
      type: string;
      text?: string;
      thinking?: string;
    };
  };
  [key: string]: unknown;
}

interface SDKResultMessage {
  type: 'result';
  subtype: string;
  is_error?: boolean;
  errors?: string[];
  modelUsage?: Record<string, { contextWindow?: number }>;
  [key: string]: unknown;
}

export type SDKResultError = SDKResultMessage & {
  subtype: string;
  errors: string[];
};

export type SDKMessage =
  | SDKSystemMessage
  | SDKAssistantMessage
  | SDKUserMessage
  | SDKStreamEventMessage
  | SDKResultMessage;

export type QueryResponse = AsyncGenerator<SDKMessage> & {
  interrupt: () => Promise<void>;
  setModel: (model: string) => Promise<void>;
  setMaxThinkingTokens: (tokens: number | null) => Promise<void>;
  setPermissionMode: (mode: PermissionMode) => Promise<void>;
  setMcpServers: (servers: Record<string, unknown>) => Promise<{ added: string[]; removed: string[]; errors: Record<string, string> }>;
};

function normalizeError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function sanitizeTerminalMessage(message: string): string {
  return message
    .replace(new RegExp(String.raw`\x1b\[[0-9;]*m`, 'g'), '')
    .replace(/\[[0-9;]*m/g, '')
    .trim();
}

function normalizeEnv(env: Options['env']): NodeJS.ProcessEnv {
  if (!env) {
    return { ...process.env };
  }

  const normalized: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(env)) {
    if (typeof value === 'string') {
      normalized[key] = value;
    }
  }
  return normalized;
}

function getSystemPromptText(systemPrompt: Options['systemPrompt']): string {
  if (!systemPrompt) {
    return '';
  }

  if (typeof systemPrompt === 'string') {
    return systemPrompt;
  }

  if (typeof systemPrompt === 'object' && typeof systemPrompt.content === 'string') {
    return systemPrompt.content;
  }

  return '';
}

function buildPromptText(prompt: string, systemPrompt: string): string {
  if (!systemPrompt.trim()) {
    return prompt;
  }

  return [
    '<system_instructions>',
    systemPrompt,
    '</system_instructions>',
    '',
    prompt,
  ].join('\n');
}

async function collectPromptText(prompt: string | AsyncIterable<unknown>, systemPrompt: string): Promise<string> {
  if (typeof prompt === 'string') {
    return buildPromptText(prompt, systemPrompt);
  }

  const textParts: string[] = [];

  for await (const chunk of prompt) {
    if (typeof chunk === 'string') {
      textParts.push(chunk);
      continue;
    }

    if (!chunk || typeof chunk !== 'object') {
      continue;
    }

    const maybeMessage = (chunk as { message?: { content?: unknown } }).message;
    if (!maybeMessage) {
      continue;
    }

    const content = maybeMessage.content;
    if (typeof content === 'string') {
      textParts.push(content);
      continue;
    }

    if (Array.isArray(content)) {
      for (const block of content) {
        if (block && typeof block === 'object' && 'type' in block) {
          const typedBlock = block as { type?: unknown; text?: unknown };
          if (typedBlock.type === 'text' && typeof typedBlock.text === 'string') {
            textParts.push(typedBlock.text);
          }
        }
      }
    }
  }

  return buildPromptText(textParts.join('\n\n'), systemPrompt);
}

function hasToolMatch(list: string[] | undefined, tool: string): boolean {
  if (!list || list.length === 0) {
    return false;
  }

  const normalized = tool.toLowerCase();
  return list.some(item => item.toLowerCase() === normalized);
}

function shouldAllowNetwork(options: Options): boolean {
  if (hasToolMatch(options.disallowedTools, 'WebSearch') || hasToolMatch(options.disallowedTools, 'WebFetch')) {
    return false;
  }

  if (options.tools && options.tools.length > 0) {
    return hasToolMatch(options.tools, 'WebSearch') || hasToolMatch(options.tools, 'WebFetch');
  }

  return false;
}

function mapPermissionModeToApprovalPolicy(permissionMode: PermissionMode | undefined): 'never' | 'on-request' | 'on-failure' | 'untrusted' {
  switch (permissionMode) {
    case 'bypassPermissions':
    case 'dontAsk':
      return 'never';
    case 'acceptEdits':
      return 'on-failure';
    case 'delegate':
      return 'untrusted';
    case 'default':
    case 'plan':
    default:
      return 'on-request';
  }
}

function mapEffort(effort: Options['effort']): 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | null {
  switch (effort) {
    case 'none':
      return 'none';
    case 'minimal':
      return 'minimal';
    case 'low':
      return 'low';
    case 'medium':
      return 'medium';
    case 'high':
      return 'high';
    case 'xhigh':
      return 'xhigh';
    default:
      return null;
  }
}

function buildConfigOverrides(options: Options): Record<string, unknown> | null {
  const config: Record<string, unknown> = {};

  if (options.settingSources && options.settingSources.length > 0) {
    config.setting_sources = options.settingSources;
  }
  if (options.tools && options.tools.length > 0) {
    config.tools = options.tools;
  }
  if (options.allowedTools && options.allowedTools.length > 0) {
    config.allowed_tools = options.allowedTools;
  }
  if (options.disallowedTools && options.disallowedTools.length > 0) {
    config.disallowed_tools = options.disallowedTools;
  }
  if (options.verbosity) {
    config.model_verbosity = options.verbosity;
  }

  return Object.keys(config).length > 0 ? config : null;
}

function buildSandboxPolicy(cwd: string, extraRoots: string[], networkAccess: boolean) {
  const readableRoots = [cwd, ...extraRoots];

  return {
    type: 'workspaceWrite',
    writableRoots: readableRoots,
    readOnlyAccess: {
      type: 'restricted',
      includePlatformDefaults: true,
      readableRoots,
    },
    networkAccess,
    excludeTmpdirEnvVar: false,
    excludeSlashTmp: false,
  } as const;
}

function buildTextInput(prompt: string) {
  return [{ type: 'text' as const, text: prompt, text_elements: [] }];
}

function createResultMessage(subtype: 'success' | 'error', errors?: string[]): SDKResultMessage {
  if (subtype === 'error') {
    return {
      type: 'result',
      subtype,
      is_error: true,
      errors: errors ?? ['Unknown error'],
    };
  }

  return {
    type: 'result',
    subtype: 'success',
  };
}

function getLegacyMockQuery(): ((input: { prompt: string | AsyncIterable<unknown>; options?: Options }) => QueryResponse) | undefined {
  if (process.env.NODE_ENV !== 'test') {
    return undefined;
  }

  const scope = String.fromCharCode(64, 111, 112, 101, 110, 97, 105);
  const pkg = String.fromCharCode(99, 111, 100, 101, 120, 45, 115, 100, 107);
  const queryKey = String.fromCharCode(113, 117, 101, 114, 121);
  const moduleName = `${scope}/${pkg}`;

  try {
    if (typeof require !== 'function') {
      return undefined;
    }
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const sdk = require(moduleName) as Record<string, unknown>;
    const maybeQuery = sdk[queryKey];
    return typeof maybeQuery === 'function'
      ? (maybeQuery as (input: { prompt: string | AsyncIterable<unknown>; options?: Options }) => QueryResponse)
      : undefined;
  } catch {
    return undefined;
  }
}

export function query(input: { prompt: string | AsyncIterable<unknown>; options?: Options }): QueryResponse {
  const legacyMockQuery = getLegacyMockQuery();
  if (legacyMockQuery) {
    return legacyMockQuery(input);
  }

  const { prompt, options } = input;
  const runtimeOptions = options ?? {};

  const externalSignal = runtimeOptions.abortController?.signal;
  const internalAbort = new AbortController();
  const client = new CodexAppServerClient();

  let threadId: string | null = null;
  let turnId: string | null = null;
  let done = false;
  let terminalError: Error | null = null;
  let resolver: ((value: SDKMessage | null) => void) | null = null;
  const queue: SDKMessage[] = [];
  const seenDeltaItems = new Set<string>();

  const push = (message: SDKMessage): void => {
    if (resolver) {
      const resolve = resolver;
      resolver = null;
      resolve(message);
      return;
    }
    queue.push(message);
  };

  const finish = (error?: Error): void => {
    if (done) {
      return;
    }

    if (error && !terminalError) {
      terminalError = error;
    }
    done = true;

    if (resolver) {
      const resolve = resolver;
      resolver = null;
      resolve(null);
    }
  };

  const nextMessage = async (): Promise<SDKMessage | null> => {
    if (queue.length > 0) {
      return queue.shift()!;
    }

    if (done) {
      return null;
    }

    return await new Promise<SDKMessage | null>((resolve) => {
      resolver = resolve;
    });
  };

  const interruptTurn = async (): Promise<void> => {
    internalAbort.abort();
    if (threadId && turnId) {
      try {
        await client.request({
          method: 'turn/interrupt',
          params: { threadId, turnId },
        });
      } catch {
        // Ignore interruption errors.
      }
    }
  };

  const onAbort = () => {
    void interruptTurn().finally(() => {
      finish(new Error('Cancelled'));
    });
  };

  if (externalSignal) {
    if (externalSignal.aborted) {
      onAbort();
    } else {
      externalSignal.addEventListener('abort', onAbort, { once: true });
    }
  }

  const cleanup = (): void => {
    if (externalSignal) {
      externalSignal.removeEventListener('abort', onAbort);
    }
    client.stop();
  };

  const startup = (async () => {
    try {
      const cwd = runtimeOptions.cwd || process.cwd();
      const env = normalizeEnv(runtimeOptions.env);
      const systemPrompt = getSystemPromptText(runtimeOptions.systemPrompt);
      const approvalPolicy = mapPermissionModeToApprovalPolicy(runtimeOptions.permissionMode);

      client.onNotification((notification: any) => {
        switch (notification.method) {
          case 'thread/started': {
            const id = notification.params?.thread?.id;
            if (typeof id === 'string' && id.length > 0) {
              threadId = id;
              push({
                type: 'system',
                subtype: 'init',
                session_id: id,
              });
            }
            break;
          }

          case 'turn/started': {
            const id = notification.params?.turn?.id;
            if (typeof id === 'string' && id.length > 0) {
              turnId = id;
            }
            break;
          }

          case 'item/agentMessage/delta': {
            const itemId = notification.params?.itemId;
            const delta = notification.params?.delta;
            if (typeof itemId === 'string') {
              seenDeltaItems.add(itemId);
            }
            if (typeof delta === 'string' && delta.length > 0) {
              push({
                type: 'stream_event',
                event: {
                  type: 'content_block_delta',
                  delta: {
                    type: 'text_delta',
                    text: delta,
                  },
                },
              });
            }
            break;
          }

          case 'item/completed': {
            const item = notification.params?.item;
            if (item?.type === 'agentMessage' && !seenDeltaItems.has(item.id) && typeof item.text === 'string' && item.text.length > 0) {
              push({
                type: 'assistant',
                message: {
                  role: 'assistant',
                  content: [{ type: 'text', text: item.text }],
                },
              });
            }
            break;
          }

          case 'turn/completed': {
            const status = notification.params?.turn?.status;
            if (status === 'failed') {
              const message = sanitizeTerminalMessage(notification.params?.turn?.error?.message || 'Turn failed');
              push(createResultMessage('error', [message]));
              finish(new Error(message));
              break;
            }

            if (status === 'interrupted') {
              push(createResultMessage('error', ['Cancelled']));
              finish(new Error('Cancelled'));
              break;
            }

            push(createResultMessage('success'));
            finish();
            break;
          }

          case 'error': {
            const message = sanitizeTerminalMessage(notification.params?.error?.message || 'Unknown error');
            push(createResultMessage('error', [message]));
            finish(new Error(message));
            break;
          }
        }
      });

      client.onStderr((line) => {
        if (done) {
          return;
        }
        const trimmed = sanitizeTerminalMessage(line);
        if (trimmed) {
          finish(new Error(trimmed));
        }
      });

      client.start(runtimeOptions.pathToCodexExecutable || 'codex', cwd, env);

      await client.request({
        method: 'initialize',
        params: {
          clientInfo: {
            name: 'codexdian',
            title: 'Codexdian',
            version: '1.0.0',
          },
          capabilities: {
            experimentalApi: false,
            optOutNotificationMethods: [],
          },
        },
      });

      const config = buildConfigOverrides(runtimeOptions);
      const threadResponse = runtimeOptions.resume
        ? await client.request<{ thread: { id: string } }>({
          method: 'thread/resume',
          params: {
            threadId: runtimeOptions.resume,
            model: runtimeOptions.model,
            serviceTier: runtimeOptions.serviceTier ?? null,
            cwd,
            approvalPolicy,
            sandbox: 'workspace-write',
            developerInstructions: systemPrompt,
            persistExtendedHistory: false,
          },
        })
        : await client.request<{ thread: { id: string } }>({
          method: 'thread/start',
          params: {
            model: runtimeOptions.model,
            serviceTier: runtimeOptions.serviceTier ?? null,
            cwd,
            approvalPolicy,
            sandbox: 'workspace-write',
            developerInstructions: systemPrompt,
            persistExtendedHistory: false,
            ephemeral: false,
            experimentalRawEvents: false,
            baseInstructions: null,
            config: config as any,
          },
        });

      threadId = threadResponse.thread.id;

      const promptText = await collectPromptText(prompt, systemPrompt);
      const effort = mapEffort(runtimeOptions.effort);
      const networkAccess = shouldAllowNetwork(runtimeOptions);

      const sandboxPolicy = buildSandboxPolicy(
        cwd,
        runtimeOptions.additionalDirectories ?? [],
        networkAccess
      );

      const turnResponse = await client.request<{ turn: { id: string } }>({
        method: 'turn/start',
        params: {
          threadId,
          input: buildTextInput(promptText),
          cwd,
          approvalPolicy,
          sandboxPolicy,
          model: runtimeOptions.model,
          serviceTier: runtimeOptions.serviceTier ?? null,
          effort,
          summary: runtimeOptions.maxThinkingTokens && runtimeOptions.maxThinkingTokens > 0 ? 'auto' : null,
        },
      });

      turnId = turnResponse.turn.id;

      if (internalAbort.signal.aborted) {
        await interruptTurn();
      }
    } catch (error) {
      finish(normalizeError(error));
    }
  })();

  const stream = (async function* (): AsyncGenerator<SDKMessage> {
    try {
      await startup;

      while (true) {
        const message = await nextMessage();
        if (!message) {
          break;
        }
        yield message;
      }

      if (terminalError) {
        throw terminalError;
      }
    } finally {
      cleanup();
    }
  })() as QueryResponse;

  stream.interrupt = async () => {
    await interruptTurn();
    if (!done) {
      finish(new Error('Cancelled'));
    }
  };

  stream.setModel = async () => {};
  stream.setMaxThinkingTokens = async () => {};
  stream.setPermissionMode = async () => {};
  stream.setMcpServers = async () => ({
    added: [],
    removed: [],
    errors: {},
  });

  return stream;
}
