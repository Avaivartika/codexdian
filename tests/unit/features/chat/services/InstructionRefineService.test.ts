import { runCodexTextQuery } from '@/core/agent/CodexTextService';
import { InstructionRefineService } from '@/features/chat/services/InstructionRefineService';

jest.mock('@/core/agent/CodexTextService', () => ({
  runCodexTextQuery: jest.fn(),
}));

const runCodexTextQueryMock = runCodexTextQuery as jest.MockedFunction<typeof runCodexTextQuery>;

function createMockPlugin(settings = {}) {
  return {
    settings: {
      model: 'gpt-5.4',
      thinkingBudget: 'off',
      effortLevel: 'medium',
      systemPrompt: '',
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

describe('InstructionRefineService', () => {
  let service: InstructionRefineService;
  let mockPlugin: any;

  beforeEach(() => {
    jest.clearAllMocks();
    mockPlugin = createMockPlugin();
    service = new InstructionRefineService(mockPlugin);
    runCodexTextQueryMock.mockResolvedValue({
      text: '<instruction>- Be concise.</instruction>',
      threadId: 'thread-1',
    });
  });

  describe('refineInstruction', () => {
    it('should parse refined instructions from instruction tags', async () => {
      const result = await service.refineInstruction('be concise', '');

      expect(result).toEqual({
        success: true,
        refinedInstruction: '- Be concise.',
      });
    });

    it('should include existing instructions in the system prompt', async () => {
      const existing = '## Existing\n\n- Keep it short.';

      await service.refineInstruction('coding style', existing);

      expect(runCodexTextQueryMock).toHaveBeenCalledWith(expect.objectContaining({
        cliPath: '/fake/codex',
        cwd: '/test/vault/path',
        systemPrompt: expect.stringContaining(existing),
        prompt: 'Please refine this instruction: "coding style"',
      }));
    });

    it('should return clarification when no instruction tag is present', async () => {
      runCodexTextQueryMock.mockResolvedValueOnce({
        text: 'Could you clarify what you mean by concise?',
        threadId: 'thread-1',
      });

      const result = await service.refineInstruction('be concise', '');

      expect(result).toEqual({
        success: true,
        clarification: 'Could you clarify what you mean by concise?',
      });
    });

    it('should return error for empty response', async () => {
      runCodexTextQueryMock.mockResolvedValueOnce({
        text: '',
        threadId: 'thread-1',
      });

      const result = await service.refineInstruction('be concise', '');

      expect(result).toEqual({
        success: false,
        error: 'Empty response',
      });
    });

    it('should call onProgress with parsed partial results', async () => {
      runCodexTextQueryMock.mockImplementationOnce(async (options) => {
        options.onTextDelta?.('<instruction>- Be');
        options.onTextDelta?.('<instruction>- Be brief.</instruction>');
        return {
          text: '<instruction>- Be brief.</instruction>',
          threadId: 'thread-1',
        };
      });

      const onProgress = jest.fn();
      await service.refineInstruction('be concise', '', onProgress);

      expect(onProgress).toHaveBeenCalledWith({
        success: true,
        clarification: '<instruction>- Be',
      });
      expect(onProgress).toHaveBeenCalledWith({
        success: true,
        refinedInstruction: '- Be brief.',
      });
    });

    it('should pass model and thinking settings to Codex query', async () => {
      mockPlugin.settings.model = 'gpt-5.1-codex-mini';
      mockPlugin.settings.thinkingBudget = 'medium';
      mockPlugin.settings.effortLevel = 'high';

      await service.refineInstruction('test', '');

      expect(runCodexTextQueryMock).toHaveBeenCalledWith(expect.objectContaining({
        model: 'gpt-5.1-codex-mini',
        thinkingBudget: 'medium',
        effortLevel: 'high',
      }));
    });

    it('should fail when vault path cannot be determined', async () => {
      mockPlugin.app.vault.adapter.basePath = undefined;

      const result = await service.refineInstruction('be concise', '');

      expect(result).toEqual({
        success: false,
        error: 'Could not determine vault path',
      });
      expect(runCodexTextQueryMock).not.toHaveBeenCalled();
    });

    it('should fail when Codex CLI is not found', async () => {
      mockPlugin.getResolvedCodexCliPath.mockReturnValue(null);

      const result = await service.refineInstruction('be concise', '');

      expect(result).toEqual({
        success: false,
        error: 'Codex CLI not found. Please install Codex CLI.',
      });
      expect(runCodexTextQueryMock).not.toHaveBeenCalled();
    });

    it('should forward Codex query errors', async () => {
      runCodexTextQueryMock.mockRejectedValueOnce(new Error('Cancelled'));

      const result = await service.refineInstruction('be concise', '');

      expect(result).toEqual({
        success: false,
        error: 'Cancelled',
      });
    });
  });

  describe('continueConversation', () => {
    it('should reuse the previous thread id on follow-up prompts', async () => {
      runCodexTextQueryMock
        .mockResolvedValueOnce({
          text: 'Could you clarify what tone you want?',
          threadId: 'thread-1',
        })
        .mockResolvedValueOnce({
          text: '<instruction>- Be concise and friendly.</instruction>',
          threadId: 'thread-1',
        });

      const first = await service.refineInstruction('be concise', '');
      const second = await service.continueConversation('friendly tone');

      expect(first.success).toBe(true);
      expect(second).toEqual({
        success: true,
        refinedInstruction: '- Be concise and friendly.',
      });
      expect(runCodexTextQueryMock.mock.calls[1]?.[0]).toEqual(expect.objectContaining({
        resumeThreadId: 'thread-1',
      }));
    });

    it('should return an error when there is no active conversation', async () => {
      const result = await service.continueConversation('follow up');

      expect(result).toEqual({
        success: false,
        error: 'No active conversation to continue',
      });
    });

    it('should reset conversation state when requested', async () => {
      await service.refineInstruction('be concise', '');
      service.resetConversation();

      const result = await service.continueConversation('follow up');

      expect(result).toEqual({
        success: false,
        error: 'No active conversation to continue',
      });
    });
  });
});
