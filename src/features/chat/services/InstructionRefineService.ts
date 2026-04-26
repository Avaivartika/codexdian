import { runCodexTextQuery } from '../../../core/agent/CodexTextService';
import { buildRefineSystemPrompt } from '../../../core/prompts/instructionRefine';
import { type InstructionRefineResult } from '../../../core/types';
import type CodexdianPlugin from '../../../main';
import { getEnhancedPath, getMissingNodeError, parseEnvironmentVariables } from '../../../utils/env';
import { getVaultPath } from '../../../utils/path';

export type RefineProgressCallback = (update: InstructionRefineResult) => void;

export class InstructionRefineService {
  private plugin: CodexdianPlugin;
  private abortController: AbortController | null = null;
  private sessionId: string | null = null;
  private existingInstructions: string = '';

  constructor(plugin: CodexdianPlugin) {
    this.plugin = plugin;
  }

  /** Resets conversation state for a new refinement session. */
  resetConversation(): void {
    this.sessionId = null;
  }

  /** Refines a raw instruction from user input. */
  async refineInstruction(
    rawInstruction: string,
    existingInstructions: string,
    onProgress?: RefineProgressCallback
  ): Promise<InstructionRefineResult> {
    this.sessionId = null;
    this.existingInstructions = existingInstructions;
    const prompt = `Please refine this instruction: "${rawInstruction}"`;
    return this.sendMessage(prompt, onProgress);
  }

  /** Continues conversation with a follow-up message (for clarifications). */
  async continueConversation(
    message: string,
    onProgress?: RefineProgressCallback
  ): Promise<InstructionRefineResult> {
    if (!this.sessionId) {
      return { success: false, error: 'No active conversation to continue' };
    }
    return this.sendMessage(message, onProgress);
  }

  /** Cancels any ongoing query. */
  cancel(): void {
    if (this.abortController) {
      this.abortController.abort();
      this.abortController = null;
    }
  }

  private async sendMessage(
    prompt: string,
    onProgress?: RefineProgressCallback
  ): Promise<InstructionRefineResult> {
    const vaultPath = getVaultPath(this.plugin.app);
    if (!vaultPath) {
      return { success: false, error: 'Could not determine vault path' };
    }

    const resolvedCodexPath = this.plugin.getResolvedCodexCliPath();
    if (!resolvedCodexPath) {
      return { success: false, error: 'Codex CLI not found. Please install Codex CLI.' };
    }

    this.abortController = new AbortController();

    // Parse custom environment variables
    const customEnv = parseEnvironmentVariables(this.plugin.getActiveEnvironmentVariables());
    const enhancedPath = getEnhancedPath(customEnv.PATH, resolvedCodexPath);
    const missingNodeError = getMissingNodeError(resolvedCodexPath, enhancedPath);
    if (missingNodeError) {
      return { success: false, error: missingNodeError };
    }

    try {
      const result = await runCodexTextQuery({
        cliPath: resolvedCodexPath,
        cwd: vaultPath,
        env: {
          ...process.env,
          ...customEnv,
          PATH: enhancedPath,
        },
        model: this.plugin.settings.model,
        systemPrompt: buildRefineSystemPrompt(this.existingInstructions),
        prompt,
        effortLevel: this.plugin.settings.effortLevel,
        thinkingBudget: this.plugin.settings.thinkingBudget,
        resumeThreadId: this.sessionId,
        signal: this.abortController.signal,
        onTextDelta: (text) => {
          if (onProgress) {
            const partialResult = this.parseResponse(text);
            onProgress(partialResult);
          }
        },
      });

      this.sessionId = result.threadId;
      return this.parseResponse(result.text);
    } catch (error) {
      const msg = error instanceof Error ? error.message : 'Unknown error';
      return { success: false, error: msg };
    } finally {
      this.abortController = null;
    }
  }

  /** Parses response text for <instruction> tag. */
  private parseResponse(responseText: string): InstructionRefineResult {
    const instructionMatch = responseText.match(/<instruction>([\s\S]*?)<\/instruction>/);
    if (instructionMatch) {
      return { success: true, refinedInstruction: instructionMatch[1].trim() };
    }

    // No instruction tag - treat as clarification question
    const trimmed = responseText.trim();
    if (trimmed) {
      return { success: true, clarification: trimmed };
    }

    return { success: false, error: 'Empty response' };
  }
}
