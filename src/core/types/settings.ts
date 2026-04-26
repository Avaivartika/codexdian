/**
 * Settings type definitions.
 */

import type { Locale } from '../../i18n/types';
import type { CodexModel, EffortLevel, ServiceTierMode, ThinkingBudget, VerbosityLevel } from './models';

const UNIX_BLOCKED_COMMANDS = [
  'rm -rf',
  'chmod 777',
  'chmod -R 777',
];

/** Platform-specific blocked commands (Windows - both CMD and PowerShell). */
const WINDOWS_BLOCKED_COMMANDS = [
  // CMD commands
  'del /s /q',
  'rd /s /q',
  'rmdir /s /q',
  'format',
  'diskpart',
  // PowerShell Remove-Item variants (full and abbreviated flags)
  'Remove-Item -Recurse -Force',
  'Remove-Item -Force -Recurse',
  'Remove-Item -r -fo',
  'Remove-Item -fo -r',
  'Remove-Item -Recurse',
  'Remove-Item -r',
  // PowerShell aliases for Remove-Item
  'ri -Recurse',
  'ri -r',
  'ri -Force',
  'ri -fo',
  'rm -r -fo',
  'rm -Recurse',
  'rm -Force',
  'del -Recurse',
  'del -Force',
  'erase -Recurse',
  'erase -Force',
  // PowerShell directory removal aliases
  'rd -Recurse',
  'rmdir -Recurse',
  // Dangerous disk/volume commands
  'Format-Volume',
  'Clear-Disk',
  'Initialize-Disk',
  'Remove-Partition',
];

export interface PlatformBlockedCommands {
  unix: string[];
  windows: string[];
}

export function getDefaultBlockedCommands(): PlatformBlockedCommands {
  return {
    unix: [...UNIX_BLOCKED_COMMANDS],
    windows: [...WINDOWS_BLOCKED_COMMANDS],
  };
}

export function getCurrentPlatformKey(): keyof PlatformBlockedCommands {
  return process.platform === 'win32' ? 'windows' : 'unix';
}

export function getCurrentPlatformBlockedCommands(commands: PlatformBlockedCommands): string[] {
  return commands[getCurrentPlatformKey()];
}

/**
 * Get blocked commands for the Bash tool.
 *
 * On Windows, the Bash tool runs in a Git Bash/MSYS2 environment but can still
 * invoke Windows commands (e.g., via `cmd /c` or `powershell`), so both Unix
 * and Windows blocklist patterns are merged.
 */
export function getBashToolBlockedCommands(commands: PlatformBlockedCommands): string[] {
  if (process.platform === 'win32') {
    return Array.from(new Set([...commands.unix, ...commands.windows]));
  }
  return getCurrentPlatformBlockedCommands(commands);
}

/**
 * Platform-specific Codex CLI paths.
 * @deprecated Use HostnameCliPaths instead. Kept for migration from older versions.
 */
export interface PlatformCliPaths {
  macos: string;
  linux: string;
  windows: string;
}

/** Platform key for CLI paths. Used for migration only. */
export type CliPlatformKey = keyof PlatformCliPaths;

/**
 * Map process.platform to CLI platform key.
 * @deprecated Used for migration only.
 */
export function getCliPlatformKey(): CliPlatformKey {
  switch (process.platform) {
    case 'darwin':
      return 'macos';
    case 'win32':
      return 'windows';
    default:
      return 'linux';
  }
}

/**
 * Hostname-keyed CLI paths for per-device configuration.
 * Each device stores its path using its hostname as key.
 * This allows settings to sync across devices without conflicts.
 */
export type HostnameCliPaths = Record<string, string>;

/** Permission mode for tool execution. */
export type PermissionMode = 'yolo' | 'plan' | 'normal';

/** User decision from the approval modal. */
export type ApprovalDecision = 'allow' | 'allow-always' | 'deny' | 'cancel';

/**
 * Legacy permission format (pre-CC compatibility).
 * @deprecated Use CCPermissions instead
 */
export interface LegacyPermission {
  toolName: string;
  pattern: string;
  approvedAt: number;
  scope: 'session' | 'always';
}

/**
 * CC-compatible permission rule string.
 * Format: "Tool(pattern)" or "Tool" for all
 * Examples: "Bash(git *)", "Read(*.md)", "WebFetch(domain:github.com)"
 */
export type PermissionRule = string & { readonly __brand: 'PermissionRule' };

/**
 * Create a PermissionRule from a string.
 * @internal Use legacyPermissionToCCRule instead.
 */
export function createPermissionRule(rule: string): PermissionRule {
  return rule as PermissionRule;
}

/**
 * CC-compatible permissions object.
 * Stored in plugin-managed settings for interoperability with external CLI rules.
 */
export interface CCPermissions {
  /** Rules that auto-approve tool actions */
  allow?: PermissionRule[];
  /** Rules that auto-deny tool actions (highest persistent priority) */
  deny?: PermissionRule[];
  /** Rules that always prompt for confirmation */
  ask?: PermissionRule[];
  /** Default permission mode */
  defaultMode?: 'acceptEdits' | 'bypassPermissions' | 'default' | 'plan';
  /** Additional directories to include in permission scope */
  additionalDirectories?: string[];
}

/**
 * Compatibility settings stored in plugin-managed project config.
 * These settings are shared with the external coding CLI when possible.
 */
export interface CCSettings {
  /** JSON Schema reference */
  $schema?: string;
  /** Tool permissions (CC format) */
  permissions?: CCPermissions;
  /** Model override */
  model?: string;
  /** Environment variables (object format) */
  env?: Record<string, string>;
  /** MCP server settings */
  enableAllProjectMcpServers?: boolean;
  enabledMcpjsonServers?: string[];
  disabledMcpjsonServers?: string[];
  /** Plugin enabled state (CC format: { "plugin-id": true/false }) */
  enabledPlugins?: Record<string, boolean>;
  /** Allow additional properties for CC compatibility */
  [key: string]: unknown;
}

/** Saved environment variable configuration. */
export interface EnvSnippet {
  id: string;
  name: string;
  description: string;
  envVars: string;
  contextLimits?: Record<string, number>;  // Optional: context limits for custom models
}

/** Source of a slash command. */
export type SlashCommandSource = 'builtin' | 'user' | 'plugin' | 'sdk';

/** Slash command configuration with Codex-compatible metadata. */
export interface SlashCommand {
  id: string;
  name: string;                // Command name used after / (e.g., "review-code")
  description?: string;        // Optional description shown in dropdown
  argumentHint?: string;       // Placeholder text for arguments (e.g., "[file] [focus]")
  allowedTools?: string[];     // Restrict tools when command is used
  model?: CodexModel;         // Override model for this command
  content: string;             // Prompt template with placeholders
  source?: SlashCommandSource; // Origin of the command (builtin, user, plugin, sdk)
  // Skill fields (from .codex/skills/ definitions)
  disableModelInvocation?: boolean;  // Disable model invocation for this skill
  userInvocable?: boolean;           // Whether user can invoke this skill directly
  context?: 'fork';                  // Subagent execution mode
  agent?: string;                    // Subagent type when context='fork'
  hooks?: Record<string, unknown>;   // Pass-through to SDK
}

/** Keyboard navigation settings for vim-style scrolling. */
export interface KeyboardNavigationSettings {
  scrollUpKey: string;         // Key to scroll up when focused on messages (default: 'w')
  scrollDownKey: string;       // Key to scroll down when focused on messages (default: 's')
  focusInputKey: string;       // Key to focus input (default: 'i', like vim insert mode)
}

/** Tab bar position setting. */
export type TabBarPosition = 'input' | 'header';

/** Chat theme mode setting. */
export type ThemeMode = 'auto' | 'light' | 'dark';

/**
 * Codexdian-specific settings stored in plugin state.
 * These settings are NOT shared with the Codex CLI.
 */
export interface CodexdianSettings {
  // User preferences
  userName: string;

  // Security (Codexdian-specific, CC uses permissions.deny instead)
  enableBlocklist: boolean;
  allowExternalAccess: boolean;
  blockedCommands: PlatformBlockedCommands;
  permissionMode: PermissionMode;

  // Model & thinking
  model: CodexModel;
  thinkingBudget: ThinkingBudget;  // Legacy token budget for custom models
  effortLevel: EffortLevel;  // Effort level for adaptive thinking models
  serviceTier: ServiceTierMode;  // Optional Codex service tier override (fast/flex)
  verbosity: VerbosityLevel;  // GPT-5 output verbosity
  enableAutoTitleGeneration: boolean;
  titleGenerationModel: string;  // Model for auto title generation (empty = auto)
  enableChrome: boolean;  // Enable Chrome extension support (passes --chrome flag)
  enableBangBash: boolean;  // Enable ! bash mode for direct command execution
  enableGPT54HighContext: boolean;  // Show GPT-5.4 high-context model variant
  enableGPT53CodexHighContext: boolean;  // Show GPT-5.3 Codex high-context model variant

  // Content settings
  excludedTags: string[];
  mediaFolder: string;
  systemPrompt: string;
  allowedExportPaths: string[];
  persistentExternalContextPaths: string[];  // Paths that persist across all sessions

  // Environment (string format, CC uses object format in settings.json)
  environmentVariables: string;
  envSnippets: EnvSnippet[];
  /**
   * Custom context window limits for models configured via environment variables.
   * Keys are model IDs resolved from Codex config or environment variables.
   * Values are token counts in range [1000, 10000000].
   * Empty object means all models use default context limits (200k).
   */
  customContextLimits: Record<string, number>;

  // UI settings
  keyboardNavigation: KeyboardNavigationSettings;

  // Internationalization
  locale: Locale;  // UI language setting

  // CLI paths
  codexCliPath: string;  // Legacy key retained for backwards compatibility
  codexCliPathsByHost: HostnameCliPaths;  // Per-device paths keyed by hostname (preferred)
  loadUserCodexSettings: boolean;  // Load user-level Codex config (may override permissions)

  // State (merged from data.json)
  lastCodexModel?: CodexModel;
  lastCustomModel?: CodexModel;
  lastEnvHash?: string;

  // Slash commands
  slashCommands: SlashCommand[];

  // UI preferences
  maxTabs: number;  // Maximum number of chat tabs (3-10, default 3)
  tabBarPosition: TabBarPosition;  // Where to show tab bar ('input' or 'header')
  themeMode: ThemeMode;  // Chat appearance mode ('auto' | 'light' | 'dark')
  enableAutoScroll: boolean;  // Enable auto-scroll during streaming (default: true)
  openInMainTab: boolean;  // Open chat panel in main editor area instead of sidebar

  // Slash commands
  hiddenSlashCommands: string[];  // Command names to hide from dropdown (user preference)
}

/** Default plugin settings. */
export const DEFAULT_SETTINGS: CodexdianSettings = {
  // User preferences
  userName: '',

  // Security
  enableBlocklist: true,
  allowExternalAccess: false,
  blockedCommands: getDefaultBlockedCommands(),
  permissionMode: 'normal',

  // Model & thinking
  model: 'gpt-5.5',
  thinkingBudget: 'off',
  effortLevel: 'medium',
  serviceTier: 'auto',
  verbosity: 'medium',
  enableAutoTitleGeneration: true,
  titleGenerationModel: '',  // Empty = auto
  enableChrome: false,  // Disabled by default
  enableBangBash: false,  // Disabled by default
  enableGPT54HighContext: false,  // Disabled by default
  enableGPT53CodexHighContext: false,  // Disabled by default

  // Content settings
  excludedTags: [],
  mediaFolder: '',
  systemPrompt: '',
  allowedExportPaths: ['~/Desktop', '~/Downloads'],
  persistentExternalContextPaths: [],

  // Environment
  environmentVariables: '',
  envSnippets: [],
  customContextLimits: {},

  // UI settings
  keyboardNavigation: {
    scrollUpKey: 'w',
    scrollDownKey: 's',
    focusInputKey: 'i',
  },

  // Internationalization
  locale: 'en',  // Default to English

  // CLI paths
  codexCliPath: '',  // Legacy field (empty = not migrated)
  codexCliPathsByHost: {},  // Per-device paths keyed by hostname
  loadUserCodexSettings: false,  // Default off for safer vault-local behavior

  lastCodexModel: 'gpt-5.5',
  lastCustomModel: '',
  lastEnvHash: '',

  // Slash commands (loaded separately)
  slashCommands: [],

  // UI preferences
  maxTabs: 3,  // Default to 3 tabs (safe resource usage)
  tabBarPosition: 'input',  // Default to input mode (current behavior)
  themeMode: 'auto',  // Default to follow Obsidian theme
  enableAutoScroll: true,  // Default to auto-scroll enabled
  openInMainTab: false,  // Default to sidebar (current behavior)

  // Slash commands
  hiddenSlashCommands: [],  // No commands hidden by default
};

/** Default CC-compatible settings. */
export const DEFAULT_CC_SETTINGS: CCSettings = {
  $schema: 'https://json.schemastore.org/codex-settings.json',
  permissions: {
    allow: [],
    deny: [],
    ask: [],
  },
};

/** Default CC permissions. */
export const DEFAULT_CC_PERMISSIONS: CCPermissions = {
  allow: [],
  deny: [],
  ask: [],
};

/** Result from instruction refinement agent query. */
export interface InstructionRefineResult {
  success: boolean;
  refinedInstruction?: string;  // The refined instruction text
  clarification?: string;       // Agent's clarifying question (if any)
  error?: string;               // Error message (if failed)
}

/**
 * Convert a legacy permission to CC permission rule format.
 * Examples:
 *   { toolName: "Bash", pattern: "git *" } → "Bash(git *)"
 *   { toolName: "Read", pattern: "/path/to/file" } → "Read(/path/to/file)"
 *   { toolName: "WebSearch", pattern: "*" } → "WebSearch"
 */
export function legacyPermissionToCCRule(legacy: LegacyPermission): PermissionRule {
  const pattern = legacy.pattern.trim();

  // If pattern is empty, wildcard, or JSON object (old format), just use tool name
  if (!pattern || pattern === '*' || pattern.startsWith('{')) {
    return createPermissionRule(legacy.toolName);
  }

  return createPermissionRule(`${legacy.toolName}(${pattern})`);
}

/**
 * Convert legacy permissions array to CC permissions object.
 * Only 'always' scope permissions are converted (session = ephemeral).
 */
export function legacyPermissionsToCCPermissions(
  legacyPermissions: LegacyPermission[]
): CCPermissions {
  const allow: PermissionRule[] = [];

  for (const perm of legacyPermissions) {
    if (perm.scope === 'always') {
      allow.push(legacyPermissionToCCRule(perm));
    }
  }

  return {
    allow: [...new Set(allow)],  // Deduplicate
    deny: [],
    ask: [],
  };
}

/**
 * Parse a CC permission rule into tool name and pattern.
 * Examples:
 *   "Bash(git *)" → { tool: "Bash", pattern: "git *" }
 *   "Read" → { tool: "Read", pattern: undefined }
 *   "WebFetch(domain:github.com)" → { tool: "WebFetch", pattern: "domain:github.com" }
 */
export function parseCCPermissionRule(rule: PermissionRule): {
  tool: string;
  pattern?: string;
} {
  const match = rule.match(/^(\w+)(?:\((.+)\))?$/);
  if (!match) {
    return { tool: rule };
  }

  const [, tool, pattern] = match;
  return { tool, pattern };
}
