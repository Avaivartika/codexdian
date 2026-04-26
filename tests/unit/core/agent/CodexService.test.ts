import type { ServerNotification } from '../../../../generated/ServerNotification';
import type { ServerRequest } from '../../../../generated/ServerRequest';

const mockClients: MockCodexAppServerClient[] = [];

class MockCodexAppServerClient {
  start = jest.fn();
  stop = jest.fn();
  respond = jest.fn();
  respondError = jest.fn();
  isRunning = jest.fn(() => true);
  request = jest.fn(async (payload: { method: string }) => {
    switch (payload.method) {
      case 'initialize':
        return {};
      case 'thread/start':
      case 'thread/resume':
      case 'thread/fork':
        return { thread: { id: 'thread-1', turns: [] } };
      case 'turn/start':
        return { turn: { id: 'turn-1' } };
      case 'thread/read':
        return {
          thread: {
            id: 'thread-1',
            turns: [
              {
                id: 'turn-1',
                items: [
                  {
                    id: 'file-1',
                    type: 'fileChange',
                    changes: [{ path: 'foo.md', kind: 'updated' }],
                    status: 'completed',
                  },
                ],
              },
            ],
          },
        };
      case 'thread/rollback':
        return { thread: { id: 'thread-1', turns: [] } };
      default:
        return {};
    }
  });

  private notificationListeners = new Set<(notification: ServerNotification) => void>();
  private requestListeners = new Set<(request: ServerRequest) => void>();
  private stderrListeners = new Set<(line: string) => void>();

  constructor() {
    mockClients.push(this);
  }

  onNotification(listener: (notification: ServerNotification) => void) {
    this.notificationListeners.add(listener);
    return () => this.notificationListeners.delete(listener);
  }

  onRequest(listener: (request: ServerRequest) => void) {
    this.requestListeners.add(listener);
    return () => this.requestListeners.delete(listener);
  }

  onStderr(listener: (line: string) => void) {
    this.stderrListeners.add(listener);
    return () => this.stderrListeners.delete(listener);
  }

  emitNotification(notification: ServerNotification) {
    for (const listener of this.notificationListeners) {
      listener(notification);
    }
  }

  async emitRequest(request: ServerRequest) {
    await Promise.all(Array.from(this.requestListeners, listener => listener(request)));
  }

  emitStderr(line: string) {
    for (const listener of this.stderrListeners) {
      listener(line);
    }
  }
}

jest.mock('@/core/agent/CodexAppServerClient', () => ({
  CodexAppServerClient: MockCodexAppServerClient,
}));

import { CodexService } from '@/core/agent/CodexService';
import type { McpServerManager } from '@/core/mcp';
import type { ChatMessage } from '@/core/types';
import type CodexdianPlugin from '@/main';

type MockMcpServerManager = jest.Mocked<McpServerManager>;

function createMockPlugin(overrides: Partial<CodexdianPlugin['settings']> = {}): CodexdianPlugin {
  return {
    app: {
      vault: { adapter: { basePath: '/mock/vault' } },
    },
    manifest: { version: '1.0.0' },
    storage: {
      addDenyRule: jest.fn().mockResolvedValue(undefined),
      addAllowRule: jest.fn().mockResolvedValue(undefined),
      getPermissions: jest.fn().mockResolvedValue({ allow: [], deny: [], ask: [] }),
    },
    settings: {
      model: 'gpt-5.4',
      permissionMode: 'normal',
      thinkingBudget: 'off',
      blockedCommands: { unix: [], windows: [] },
      enableBlocklist: false,
      allowExternalAccess: false,
      mediaFolder: 'media',
      systemPrompt: '',
      allowedExportPaths: [],
      loadUserCodexSettings: false,
      codexCliPath: '/usr/local/bin/codex',
      codexCliPathsByHost: {},
      enableAutoTitleGeneration: true,
      titleGenerationModel: 'gpt-5.4',
      userName: '',
      effortLevel: 'medium',
      ...overrides,
    },
    getResolvedCodexCliPath: jest.fn().mockReturnValue('/usr/local/bin/codex'),
    getActiveEnvironmentVariables: jest.fn().mockReturnValue(''),
    pluginManager: {
      getPluginsKey: jest.fn().mockReturnValue(''),
    },
  } as unknown as CodexdianPlugin;
}

function createMockMcpManager(): MockMcpServerManager {
  return {
    loadServers: jest.fn().mockResolvedValue(undefined),
    getAllDisallowedMcpTools: jest.fn().mockReturnValue([]),
    getActiveServers: jest.fn().mockReturnValue({}),
    getDisallowedMcpTools: jest.fn().mockReturnValue([]),
  } as unknown as MockMcpServerManager;
}

async function collectChunks(generator: AsyncGenerator<unknown>): Promise<unknown[]> {
  const chunks: unknown[] = [];
  for await (const chunk of generator) {
    chunks.push(chunk);
  }
  return chunks;
}

async function waitFor(predicate: () => boolean, timeoutMs = 1000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error('Timed out waiting for condition');
    }
    await new Promise(resolve => setTimeout(resolve, 0));
  }
}

function getClient(): MockCodexAppServerClient {
  const client = mockClients.at(-1);
  if (!client) {
    throw new Error('Expected Codex client instance');
  }
  return client;
}

describe('CodexService', () => {
  let service: CodexService;
  let plugin: CodexdianPlugin;
  let mcpManager: MockMcpServerManager;

  beforeEach(() => {
    jest.clearAllMocks();
    mockClients.length = 0;
    plugin = createMockPlugin();
    mcpManager = createMockMcpManager();
    service = new CodexService(plugin, mcpManager);
  });

  afterEach(() => {
    service.cleanup();
  });

  it('starts Codex app-server and initializes a thread', async () => {
    const ready = await service.ensureReady();

    expect(ready).toBe(true);

    const client = getClient();
    expect(client.start).toHaveBeenCalledWith('/usr/local/bin/codex', '/mock/vault', expect.any(Object));
    expect(client.request).toHaveBeenNthCalledWith(1, expect.objectContaining({ method: 'initialize' }));
    expect(client.request).toHaveBeenNthCalledWith(2, expect.objectContaining({ method: 'thread/start' }));
    expect(service.getSessionId()).toBe('thread-1');
  });

  it('streams turn output from Codex notifications', async () => {
    const streamPromise = collectChunks(service.query('hello'));
    await waitFor(() => getClient().request.mock.calls.some(([payload]) => payload.method === 'turn/start'));

    const client = getClient();
    client.emitNotification({
      method: 'turn/started',
      params: { threadId: 'thread-1', turn: { id: 'turn-1' } },
    } as unknown as ServerNotification);
    client.emitNotification({
      method: 'item/agentMessage/delta',
      params: { threadId: 'thread-1', itemId: 'msg-1', delta: 'Hello from Codex' },
    } as unknown as ServerNotification);
    client.emitNotification({
      method: 'turn/completed',
      params: {
        threadId: 'thread-1',
        turn: { id: 'turn-1', status: 'completed' },
      },
    } as unknown as ServerNotification);

    const chunks = await streamPromise;
    expect(chunks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: 'sdk_user_uuid' }),
        expect.objectContaining({ type: 'sdk_user_sent' }),
        { type: 'text', content: 'Hello from Codex' },
        { type: 'done' },
      ])
    );
  });

  it('interrupts the active turn on cancel', async () => {
    const streamPromise = collectChunks(service.query('hello'));
    await waitFor(() => getClient().request.mock.calls.some(([payload]) => payload.method === 'turn/start'));
    const client = getClient();
    client.emitNotification({
      method: 'turn/started',
      params: { threadId: 'thread-1', turn: { id: 'turn-1' } },
    } as unknown as ServerNotification);

    service.cancel();

    expect(client.request).toHaveBeenCalledWith(
      expect.objectContaining({
        method: 'turn/interrupt',
        params: expect.objectContaining({
          threadId: 'thread-1',
          turnId: 'turn-1',
        }),
      })
    );

    client.emitNotification({
      method: 'turn/completed',
      params: {
        threadId: 'thread-1',
        turn: { id: 'turn-1', status: 'interrupted' },
      },
    } as unknown as ServerNotification);

    await streamPromise;
  });

  it('rebuilds prompt context from history when starting a fresh thread', async () => {
    const history: ChatMessage[] = [
      { id: 'u1', role: 'user', content: 'Previous question', timestamp: Date.now() - 1000 },
      { id: 'a1', role: 'assistant', content: 'Previous answer', timestamp: Date.now() },
    ];

    const streamPromise = collectChunks(service.query('Follow up', undefined, history));
    await waitFor(() => getClient().request.mock.calls.some(([payload]) => payload.method === 'turn/start'));

    const client = getClient();
    const turnStartCall = client.request.mock.calls.find(
      ([payload]) => payload.method === 'turn/start'
    )?.[0] as { method: string; params: { input: unknown } } | undefined;

    expect(turnStartCall).toBeDefined();
    const turnStartInput = JSON.stringify(turnStartCall?.params.input);
    expect(turnStartInput).toContain('Previous question');
    expect(turnStartInput).toContain('Previous answer');

    client.emitNotification({
      method: 'turn/completed',
      params: {
        threadId: 'thread-1',
        turn: { id: 'turn-1', status: 'completed' },
      },
    } as unknown as ServerNotification);

    await streamPromise;
  });

  it('maps approval requests back to Codex app-server decisions', async () => {
    service.setApprovalCallback(async () => 'allow-always');
    await service.ensureReady();

    const client = getClient();
    await client.emitRequest({
      id: 1,
      method: 'item/commandExecution/requestApproval',
      params: {
        command: 'rm test.txt',
        cwd: '/mock/vault',
        reason: 'Need to delete a file',
      },
    } as unknown as ServerRequest);

    expect(client.respond).toHaveBeenCalledWith(1, { decision: 'acceptForSession' });
  });

  it('rewinds through thread/rollback after reading file changes', async () => {
    await service.ensureReady();

    const result = await service.rewind('user-1', 'assistant-1');
    const client = getClient();

    expect(result.canRewind).toBe(true);
    expect(result.filesChanged).toEqual(['foo.md']);
    expect(client.request).toHaveBeenCalledWith(
      expect.objectContaining({ method: 'thread/read' })
    );
    expect(client.request).toHaveBeenCalledWith(
      expect.objectContaining({ method: 'thread/rollback' })
    );
  });
});
