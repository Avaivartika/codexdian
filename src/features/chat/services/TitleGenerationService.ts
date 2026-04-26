import { runCodexTextQuery } from '../../../core/agent/CodexTextService';
import { TITLE_GENERATION_SYSTEM_PROMPT } from '../../../core/prompts/titleGeneration';
import type CodexdianPlugin from '../../../main';
import {
  getCurrentModelFromEnvironment,
  getEnhancedPath,
  getMissingNodeError,
  parseEnvironmentVariables,
} from '../../../utils/env';
import { getVaultPath } from '../../../utils/path';

export type TitleGenerationResult =
  | { success: true; title: string }
  | { success: false; error: string };

export type TitleGenerationCallback = (
  conversationId: string,
  result: TitleGenerationResult
) => Promise<void>;

export class TitleGenerationService {
  private plugin: CodexdianPlugin;
  private activeGenerations: Map<string, AbortController> = new Map();

  constructor(plugin: CodexdianPlugin) {
    this.plugin = plugin;
  }

  /**
   * Generates a title for a conversation based on the first user message.
   * Non-blocking: calls callback when complete.
   */
  async generateTitle(
    conversationId: string,
    userMessage: string,
    callback: TitleGenerationCallback
  ): Promise<void> {
    const vaultPath = getVaultPath(this.plugin.app);
    if (!vaultPath) {
      await this.safeCallback(callback, conversationId, {
        success: false,
        error: 'Could not determine vault path',
      });
      return;
    }

    const envVars = parseEnvironmentVariables(
      this.plugin.getActiveEnvironmentVariables()
    );

    const resolvedCodexPath = this.plugin.getResolvedCodexCliPath();
    if (!resolvedCodexPath) {
      await this.safeCallback(callback, conversationId, {
        success: false,
        error: 'Codex CLI not found',
      });
      return;
    }
    const enhancedPath = getEnhancedPath(envVars.PATH, resolvedCodexPath);
    const missingNodeError = getMissingNodeError(resolvedCodexPath, enhancedPath);
    if (missingNodeError) {
      await this.safeCallback(callback, conversationId, {
        success: false,
        error: missingNodeError,
      });
      return;
    }

    // Get the appropriate model with fallback chain:
    // 1. User's titleGenerationModel setting (if set)
    // 2. Explicit OPENAI/Codex model env vars
    // 3. Backward-compatible env aliases
    // 4. Fast Codex default
    const envPreferredModel = getCurrentModelFromEnvironment(envVars);
    const titleModel =
      this.plugin.settings.titleGenerationModel ||
      envVars.OPENAI_DEFAULT_MODEL ||
      envVars.OPENAI_MODEL ||
      envVars.CODEX_MODEL ||
      envVars.CODEX_DEFAULT_GPT51_MINI_MODEL ||
      envPreferredModel ||
      'gpt-5.1-codex-mini';

    // Cancel any existing generation for this conversation
    const existingController = this.activeGenerations.get(conversationId);
    if (existingController) {
      existingController.abort();
    }

    // Create a new local AbortController for this generation
    const abortController = new AbortController();
    this.activeGenerations.set(conversationId, abortController);

    // Truncate message if too long (save tokens)
    const truncatedUser = this.truncateText(userMessage, 500);

    const prompt = `User's request:
"""
${truncatedUser}
"""

Generate a title for this conversation:`;

    try {
      const result = await runCodexTextQuery({
        cliPath: resolvedCodexPath,
        cwd: vaultPath,
        env: {
          ...process.env,
          ...envVars,
          PATH: enhancedPath,
        },
        model: titleModel,
        systemPrompt: TITLE_GENERATION_SYSTEM_PROMPT,
        prompt,
        effortLevel: this.plugin.settings.effortLevel ?? 'medium',
        thinkingBudget: 'off',
        signal: abortController.signal,
      });

      const title = this.parseTitle(result.text);
      if (title) {
        await this.safeCallback(callback, conversationId, { success: true, title });
      } else {
        await this.safeCallback(callback, conversationId, {
          success: false,
          error: 'Failed to parse title from response',
        });
      }
    } catch (error) {
      const msg = error instanceof Error ? error.message : 'Unknown error';
      await this.safeCallback(callback, conversationId, { success: false, error: msg });
    } finally {
      // Clean up the controller for this conversation
      this.activeGenerations.delete(conversationId);
    }
  }

  /** Cancels all ongoing title generations. */
  cancel(): void {
    for (const controller of this.activeGenerations.values()) {
      controller.abort();
    }
    this.activeGenerations.clear();
  }

  /** Truncates text to a maximum length with ellipsis. */
  private truncateText(text: string, maxLength: number): string {
    if (text.length <= maxLength) return text;
    return text.substring(0, maxLength) + '...';
  }

  /** Parses and cleans the title from response. */
  private parseTitle(responseText: string): string | null {
    const trimmed = responseText.trim();
    if (!trimmed) return null;

    // Remove surrounding quotes if present
    let title = trimmed;
    if (
      (title.startsWith('"') && title.endsWith('"')) ||
      (title.startsWith("'") && title.endsWith("'"))
    ) {
      title = title.slice(1, -1);
    }

    // Remove trailing punctuation
    title = title.replace(/[.!?:;,]+$/, '');

    // Truncate to max 50 characters
    if (title.length > 50) {
      title = title.substring(0, 47) + '...';
    }

    return title || null;
  }

  /** Safely invokes callback with try-catch to prevent unhandled errors. */
  private async safeCallback(
    callback: TitleGenerationCallback,
    conversationId: string,
    result: TitleGenerationResult
  ): Promise<void> {
    try {
      await callback(conversationId, result);
    } catch {
      // Silently ignore callback errors
    }
  }
}
