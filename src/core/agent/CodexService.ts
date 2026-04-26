/**
 * Codex-backed chat service that preserves the original Codexdian service API.
 *
 * The rest of the plugin continues to talk to this class using the same
 * methods/signatures, but the runtime is now driven by `codex app-server`
 * instead of the Codex SDK compatibility layer.
 */

import { randomUUID } from 'crypto';

import type { ServerNotification } from '../../../generated/ServerNotification';
import type { ServerRequest } from '../../../generated/ServerRequest';
import type { FileChangeApprovalDecision } from '../../../generated/v2/FileChangeApprovalDecision';
import type { Thread } from '../../../generated/v2/Thread';
import type { ThreadItem } from '../../../generated/v2/ThreadItem';
import type CodexdianPlugin from '../../main';
import { stripCurrentNoteContext } from '../../utils/context';
import { getEnhancedPath, getMissingNodeError, parseEnvironmentVariables } from '../../utils/env';
import { getVaultPath } from '../../utils/path';
import {
  buildContextFromHistory,
  buildPromptWithHistoryContext,
  getLastUserMessage,
} from '../../utils/session';
import type { McpServerManager } from '../mcp';
import { buildSystemPrompt } from '../prompts/mainAgent';
import { transformCodexNotification } from '../sdk';
import { TOOL_ASK_USER_QUESTION, TOOL_EXIT_PLAN_MODE } from '../tools/toolNames';
import type {
  ChatMessage,
  Conversation,
  ExitPlanModeCallback,
  ExitPlanModeDecision,
  ImageAttachment,
  PermissionMode,
  SlashCommand,
  StreamChunk,
} from '../types';
import { isAdaptiveThinkingModel, THINKING_BUDGETS } from '../types';
import { CodexAppServerClient } from './CodexAppServerClient';
import { SessionManager } from './SessionManager';

export interface ApprovalCallbackOptions {
  decisionReason?: string;
  blockedPath?: string;
  agentID?: string;
}

export type ApprovalDecision = 'allow' | 'allow-always' | 'deny' | 'cancel';

export type ApprovalCallback = (
  toolName: string,
  input: Record<string, unknown>,
  description: string,
  options?: ApprovalCallbackOptions,
) => Promise<ApprovalDecision>;

export type AskUserQuestionCallback = (
  input: Record<string, unknown>,
  signal?: AbortSignal,
) => Promise<Record<string, string> | null>;

export interface QueryOptions {
  allowedTools?: string[];
  model?: string;
  mcpMentions?: Set<string>;
  enabledMcpServers?: Set<string>;
  forceColdStart?: boolean;
  externalContextPaths?: string[];
}

export interface EnsureReadyOptions {
  sessionId?: string;
  externalContextPaths?: string[];
  force?: boolean;
  preserveHandlers?: boolean;
}

export interface RewindFilesResult {
  canRewind: boolean;
  filesChanged?: string[];
  insertions?: number;
  deletions?: number;
  error?: string;
}

interface ActiveTurnState {
  queue: StreamChunk[];
  resolver: ((chunk: StreamChunk | null) => void) | null;
  done: boolean;
  error: Error | null;
  threadId: string;
  turnId: string | null;
  userUuid: string;
  assistantUuid: string | null;
  seenAgentMessageItemIds: Set<string>;
}

function createEmptyTurnState(threadId: string): ActiveTurnState {
  return {
    queue: [],
    resolver: null,
    done: false,
    error: null,
    threadId,
    turnId: null,
    userUuid: randomUUID(),
    assistantUuid: null,
    seenAgentMessageItemIds: new Set<string>(),
  };
}

function pushChunk(state: ActiveTurnState | null, chunk: StreamChunk): void {
  if (!state) return;
  if (state.resolver) {
    const resolve = state.resolver;
    state.resolver = null;
    resolve(chunk);
    return;
  }
  state.queue.push(chunk);
}

function mapPermissionModeToApprovalPolicy(mode: PermissionMode) {
  if (mode === 'yolo') return 'never' as const;
  if (mode === 'plan') return 'untrusted' as const;
  return 'on-request' as const;
}

function mapEffortLevel(level: 'low' | 'medium' | 'high' | 'max') {
  if (level === 'max') return 'high' as const;
  return level;
}

function sanitizeTerminalMessage(message: string): string {
  return message
    .replace(new RegExp(String.raw`\x1b\[[0-9;]*m`, 'g'), '')
    .replace(/\[[0-9;]*m/g, '')
    .trim();
}

function mapPermissionModeToSandbox(mode: PermissionMode, vaultPath: string, extraRoots: string[]) {
  if (mode === 'yolo') {
    return { type: 'dangerFullAccess' } as const;
  }

  const readableRoots = [vaultPath, ...extraRoots];
  return {
    type: 'workspaceWrite' as const,
    writableRoots: readableRoots,
    readOnlyAccess: {
      type: 'restricted' as const,
      includePlatformDefaults: true,
      readableRoots,
    },
    networkAccess: false,
    excludeTmpdirEnvVar: false,
    excludeSlashTmp: false,
  };
}

function buildUserInputs(prompt: string, images?: ImageAttachment[]) {
  const inputs: Array<{ type: 'text'; text: string; text_elements: [] } | { type: 'image'; url: string }> = [];

  if (prompt.trim()) {
    inputs.push({ type: 'text', text: prompt, text_elements: [] });
  }

  for (const image of images ?? []) {
    inputs.push({
      type: 'image',
      url: `data:${image.mediaType};base64,${image.data}`,
    });
  }

  return inputs;
}

function getFileChangesFromThread(thread: Thread): string[] {
  const latestTurn = thread.turns[thread.turns.length - 1];
  if (!latestTurn) return [];

  const paths = latestTurn.items
    .filter((item): item is Extract<ThreadItem, { type: 'fileChange' }> => item.type === 'fileChange')
    .flatMap((item) => item.changes.map((change) => change.path));

  return Array.from(new Set(paths));
}

function isThreadNotFoundError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /thread not found/i.test(message);
}

export class CodexService {
  private plugin: CodexdianPlugin;
  private mcpManager: McpServerManager;
  private client: CodexAppServerClient | null = null;
  private abortController: AbortController | null = null;
  private approvalCallback: ApprovalCallback | null = null;
  private approvalDismisser: (() => void) | null = null;
  private askUserQuestionCallback: AskUserQuestionCallback | null = null;
  private exitPlanModeCallback: ExitPlanModeCallback | null = null;
  private permissionModeSyncCallback: ((sdkMode: string) => void) | null = null;
  private vaultPath: string | null = null;
  private currentExternalContextPaths: string[] = [];
  private readyStateListeners = new Set<(ready: boolean) => void>();
  private sessionManager = new SessionManager();
  private activeTurn: ActiveTurnState | null = null;
  private lastDiffByTurn = new Map<string, string>();
  private shuttingDown = false;
  private pendingResumeAt?: string;
  private pendingForkSession = false;
  private unsubs: Array<() => void> = [];

  constructor(plugin: CodexdianPlugin, mcpManager: McpServerManager) {
    this.plugin = plugin;
    this.mcpManager = mcpManager;
  }

  onReadyStateChange(listener: (ready: boolean) => void): () => void {
    this.readyStateListeners.add(listener);
    listener(this.isReady());
    return () => this.readyStateListeners.delete(listener);
  }

  private notifyReadyStateChange(): void {
    const ready = this.isReady();
    for (const listener of this.readyStateListeners) {
      try {
        listener(ready);
      } catch {
        // Ignore listener failures.
      }
    }
  }

  setPendingResumeAt(uuid: string | undefined): void {
    this.pendingResumeAt = uuid;
  }

  applyForkState(conv: Pick<Conversation, 'sessionId' | 'sdkSessionId' | 'forkSource'>): string | null {
    const isPending = !conv.sessionId && !conv.sdkSessionId && !!conv.forkSource;
    this.pendingForkSession = isPending;
    this.pendingResumeAt = isPending ? conv.forkSource?.resumeAt : undefined;
    return conv.sessionId ?? conv.forkSource?.sessionId ?? null;
  }

  async reloadMcpServers(): Promise<void> {
    await this.mcpManager.loadServers();
  }

  async ensureReady(options?: EnsureReadyOptions): Promise<boolean> {
    if (options?.externalContextPaths !== undefined) {
      this.currentExternalContextPaths = options.externalContextPaths;
    }

    const runtime = this.resolveRuntime();
    if (!runtime.ok) {
      return false;
    }

    const targetSessionId = options?.sessionId ?? this.sessionManager.getSessionId() ?? undefined;
    const needsRestart = options?.force || !this.client?.isRunning();

    if (needsRestart) {
      await this.startPersistentQuery(
        runtime.vaultPath,
        runtime.cliPath,
        targetSessionId,
        this.currentExternalContextPaths
      );
      return true;
    }

    if (targetSessionId && targetSessionId !== this.sessionManager.getSessionId()) {
      await this.startPersistentQuery(
        runtime.vaultPath,
        runtime.cliPath,
        targetSessionId,
        this.currentExternalContextPaths
      );
      return true;
    }

    if (!this.sessionManager.getSessionId()) {
      await this.startPersistentQuery(
        runtime.vaultPath,
        runtime.cliPath,
        undefined,
        this.currentExternalContextPaths
      );
      return true;
    }

    return false;
  }

  private resolveRuntime():
    | { ok: true; vaultPath: string; cliPath: string; env: NodeJS.ProcessEnv }
    | { ok: false } {
    const vaultPath = getVaultPath(this.plugin.app);
    if (!vaultPath) return { ok: false };

    const cliPath = this.plugin.getResolvedCodexCliPath();
    if (!cliPath) return { ok: false };

    const customEnv = parseEnvironmentVariables(this.plugin.getActiveEnvironmentVariables());
    const enhancedPath = getEnhancedPath(customEnv.PATH, cliPath);
    const missingNodeError = getMissingNodeError(cliPath, enhancedPath);
    if (missingNodeError) return { ok: false };

    return {
      ok: true,
      vaultPath,
      cliPath,
      env: {
        ...process.env,
        ...customEnv,
        PATH: enhancedPath,
      },
    };
  }

  private async startPersistentQuery(
    vaultPath: string,
    cliPath: string,
    resumeSessionId?: string,
    externalContextPaths?: string[]
  ): Promise<void> {
    this.closePersistentQuery('restart');

    const runtime = this.resolveRuntime();
    if (!runtime.ok) {
      return;
    }

    this.shuttingDown = false;
    this.vaultPath = vaultPath;
    this.client = new CodexAppServerClient();
    this.client.start(cliPath, vaultPath, runtime.env);

    this.unsubs = [
      this.client.onNotification((notification) => void this.handleNotification(notification)),
      this.client.onRequest((request) => void this.handleServerRequest(request)),
      this.client.onStderr((line) => {
        const cleaned = sanitizeTerminalMessage(line);
        if (this.activeTurn && cleaned) {
          pushChunk(this.activeTurn, { type: 'error', content: cleaned });
        }
      }),
    ];

    await this.client.request({
      method: 'initialize',
      params: {
        clientInfo: {
          name: 'codexdian',
          title: 'Codexdian',
          version: this.plugin.manifest.version,
        },
        capabilities: {
          experimentalApi: false,
          optOutNotificationMethods: [],
        },
      },
    });

    const thread = await this.startOrResumeThread(vaultPath, resumeSessionId, externalContextPaths ?? []);
    this.sessionManager.captureSession(thread.id);
    this.pendingForkSession = false;
    this.pendingResumeAt = undefined;
    this.notifyReadyStateChange();
  }

  private async startOrResumeThread(
    vaultPath: string,
    resumeSessionId: string | undefined,
    externalContextPaths: string[]
  ): Promise<Thread> {
    if (!this.client) {
      throw new Error('Codex client is not running.');
    }

    const commonConfig = {
      model: this.plugin.settings.model,
      cwd: vaultPath,
      approvalPolicy: mapPermissionModeToApprovalPolicy(this.plugin.settings.permissionMode),
      sandbox: this.plugin.settings.permissionMode === 'yolo' ? 'danger-full-access' : 'workspace-write',
      developerInstructions: buildSystemPrompt({
        mediaFolder: this.plugin.settings.mediaFolder,
        customPrompt: this.plugin.settings.systemPrompt,
        allowedExportPaths: this.plugin.settings.allowedExportPaths,
        allowExternalAccess: this.plugin.settings.allowExternalAccess,
        vaultPath,
        userName: this.plugin.settings.userName,
      }),
      persistExtendedHistory: false,
    };

    if (resumeSessionId && this.pendingForkSession) {
      try {
        const response = await this.client.request<{ thread: Thread }>({
          method: 'thread/fork',
          params: {
            threadId: resumeSessionId,
            ...commonConfig,
          },
        });
        return response.thread;
      } catch (error) {
        if (!isThreadNotFoundError(error)) throw error;
        this.pendingForkSession = false;
      }
    }

    if (resumeSessionId) {
      try {
        const response = await this.client.request<{ thread: Thread }>({
          method: 'thread/resume',
          params: {
            threadId: resumeSessionId,
            ...commonConfig,
          },
        });
        return response.thread;
      } catch (error) {
        if (!isThreadNotFoundError(error)) throw error;
        this.sessionManager.reset();
      }
    }

    const response = await this.client.request<{ thread: Thread }>({
      method: 'thread/start',
      params: {
        ...commonConfig,
        ephemeral: false,
        experimentalRawEvents: false,
        baseInstructions: null,
        config: externalContextPaths.length > 0
          ? { external_context_paths: externalContextPaths }
          : null,
      },
    });
    return response.thread;
  }

  closePersistentQuery(_reason?: string, _options?: { preserveHandlers?: boolean }): void {
    this.shuttingDown = true;
    this.abortController?.abort();
    this.abortController = null;
    for (const unsub of this.unsubs) {
      unsub();
    }
    this.unsubs = [];
    this.client?.stop();
    this.client = null;
    if (this.activeTurn?.resolver) {
      this.activeTurn.resolver(null);
    }
    this.activeTurn = null;
    this.notifyReadyStateChange();
    this.shuttingDown = false;
  }

  isPersistentQueryActive(): boolean {
    return !!this.client?.isRunning() && !!this.sessionManager.getSessionId();
  }

  async *query(
    prompt: string,
    images?: ImageAttachment[],
    conversationHistory?: ChatMessage[],
    queryOptions?: QueryOptions
  ): AsyncGenerator<StreamChunk> {
    const runtime = this.resolveRuntime();
    if (!runtime.ok) {
      yield { type: 'error', content: 'Codex CLI not found. Please install Codex CLI.' };
      return;
    }

    let promptToSend = prompt;
    if (!this.sessionManager.getSessionId() && conversationHistory && conversationHistory.length > 0) {
      const historyContext = buildContextFromHistory(conversationHistory);
      const actualPrompt = stripCurrentNoteContext(prompt);
      promptToSend = buildPromptWithHistoryContext(historyContext, prompt, actualPrompt, conversationHistory);
    }

    await this.ensureReady({
      sessionId: this.sessionManager.getSessionId() ?? undefined,
      externalContextPaths: queryOptions?.externalContextPaths ?? this.currentExternalContextPaths,
      force: queryOptions?.forceColdStart,
    });

    const threadId = this.sessionManager.getSessionId();
    if (!this.client || !threadId) {
      yield { type: 'error', content: 'Failed to start Codex app-server thread.' };
      return;
    }

    this.abortController = new AbortController();
    const activeTurn = createEmptyTurnState(threadId);
    this.activeTurn = activeTurn;

    yield { type: 'sdk_user_uuid', uuid: activeTurn.userUuid };

    const selectedModel = queryOptions?.model || this.plugin.settings.model;
    const thinkingBudget = THINKING_BUDGETS.find((entry) => entry.value === this.plugin.settings.thinkingBudget);

    let turnResponse: { turn: { id: string } };
    try {
      turnResponse = await this.client.request<{ turn: { id: string } }>({
        method: 'turn/start',
        params: {
          threadId,
          input: buildUserInputs(promptToSend, images ?? getLastUserMessage(conversationHistory ?? [])?.images),
          cwd: runtime.vaultPath,
          approvalPolicy: mapPermissionModeToApprovalPolicy(this.plugin.settings.permissionMode),
          sandboxPolicy: mapPermissionModeToSandbox(
            this.plugin.settings.permissionMode,
            runtime.vaultPath,
            queryOptions?.externalContextPaths ?? this.currentExternalContextPaths
          ),
          model: selectedModel,
          effort: isAdaptiveThinkingModel(selectedModel) ? mapEffortLevel(this.plugin.settings.effortLevel) : null,
          summary: thinkingBudget && thinkingBudget.tokens > 0 ? 'auto' : null,
        },
      });
    } catch (error) {
      if (!isThreadNotFoundError(error)) {
        throw error;
      }

      this.sessionManager.reset();
      await this.ensureReady({
        sessionId: undefined,
        externalContextPaths: queryOptions?.externalContextPaths ?? this.currentExternalContextPaths,
        force: true,
      });

      const restartedThreadId = this.sessionManager.getSessionId();
      if (!this.client || !restartedThreadId) {
        yield { type: 'error', content: 'Failed to recreate Codex thread.' };
        return;
      }

      activeTurn.threadId = restartedThreadId;
      turnResponse = await this.client.request<{ turn: { id: string } }>({
        method: 'turn/start',
        params: {
          threadId: restartedThreadId,
          input: buildUserInputs(promptToSend, images ?? getLastUserMessage(conversationHistory ?? [])?.images),
          cwd: runtime.vaultPath,
          approvalPolicy: mapPermissionModeToApprovalPolicy(this.plugin.settings.permissionMode),
          sandboxPolicy: mapPermissionModeToSandbox(
            this.plugin.settings.permissionMode,
            runtime.vaultPath,
            queryOptions?.externalContextPaths ?? this.currentExternalContextPaths
          ),
          model: selectedModel,
          effort: isAdaptiveThinkingModel(selectedModel) ? mapEffortLevel(this.plugin.settings.effortLevel) : null,
          summary: thinkingBudget && thinkingBudget.tokens > 0 ? 'auto' : null,
        },
      });
    }

    activeTurn.turnId = turnResponse.turn.id;
    yield { type: 'sdk_user_sent', uuid: activeTurn.userUuid };

    try {
      while (!activeTurn.done) {
        if (activeTurn.queue.length > 0) {
          yield activeTurn.queue.shift()!;
          continue;
        }

        const next = await new Promise<StreamChunk | null>((resolve) => {
          activeTurn.resolver = resolve;
        });

        if (next) {
          yield next;
        }
      }

      while (activeTurn.queue.length > 0) {
        yield activeTurn.queue.shift()!;
      }

      if (activeTurn.error) {
        yield { type: 'error', content: activeTurn.error.message };
      }
    } finally {
      if (this.activeTurn === activeTurn) {
        this.activeTurn = null;
      }
      this.abortController = null;
    }
  }

  cancel(): void {
    this.approvalDismisser?.();
    this.abortController?.abort();
    this.sessionManager.markInterrupted();

    if (this.client && this.activeTurn?.turnId && this.sessionManager.getSessionId()) {
      void this.client.request({
        method: 'turn/interrupt',
        params: {
          threadId: this.sessionManager.getSessionId()!,
          turnId: this.activeTurn.turnId,
        },
      }).catch(() => {
        // Ignore interruption errors.
      });
    }
  }

  resetSession(): void {
    this.closePersistentQuery('session reset');
    this.sessionManager.reset();
  }

  getSessionId(): string | null {
    return this.sessionManager.getSessionId();
  }

  consumeSessionInvalidation(): boolean {
    return this.sessionManager.consumeInvalidation();
  }

  isReady(): boolean {
    return this.isPersistentQueryActive();
  }

  async getSupportedCommands(): Promise<SlashCommand[]> {
    return [];
  }

  setSessionId(id: string | null, externalContextPaths?: string[]): void {
    this.sessionManager.setSessionId(id, this.plugin.settings.model);
    void this.ensureReady({
      sessionId: id ?? undefined,
      externalContextPaths,
      force: true,
    });
  }

  cleanup(): void {
    this.closePersistentQuery('cleanup');
    this.sessionManager.reset();
  }

  async rewindFiles(_sdkUserUuid: string, dryRun?: boolean): Promise<RewindFilesResult> {
    if (!this.client || !this.sessionManager.getSessionId()) {
      throw new Error('No active query');
    }

    const response = await this.client.request<{ thread: Thread }>({
      method: 'thread/read',
      params: {
        threadId: this.sessionManager.getSessionId()!,
        includeTurns: true,
      },
    });

    const filesChanged = getFileChangesFromThread(response.thread);
    if (!filesChanged.length) {
      return { canRewind: false, error: 'No checkpoint' };
    }

    const diff = this.lastDiffByTurn.get(response.thread.turns[response.thread.turns.length - 1]?.id ?? '');
    const insertions = diff ? diff.split('\n').filter((line) => line.startsWith('+') && !line.startsWith('+++')).length : 0;
    const deletions = diff ? diff.split('\n').filter((line) => line.startsWith('-') && !line.startsWith('---')).length : 0;

    if (dryRun) {
      return { canRewind: true, filesChanged, insertions, deletions };
    }

    return { canRewind: true, filesChanged, insertions, deletions };
  }

  async rewind(sdkUserUuid: string, sdkAssistantUuid: string): Promise<RewindFilesResult> {
    void sdkUserUuid;

    const preview = await this.rewindFiles(sdkUserUuid, true);
    if (!preview.canRewind || !this.client || !this.sessionManager.getSessionId()) {
      return preview;
    }

    const response = await this.client.request<{ thread: Thread }>({
      method: 'thread/rollback',
      params: {
        threadId: this.sessionManager.getSessionId()!,
        numTurns: 1,
      },
    });

    this.pendingResumeAt = sdkAssistantUuid;
    this.sessionManager.captureSession(response.thread.id);
    this.closePersistentQuery('rewind');

    return preview;
  }

  setApprovalCallback(callback: ApprovalCallback | null) {
    this.approvalCallback = callback;
  }

  setApprovalDismisser(dismisser: (() => void) | null) {
    this.approvalDismisser = dismisser;
  }

  setAskUserQuestionCallback(callback: AskUserQuestionCallback | null) {
    this.askUserQuestionCallback = callback;
  }

  setExitPlanModeCallback(callback: ExitPlanModeCallback | null): void {
    this.exitPlanModeCallback = callback;
  }

  setPermissionModeSyncCallback(callback: ((sdkMode: string) => void) | null): void {
    this.permissionModeSyncCallback = callback;
  }

  private async handleNotification(notification: ServerNotification): Promise<void> {
    if (notification.method === 'thread/started') {
      this.sessionManager.captureSession(notification.params.thread.id);
      return;
    }

    if (notification.method === 'turn/started' && this.activeTurn) {
      this.activeTurn.turnId = notification.params.turn.id;
    }

    if (notification.method === 'turn/diff/updated') {
      this.lastDiffByTurn.set(notification.params.turnId, notification.params.diff);
    }

    if (!this.activeTurn) {
      return;
    }

    const activeTurn = this.activeTurn;
    const params = 'params' in notification ? notification.params : undefined;
    const threadId = params && typeof params === 'object' && 'threadId' in params ? (params as { threadId: string }).threadId : null;
    if (threadId && threadId !== activeTurn.threadId) {
      return;
    }

    switch (notification.method) {
      case 'item/started':
        this.handleItemStarted(activeTurn, notification.params.item);
        break;

      case 'item/completed':
        this.handleItemCompleted(activeTurn, notification.params.item);
        break;

      case 'turn/completed':
        if (notification.params.turn.status === 'failed' && notification.params.turn.error) {
          activeTurn.error = new Error(sanitizeTerminalMessage(notification.params.turn.error.message));
        }
        if (notification.params.turn.status === 'interrupted') {
          pushChunk(activeTurn, { type: 'blocked', content: 'Turn interrupted.' });
        }
        activeTurn.assistantUuid = activeTurn.assistantUuid ?? notification.params.turn.id;
        pushChunk(activeTurn, { type: 'sdk_assistant_uuid', uuid: activeTurn.assistantUuid });
        pushChunk(activeTurn, { type: 'done' });
        activeTurn.done = true;
        if (activeTurn.resolver) {
          const resolve = activeTurn.resolver;
          activeTurn.resolver = null;
          resolve(null);
        }
        break;

      default:
        for (const chunk of transformCodexNotification(notification)) {
          if (chunk.type !== 'session_init') {
            pushChunk(activeTurn, chunk);
            if (notification.method === 'item/agentMessage/delta') {
              activeTurn.seenAgentMessageItemIds.add(notification.params.itemId);
            }
          }
        }
    }
  }

  private handleItemStarted(state: ActiveTurnState, item: ThreadItem): void {
    if (item.type === 'commandExecution') {
      pushChunk(state, {
        type: 'tool_use',
        id: item.id,
        name: 'Bash',
        input: { command: item.command, cwd: item.cwd },
      });
      return;
    }

    if (item.type === 'fileChange') {
      pushChunk(state, {
        type: 'tool_use',
        id: item.id,
        name: 'Write',
        input: { changes: item.changes.map((change) => change.path) },
      });
      return;
    }

    if (item.type === 'mcpToolCall' || item.type === 'dynamicToolCall') {
      pushChunk(state, {
        type: 'tool_use',
        id: item.id,
        name: item.type === 'mcpToolCall' ? item.tool : item.tool,
        input: item.type === 'mcpToolCall'
          ? { server: item.server, arguments: item.arguments }
          : (typeof item.arguments === 'object' && item.arguments !== null ? item.arguments as Record<string, unknown> : { arguments: item.arguments }),
      });
    }
  }

  private handleItemCompleted(state: ActiveTurnState, item: ThreadItem): void {
    if (item.type === 'agentMessage') {
      if (!state.seenAgentMessageItemIds.has(item.id) && item.text) {
        pushChunk(state, { type: 'text', content: item.text });
      }
      state.assistantUuid = item.id;
      return;
    }

    if (item.type === 'plan') {
      pushChunk(state, { type: 'thinking', content: item.text });
      return;
    }

    if (item.type === 'reasoning') {
      for (const part of [...item.summary, ...item.content]) {
        pushChunk(state, { type: 'thinking', content: part });
      }
      return;
    }

    if (item.type === 'commandExecution') {
      pushChunk(state, {
        type: 'tool_result',
        id: item.id,
        content: item.aggregatedOutput?.trim() || item.command,
        isError: item.status === 'failed',
      });
      return;
    }

    if (item.type === 'fileChange') {
      pushChunk(state, {
        type: 'tool_result',
        id: item.id,
        content: item.changes.map((change) => `${change.kind}: ${change.path}`).join('\n'),
        isError: item.status === 'failed',
      });
      return;
    }

    if (item.type === 'mcpToolCall') {
      pushChunk(state, {
        type: 'tool_result',
        id: item.id,
        content: item.error ? JSON.stringify(item.error, null, 2) : JSON.stringify(item.result, null, 2),
        isError: !!item.error,
      });
      return;
    }

    if (item.type === 'dynamicToolCall') {
      pushChunk(state, {
        type: 'tool_result',
        id: item.id,
        content: JSON.stringify(item.contentItems, null, 2),
        isError: item.success === false,
      });
    }
  }

  private async handleServerRequest(request: ServerRequest): Promise<void> {
    if (!this.client) {
      return;
    }

    switch (request.method) {
      case 'item/commandExecution/requestApproval': {
        const decision = await this.requestApproval(
          'Bash',
          {
            command: request.params.command,
            cwd: request.params.cwd,
          },
          request.params.reason ?? request.params.command ?? 'Command execution approval required.'
        );
        this.client.respond(request.id, {
          decision: this.mapCommandDecision(decision),
        });
        return;
      }

      case 'item/fileChange/requestApproval': {
        const decision = await this.requestApproval(
          'Write',
          {
            itemId: request.params.itemId,
            grantRoot: request.params.grantRoot,
          },
          request.params.reason ?? 'File change approval required.'
        );
        this.client.respond(request.id, {
          decision: this.mapFileDecision(decision),
        });
        return;
      }

      case 'item/permissions/requestApproval': {
        const decision = await this.requestApproval(
          'Permissions',
          request.params.permissions as unknown as Record<string, unknown>,
          request.params.reason ?? 'Permission approval required.'
        );
        if (decision === 'deny' || decision === 'cancel') {
          this.client.respondError(request.id, -32000, 'Permission request declined');
          return;
        }
        this.client.respond(request.id, {
          permissions: request.params.permissions,
          scope: decision === 'allow-always' ? 'session' : 'turn',
        });
        return;
      }

      case 'item/tool/requestUserInput': {
        if (!this.askUserQuestionCallback) {
          this.client.respondError(request.id, -32000, 'No user input handler available');
          return;
        }

        const answers = await this.askUserQuestionCallback(
          request.params as unknown as Record<string, unknown>,
          this.abortController?.signal
        );

        if (!answers) {
          this.client.respondError(request.id, -32000, 'User declined input request');
          return;
        }

        this.client.respond(request.id, { answers });
        return;
      }

      case 'applyPatchApproval':
      case 'execCommandApproval':
        this.client.respond(request.id, { decision: 'accept' });
        return;

      default:
        this.client.respondError(request.id, -32601, `Unsupported server request: ${request.method}`);
    }
  }

  private async requestApproval(
    toolName: string,
    input: Record<string, unknown>,
    description: string
  ): Promise<ApprovalDecision> {
    if (toolName === TOOL_EXIT_PLAN_MODE && this.exitPlanModeCallback) {
      const result: ExitPlanModeDecision | null = await this.exitPlanModeCallback(input, this.abortController?.signal);
      if (!result) return 'cancel';
      return result.type === 'feedback' ? 'deny' : 'allow';
    }

    if (toolName === TOOL_ASK_USER_QUESTION && this.askUserQuestionCallback) {
      const answers = await this.askUserQuestionCallback(input, this.abortController?.signal);
      return answers ? 'allow' : 'cancel';
    }

    if (!this.approvalCallback) {
      return 'deny';
    }

    const decision = await this.approvalCallback(toolName, input, description);
    if (decision === 'deny' || decision === 'cancel') {
      pushChunk(this.activeTurn, { type: 'blocked', content: `${toolName}: ${description}` });
    }
    return decision;
  }

  private mapCommandDecision(decision: ApprovalDecision) {
    if (decision === 'allow') return 'accept' as const;
    if (decision === 'allow-always') return 'acceptForSession' as const;
    if (decision === 'cancel') return 'cancel' as const;
    return 'decline' as const;
  }

  private mapFileDecision(decision: ApprovalDecision): FileChangeApprovalDecision {
    if (decision === 'allow') return 'accept';
    if (decision === 'allow-always') return 'acceptForSession';
    if (decision === 'cancel') return 'cancel';
    return 'decline';
  }
}
