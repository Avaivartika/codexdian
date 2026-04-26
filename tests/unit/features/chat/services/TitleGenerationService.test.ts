import { runCodexTextQuery } from '@/core/agent/CodexTextService';
import { type TitleGenerationResult, TitleGenerationService } from '@/features/chat/services/TitleGenerationService';

jest.mock('@/core/agent/CodexTextService', () => ({
  runCodexTextQuery: jest.fn(),
}));

const runCodexTextQueryMock = runCodexTextQuery as jest.MockedFunction<typeof runCodexTextQuery>;

function createMockPlugin(settings = {}) {
  return {
    settings: {
      model: 'gpt-5.4',
      titleGenerationModel: '',
      thinkingBudget: 'off',
      effortLevel: 'medium',
      loadUserCodexSettings: false,
      ...settings,
    },
    app: {
      vault: {
        adapter: {
          basePath: '/test/vault/path',
        },
      },
    },
    getActiveEnvironmentVariables: jest.fn().mockReturnValue(''),
    getResolvedCodexCliPath: jest.fn().mockReturnValue('/fake/codex'),
  } as any;
}

describe('TitleGenerationService', () => {
  let service: TitleGenerationService;
  let mockPlugin: any;

  beforeEach(() => {
    jest.clearAllMocks();
    mockPlugin = createMockPlugin();
    service = new TitleGenerationService(mockPlugin);
    runCodexTextQueryMock.mockResolvedValue({ text: 'Setting Up React Project', threadId: 'thread-1' });
  });

  describe('generateTitle', () => {
    it('should generate a title from user message', async () => {
      const callback = jest.fn();
      await service.generateTitle('conv-123', 'How do I set up a React project?', callback);

      expect(callback).toHaveBeenCalledWith('conv-123', {
        success: true,
        title: 'Setting Up React Project',
      } satisfies TitleGenerationResult);
    });

    it('should use titleGenerationModel setting when set', async () => {
      mockPlugin.settings.titleGenerationModel = 'gpt-5.2';

      const callback = jest.fn();
      await service.generateTitle('conv-123', 'test', callback);

      expect(runCodexTextQueryMock).toHaveBeenCalledWith(expect.objectContaining({
        model: 'gpt-5.2',
        cliPath: '/fake/codex',
        cwd: '/test/vault/path',
      }));
    });

    it('should prioritize setting over env var', async () => {
      mockPlugin.settings.titleGenerationModel = 'gpt-5.2';
      mockPlugin.getActiveEnvironmentVariables.mockReturnValue('OPENAI_DEFAULT_MODEL=gpt-5.1-codex-mini');

      const callback = jest.fn();
      await service.generateTitle('conv-123', 'test', callback);

      expect(runCodexTextQueryMock).toHaveBeenCalledWith(expect.objectContaining({
        model: 'gpt-5.2',
      }));
    });

    it('should use environment fallback model when setting is empty', async () => {
      mockPlugin.getActiveEnvironmentVariables.mockReturnValue('OPENAI_DEFAULT_MODEL=gpt-5.1-codex-mini');

      const callback = jest.fn();
      await service.generateTitle('conv-123', 'test', callback);

      expect(runCodexTextQueryMock).toHaveBeenCalledWith(expect.objectContaining({
        model: 'gpt-5.1-codex-mini',
      }));
    });

    it('should fallback to fast Codex default model', async () => {
      const callback = jest.fn();
      await service.generateTitle('conv-123', 'test', callback);

      expect(runCodexTextQueryMock).toHaveBeenCalledWith(expect.objectContaining({
        model: 'gpt-5.1-codex-mini',
      }));
    });

    it('should strip surrounding quotes from title', async () => {
      runCodexTextQueryMock.mockResolvedValueOnce({ text: '"Quoted Title"', threadId: 'thread-1' });

      const callback = jest.fn();
      await service.generateTitle('conv-123', 'test', callback);

      expect(callback).toHaveBeenCalledWith('conv-123', {
        success: true,
        title: 'Quoted Title',
      });
    });

    it('should strip trailing punctuation from title', async () => {
      runCodexTextQueryMock.mockResolvedValueOnce({ text: 'Title With Punctuation...', threadId: 'thread-1' });

      const callback = jest.fn();
      await service.generateTitle('conv-123', 'test', callback);

      expect(callback).toHaveBeenCalledWith('conv-123', {
        success: true,
        title: 'Title With Punctuation',
      });
    });

    it('should truncate titles longer than 50 characters', async () => {
      runCodexTextQueryMock.mockResolvedValueOnce({ text: 'A'.repeat(60), threadId: 'thread-1' });

      const callback = jest.fn();
      await service.generateTitle('conv-123', 'test', callback);

      expect(callback).toHaveBeenCalledWith('conv-123', {
        success: true,
        title: 'A'.repeat(47) + '...',
      });
    });

    it('should fail gracefully when response is empty', async () => {
      runCodexTextQueryMock.mockResolvedValueOnce({ text: '', threadId: 'thread-1' });

      const callback = jest.fn();
      await service.generateTitle('conv-123', 'test', callback);

      expect(callback).toHaveBeenCalledWith('conv-123', {
        success: false,
        error: 'Failed to parse title from response',
      });
    });

    it('should fail when vault path cannot be determined', async () => {
      mockPlugin.app.vault.adapter.basePath = undefined;

      const callback = jest.fn();
      await service.generateTitle('conv-123', 'test', callback);

      expect(callback).toHaveBeenCalledWith('conv-123', {
        success: false,
        error: 'Could not determine vault path',
      });
      expect(runCodexTextQueryMock).not.toHaveBeenCalled();
    });

    it('should fail when Codex CLI is not found', async () => {
      mockPlugin.getResolvedCodexCliPath.mockReturnValue(null);

      const callback = jest.fn();
      await service.generateTitle('conv-123', 'test', callback);

      expect(callback).toHaveBeenCalledWith('conv-123', {
        success: false,
        error: 'Codex CLI not found',
      });
      expect(runCodexTextQueryMock).not.toHaveBeenCalled();
    });

    it('should forward Codex query errors', async () => {
      runCodexTextQueryMock.mockRejectedValueOnce(new Error('Cancelled'));

      const callback = jest.fn();
      await service.generateTitle('conv-123', 'test', callback);

      expect(callback).toHaveBeenCalledWith('conv-123', {
        success: false,
        error: 'Cancelled',
      });
    });

    it('should truncate long user messages before sending them', async () => {
      const callback = jest.fn();
      await service.generateTitle('conv-123', 'x'.repeat(1000), callback);

      const prompt = runCodexTextQueryMock.mock.calls[0]?.[0].prompt;
      expect(prompt).toContain('...');
    });
  });

  describe('concurrent generation', () => {
    it('should support multiple concurrent generations', async () => {
      runCodexTextQueryMock
        .mockResolvedValueOnce({ text: 'Title 1', threadId: 'thread-1' })
        .mockResolvedValueOnce({ text: 'Title 2', threadId: 'thread-2' });

      const callback1 = jest.fn();
      const callback2 = jest.fn();

      await Promise.all([
        service.generateTitle('conv-1', 'msg1', callback1),
        service.generateTitle('conv-2', 'msg2', callback2),
      ]);

      expect(callback1).toHaveBeenCalledWith('conv-1', { success: true, title: 'Title 1' });
      expect(callback2).toHaveBeenCalledWith('conv-2', { success: true, title: 'Title 2' });
    });
  });
});
