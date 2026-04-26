/**
 * McpStorage - Handles .codex/mcp.json read/write
 *
 * MCP server configurations are stored in Codex CLI-compatible format
 * with optional Codexdian-specific metadata in _codexdian field.
 *
 * File format:
 * {
 *   "mcpServers": {
 *     "server-name": { "command": "...", "args": [...] }
 *   },
 *   "_codexdian": {
 *     "servers": {
 *       "server-name": { "enabled": true, "contextSaving": true, "disabledTools": ["tool"], "description": "..." }
 *     }
 *   }
 * }
 */

import type {
  CodexdianMcpConfigFile,
  CodexdianMcpServer,
  McpServerConfig,
  ParsedMcpConfig,
} from '../types';
import { DEFAULT_MCP_SERVER, isValidMcpServerConfig } from '../types';
import type { VaultFileAdapter } from './VaultFileAdapter';

/** Path to MCP config file relative to vault root. */
export const MCP_CONFIG_PATH = '.codex/mcp.json';

export class McpStorage {
  constructor(private adapter: VaultFileAdapter) {}

  async load(): Promise<CodexdianMcpServer[]> {
    try {
      if (!(await this.adapter.exists(MCP_CONFIG_PATH))) {
        return [];
      }

      const content = await this.adapter.read(MCP_CONFIG_PATH);
      const file = JSON.parse(content) as CodexdianMcpConfigFile;

      if (!file.mcpServers || typeof file.mcpServers !== 'object') {
        return [];
      }

      const codexdianMeta = file._codexdian?.servers ?? {};
      const servers: CodexdianMcpServer[] = [];

      for (const [name, config] of Object.entries(file.mcpServers)) {
        if (!isValidMcpServerConfig(config)) {
          continue;
        }

        const meta = codexdianMeta[name] ?? {};
        const disabledTools = Array.isArray(meta.disabledTools)
          ? meta.disabledTools.filter((tool) => typeof tool === 'string')
          : undefined;
        const normalizedDisabledTools =
          disabledTools && disabledTools.length > 0 ? disabledTools : undefined;

        servers.push({
          name,
          config,
          enabled: meta.enabled ?? DEFAULT_MCP_SERVER.enabled,
          contextSaving: meta.contextSaving ?? DEFAULT_MCP_SERVER.contextSaving,
          disabledTools: normalizedDisabledTools,
          description: meta.description,
        });
      }

      return servers;
    } catch {
      return [];
    }
  }

  async save(servers: CodexdianMcpServer[]): Promise<void> {
    const mcpServers: Record<string, McpServerConfig> = {};
    const codexdianServers: Record<
      string,
      { enabled?: boolean; contextSaving?: boolean; disabledTools?: string[]; description?: string }
    > = {};

    for (const server of servers) {
      mcpServers[server.name] = server.config;

      // Only store Codexdian metadata if different from defaults
      const meta: {
        enabled?: boolean;
        contextSaving?: boolean;
        disabledTools?: string[];
        description?: string;
      } = {};

      if (server.enabled !== DEFAULT_MCP_SERVER.enabled) {
        meta.enabled = server.enabled;
      }
      if (server.contextSaving !== DEFAULT_MCP_SERVER.contextSaving) {
        meta.contextSaving = server.contextSaving;
      }
      const normalizedDisabledTools = server.disabledTools
        ?.map((tool) => tool.trim())
        .filter((tool) => tool.length > 0);
      if (normalizedDisabledTools && normalizedDisabledTools.length > 0) {
        meta.disabledTools = normalizedDisabledTools;
      }
      if (server.description) {
        meta.description = server.description;
      }

      if (Object.keys(meta).length > 0) {
        codexdianServers[server.name] = meta;
      }
    }

    let existing: Record<string, unknown> | null = null;
    if (await this.adapter.exists(MCP_CONFIG_PATH)) {
      try {
        const raw = await this.adapter.read(MCP_CONFIG_PATH);
        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed === 'object') {
          existing = parsed as Record<string, unknown>;
        }
      } catch {
        existing = null;
      }
    }

    const file: Record<string, unknown> = existing ? { ...existing } : {};
    file.mcpServers = mcpServers;

    const existingCodexdian =
      existing && typeof existing._codexdian === 'object'
        ? (existing._codexdian as Record<string, unknown>)
        : null;

    if (Object.keys(codexdianServers).length > 0) {
      file._codexdian = { ...(existingCodexdian ?? {}), servers: codexdianServers };
    } else if (existingCodexdian) {
      const { servers: _servers, ...rest } = existingCodexdian;
      if (Object.keys(rest).length > 0) {
        file._codexdian = rest;
      } else {
        delete file._codexdian;
      }
    } else {
      delete file._codexdian;
    }

    const content = JSON.stringify(file, null, 2);
    await this.adapter.write(MCP_CONFIG_PATH, content);
  }

  async exists(): Promise<boolean> {
    return this.adapter.exists(MCP_CONFIG_PATH);
  }

  /**
   * Parse pasted JSON (supports multiple formats).
   *
   * Formats supported:
   * 1. Full Codex CLI format: { "mcpServers": { "name": {...} } }
   * 2. Single server with name: { "name": { "command": "..." } }
   * 3. Single server without name: { "command": "..." }
   */
  static parseClipboardConfig(json: string): ParsedMcpConfig {
    try {
      const parsed = JSON.parse(json);

      if (!parsed || typeof parsed !== 'object') {
        throw new Error('Invalid JSON object');
      }

      // Format 1: Full Codex CLI format
      // { "mcpServers": { "server-name": { "command": "...", ... } } }
      if (parsed.mcpServers && typeof parsed.mcpServers === 'object') {
        const servers: Array<{ name: string; config: McpServerConfig }> = [];

        for (const [name, config] of Object.entries(parsed.mcpServers)) {
          if (isValidMcpServerConfig(config)) {
            servers.push({ name, config: config as McpServerConfig });
          }
        }

        if (servers.length === 0) {
          throw new Error('No valid server configs found in mcpServers');
        }

        return { servers, needsName: false };
      }

      // Format 2: Single server config without name
      // { "command": "...", "args": [...] } or { "type": "sse", "url": "..." }
      if (isValidMcpServerConfig(parsed)) {
        return {
          servers: [{ name: '', config: parsed as McpServerConfig }],
          needsName: true,
        };
      }

      // Format 3: Single named server
      // { "server-name": { "command": "...", ... } }
      const entries = Object.entries(parsed);
      if (entries.length === 1) {
        const [name, config] = entries[0];
        if (isValidMcpServerConfig(config)) {
          return {
            servers: [{ name, config: config as McpServerConfig }],
            needsName: false,
          };
        }
      }

      // Format 4: Multiple named servers (without mcpServers wrapper)
      // { "server1": {...}, "server2": {...} }
      const servers: Array<{ name: string; config: McpServerConfig }> = [];
      for (const [name, config] of entries) {
        if (isValidMcpServerConfig(config)) {
          servers.push({ name, config: config as McpServerConfig });
        }
      }

      if (servers.length > 0) {
        return { servers, needsName: false };
      }

      throw new Error('Invalid MCP configuration format');
    } catch (error) {
      if (error instanceof SyntaxError) {
        throw new Error('Invalid JSON');
      }
      throw error;
    }
  }

  /**
   * Try to parse clipboard content as MCP config.
   * Returns null if not valid MCP config.
   */
  static tryParseClipboardConfig(text: string): ParsedMcpConfig | null {
    // Quick check - must look like JSON
    const trimmed = text.trim();
    if (!trimmed.startsWith('{')) {
      return null;
    }

    try {
      return McpStorage.parseClipboardConfig(trimmed);
    } catch {
      return null;
    }
  }
}
