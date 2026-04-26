import type { ServerNotification } from '../../../../generated/ServerNotification';

const mockClients: MockCodexAppServerClient[] = [];

class MockCodexAppServerClient {
  start = jest.fn();
  stop = jest.fn();
  respond = jest.fn();
  respondError = jest.fn();
  isRunning = jest.fn(() => true);
  request = jest.fn(async (payload: { method: string; params?: Record<string, unknown> }) => {
    switch (payload.method) {
      case 'initialize':
        return {};
      case 'thread/start':
        return { thread: { id: 'thread-started', turns: [] } };
      case 'thread/resume':
        return { thread: { id: payload.params?.threadId ?? 'thread-resumed', turns: [] } };
      case 'thread/fork':
        return { thread: { id: 'thread-forked', turns: [] } };
      case 'turn/start':
        return { turn: { id: 'turn-1' } };
      case 'thread/read':
        return { thread: { id: 'thread-started', turns: [] } };
      case 'thread/rollback':
        return { thread: { id: 'thread-started', turns: [] } };
      default:
        return {};
    }
  });

  private notificationListeners = new Set<(notification: ServerNotification) => void>();

  constructor() {
    mockClients.push(this);
  }

  onNotification(listener: (notification: ServerNotification) => void) {
    this.notificationListeners.add(listener);
    return () => this.notificationListeners.delete(listener);
  }

  onRequest() {
    return () => {};
  }

  onStderr() {
    return () => {};
  }

  emitNotification(notification: ServerNotification) {
    for (const listener of this.notificationListeners) {
      listener(notification);
    }
  }
}

jest.mock('@/core/agent/CodexAppServerClient', () => ({
  CodexAppServerClient: MockCodexAppServerClient,
}));

import { CodexService } from '@/core/agent/CodexService';

function createPlugin(overrides: Record<string, unknown> = {}) {
  return {
    manifest: { version: '1.0.0' },
    settings: {
      model: 'gpt-5.4',
      permissionMode: 'normal',
      thinkingBudget: 'off',
      blockedCommands: { unix: [], windows: [] },
      enableBlocklist: false,
      allowExternalAccess: false,
      mediaFolder: '',
      systemPrompt: '',
      allowedExportPaths: [],
      loadUserCodexSettings: false,
      userName: '',
      effortLevel: 'medium',
      ...overrides,
    },
    app: {
      vault: {
        adapter: {
          basePath: '/test/vault/path',
        },
      },
    },
    storage: {
      getPermissions: jest.fn().mockResolvedValue({ allow: [], deny: [], ask: [] }),
      addAllowRule: jest.fn().mockResolvedValue(undefined),
      addDenyRule: jest.fn().mockResolvedValue(undefined),
    },
    saveSettings: jest.fn().mockResolvedValue(undefined),
    getActiveEnvironmentVariables: jest.fn().mockReturnValue(''),
    getResolvedCodexCliPath: jest.fn().mockReturnValue('/mock/codex'),
    getView: jest.fn().mockReturnValue(null),
    pluginManager: {
      getPluginsKey: jest.fn().mockReturnValue(''),
      hasEnabledPlugins: jest.fn().mockReturnValue(false),
    },
  } as any;
}

function createMcpManager() {
  return {
    loadServers: jest.fn().mockResolvedValue(undefined),
    getServers: jest.fn().mockReturnValue([]),
    getEnabledCount: jest.fn().mockReturnValue(0),
    getActiveServers: jest.fn().mockReturnValue({}),
    getDisallowedMcpTools: jest.fn().mockReturnValue([]),
    getAllDisallowedMcpTools: jest.fn().mockReturnValue([]),
    hasServers: jest.fn().mockReturnValue(false),
  } as any;
}

async function collectChunks(gen: AsyncGenerator<any>) {
  const chunks: any[] = [];
  for await (const chunk of gen) {
    chunks.push(chunk);
  }
  return chunks;
}

async function waitFor(predicate: () => boolean, timeoutMs = 1000) {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error('Timed out waiting for condition');
    }
    await new Promise(resolve => setTimeout(resolve, 0));
  }
}

function getClient() {
  const client = mockClients.at(-1);
  if (!client) throw new Error('Missing Codex client');
  return client;
}

describe('CodexService integration', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockClients.length = 0;
  });

  it('resumes an existing thread via app-server', async () => {
    const service = new CodexService(createPlugin(), createMcpManager());
    service.setSessionId('thread-existing');
    await Promise.resolve();

    const client = getClient();
    expect(client.request).toHaveBeenCalledWith(
      expect.objectContaining({
        method: 'thread/resume',
        params: expect.objectContaining({ threadId: 'thread-existing' }),
      })
    );
  });

  it('forks a thread when fork state is pending', async () => {
    const service = new CodexService(createPlugin(), createMcpManager());
    const forkSessionId = service.applyForkState({
      sessionId: null as any,
      sdkSessionId: null as any,
      forkSource: { sessionId: 'thread-parent', resumeAt: 'assistant-1' },
    });

    await service.ensureReady({ sessionId: forkSessionId ?? undefined });

    const client = getClient();
    expect(client.request).toHaveBeenCalledWith(
      expect.objectContaining({
        method: 'thread/fork',
        params: expect.objectContaining({ threadId: 'thread-parent' }),
      })
    );
  });

  it('routes stderr lines into streamed error chunks', async () => {
    const service = new CodexService(createPlugin(), createMcpManager());
    const streamPromise = collectChunks(service.query('hello'));
    await waitFor(() => getClient().request.mock.calls.some(([payload]) => payload.method === 'turn/start'));

    const client = getClient();
    client.emitNotification({
      method: 'turn/started',
      params: { threadId: 'thread-started', turn: { id: 'turn-1' } },
    } as unknown as ServerNotification);
    client.emitNotification({
      method: 'turn/completed',
      params: {
        threadId: 'thread-started',
        turn: { id: 'turn-1', status: 'completed' },
      },
    } as unknown as ServerNotification);

    const chunks = await streamPromise;
    expect(chunks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: 'sdk_user_uuid' }),
        expect.objectContaining({ type: 'done' }),
      ])
    );
  });

  it('returns a Codex-specific error when the CLI is unavailable', async () => {
    const service = new CodexService(
      createPlugin(),
      createMcpManager()
    );
    (service as any).plugin.getResolvedCodexCliPath.mockReturnValue(null);

    const chunks = await collectChunks(service.query('hello'));

    expect(chunks).toContainEqual({
      type: 'error',
      content: 'Codex CLI not found. Please install Codex CLI.',
    });
  });
});
