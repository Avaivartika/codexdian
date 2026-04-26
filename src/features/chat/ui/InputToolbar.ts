import { Notice, setIcon } from 'obsidian';
import * as path from 'path';

import type { McpServerManager } from '../../../core/mcp';
import type {
  CodexdianMcpServer,
  CodexModel,
  EffortLevel,
  PermissionMode,
  ServiceTierMode,
  ThinkingBudget,
  UsageInfo,
  VerbosityLevel
} from '../../../core/types';
import {
  DEFAULT_CODEX_MODELS,
  EFFORT_LEVELS,
  filterVisibleModelOptions,
  isAdaptiveThinkingModel,
  THINKING_BUDGETS
} from '../../../core/types';
import { CHECK_ICON_SVG, MCP_ICON_SVG } from '../../../shared/icons';
import { getModelsFromEnvironment, parseEnvironmentVariables } from '../../../utils/env';
import { filterValidPaths, findConflictingPath, isDuplicatePath, isValidDirectoryPath, validateDirectoryPath } from '../../../utils/externalContext';
import { expandHomePath, normalizePathForFilesystem } from '../../../utils/path';

export interface ToolbarSettings {
  model: CodexModel;
  thinkingBudget: ThinkingBudget;
  effortLevel: EffortLevel;
  serviceTier: ServiceTierMode;
  verbosity: VerbosityLevel;
  permissionMode: PermissionMode;
  enableGPT54HighContext: boolean;
  enableGPT53CodexHighContext: boolean;
}

export interface ToolbarCallbacks {
  onModelChange: (model: CodexModel) => Promise<void>;
  onThinkingBudgetChange: (budget: ThinkingBudget) => Promise<void>;
  onEffortLevelChange: (effort: EffortLevel) => Promise<void>;
  onServiceTierChange?: (tier: ServiceTierMode) => Promise<void>;
  onVerbosityChange?: (verbosity: VerbosityLevel) => Promise<void>;
  onPermissionModeChange: (mode: PermissionMode) => Promise<void>;
  getSettings: () => ToolbarSettings;
  getEnvironmentVariables?: () => string;
}

function createToolbarHoverHint(
  parentEl: HTMLElement,
  title: string,
  description: string,
  extraClass?: string,
): void {
  const cls = extraClass
    ? `codexdian-toolbar-hint ${extraClass}`
    : 'codexdian-toolbar-hint';
  const hintEl = parentEl.createDiv({ cls });
  hintEl.createSpan({ cls: 'codexdian-toolbar-hint-title', text: title });
  hintEl.createSpan({ cls: 'codexdian-toolbar-hint-desc', text: description });
}

export class ModelSelector {
  private container: HTMLElement;
  private buttonEl: HTMLElement | null = null;
  private dropdownEl: HTMLElement | null = null;
  private callbacks: ToolbarCallbacks;
  private isReady = false;

  constructor(parentEl: HTMLElement, callbacks: ToolbarCallbacks) {
    this.callbacks = callbacks;
    this.container = parentEl.createDiv({ cls: 'codexdian-model-selector' });
    this.render();
  }

  getElement(): HTMLElement {
    return this.container;
  }

  private getAvailableModels() {
    const models = [...DEFAULT_CODEX_MODELS];

    if (this.callbacks.getEnvironmentVariables) {
      const envVarsStr = this.callbacks.getEnvironmentVariables();
      const envVars = parseEnvironmentVariables(envVarsStr);
      const customModels = getModelsFromEnvironment(envVars);
      if (customModels.length > 0) {
        return customModels;
      }
    }

    const settings = this.callbacks.getSettings();
    return filterVisibleModelOptions(models, settings.enableGPT54HighContext, settings.enableGPT53CodexHighContext);
  }

  private render() {
    this.container.empty();

    this.buttonEl = this.container.createDiv({ cls: 'codexdian-model-btn' });
    this.setReady(this.isReady);
    this.updateDisplay();
    createToolbarHoverHint(
      this.container,
      'Model',
      'Choose the model for this chat',
      'codexdian-toolbar-hint--model',
    );

    this.dropdownEl = this.container.createDiv({ cls: 'codexdian-model-dropdown' });
    this.renderOptions();
  }

  updateDisplay() {
    if (!this.buttonEl) return;
    const currentModel = this.callbacks.getSettings().model;
    const models = this.getAvailableModels();
    const modelInfo = models.find(m => m.value === currentModel);

    const displayModel = modelInfo || models[0];

    this.buttonEl.empty();
    this.buttonEl.setAttribute('title', displayModel?.description || 'Choose the model for this chat');

    const labelEl = this.buttonEl.createSpan({ cls: 'codexdian-model-label' });
    labelEl.setText(displayModel?.label || 'Unknown');
  }

  setReady(ready: boolean) {
    this.isReady = ready;
    this.buttonEl?.toggleClass('ready', ready);
  }

  renderOptions() {
    if (!this.dropdownEl) return;
    this.dropdownEl.empty();

    const currentModel = this.callbacks.getSettings().model;
    const models = this.getAvailableModels();

    for (const model of [...models].reverse()) {
      const option = this.dropdownEl.createDiv({ cls: 'codexdian-model-option' });
      if (model.value === currentModel) {
        option.addClass('selected');
      }

      option.createSpan({ text: model.label });
      if (model.description) {
        option.setAttribute('title', model.description);
      }

      option.addEventListener('click', async (e) => {
        e.stopPropagation();
        await this.callbacks.onModelChange(model.value);
        this.updateDisplay();
        this.renderOptions();
      });
    }
  }
}

export class ThinkingBudgetSelector {
  private container: HTMLElement;
  private effortEl: HTMLElement | null = null;
  private effortGearsEl: HTMLElement | null = null;
  private budgetEl: HTMLElement | null = null;
  private budgetGearsEl: HTMLElement | null = null;
  private callbacks: ToolbarCallbacks;

  constructor(parentEl: HTMLElement, callbacks: ToolbarCallbacks) {
    this.callbacks = callbacks;
    this.container = parentEl.createDiv({ cls: 'codexdian-thinking-selector' });
    this.render();
  }

  getElement(): HTMLElement {
    return this.container;
  }

  private render() {
    this.container.empty();

    // Effort selector (for adaptive thinking models)
    this.effortEl = this.container.createDiv({ cls: 'codexdian-thinking-effort' });
    this.effortGearsEl = this.effortEl.createDiv({ cls: 'codexdian-thinking-gears' });
    createToolbarHoverHint(
      this.effortEl,
      'Reasoning effort',
      'Balance answer speed and depth',
      'codexdian-toolbar-hint--thinking',
    );

    // Legacy budget selector (for custom models)
    this.budgetEl = this.container.createDiv({ cls: 'codexdian-thinking-budget' });
    this.budgetGearsEl = this.budgetEl.createDiv({ cls: 'codexdian-thinking-gears' });
    createToolbarHoverHint(
      this.budgetEl,
      'Thinking budget',
      'Set token budget for custom models',
      'codexdian-toolbar-hint--thinking',
    );

    this.updateDisplay();
  }

  private renderEffortGears() {
    if (!this.effortGearsEl) return;
    this.effortGearsEl.empty();

    const currentEffort = this.callbacks.getSettings().effortLevel;
    const currentInfo = EFFORT_LEVELS.find(e => e.value === currentEffort);

    const currentEl = this.effortGearsEl.createDiv({ cls: 'codexdian-thinking-current' });
    currentEl.setText(currentInfo?.label || 'High');
    currentEl.setAttribute('title', 'Reasoning effort: balance answer speed and depth');

    const optionsEl = this.effortGearsEl.createDiv({ cls: 'codexdian-thinking-options' });

    for (const effort of [...EFFORT_LEVELS].reverse()) {
      const gearEl = optionsEl.createDiv({ cls: 'codexdian-thinking-gear' });
      gearEl.setText(effort.label);

      if (effort.value === currentEffort) {
        gearEl.addClass('selected');
      }

      gearEl.addEventListener('click', async (e) => {
        e.stopPropagation();
        await this.callbacks.onEffortLevelChange(effort.value);
        this.updateDisplay();
      });
    }
  }

  private renderBudgetGears() {
    if (!this.budgetGearsEl) return;
    this.budgetGearsEl.empty();

    const currentBudget = this.callbacks.getSettings().thinkingBudget;
    const currentBudgetInfo = THINKING_BUDGETS.find(b => b.value === currentBudget);

    const currentEl = this.budgetGearsEl.createDiv({ cls: 'codexdian-thinking-current' });
    currentEl.setText(currentBudgetInfo?.label || 'Off');
    currentEl.setAttribute('title', 'Thinking budget for custom models');

    const optionsEl = this.budgetGearsEl.createDiv({ cls: 'codexdian-thinking-options' });

    for (const budget of [...THINKING_BUDGETS].reverse()) {
      const gearEl = optionsEl.createDiv({ cls: 'codexdian-thinking-gear' });
      gearEl.setText(budget.label);
      gearEl.setAttribute('title', budget.tokens > 0 ? `${budget.tokens.toLocaleString()} tokens` : 'Disabled');

      if (budget.value === currentBudget) {
        gearEl.addClass('selected');
      }

      gearEl.addEventListener('click', async (e) => {
        e.stopPropagation();
        await this.callbacks.onThinkingBudgetChange(budget.value);
        this.updateDisplay();
      });
    }
  }

  updateDisplay() {
    const model = this.callbacks.getSettings().model;
    const adaptive = isAdaptiveThinkingModel(model);

    if (this.effortEl) {
      this.effortEl.style.display = adaptive ? '' : 'none';
    }
    if (this.budgetEl) {
      this.budgetEl.style.display = adaptive ? 'none' : '';
    }

    if (adaptive) {
      this.renderEffortGears();
    } else {
      this.renderBudgetGears();
    }
  }
}

const SERVICE_TIER_OPTIONS: { value: ServiceTierMode; label: string; title: string }[] = [
  { value: 'auto', label: 'Auto', title: 'Use Codex default service tier' },
  { value: 'fast', label: 'Fast', title: 'Prefer lower-latency Codex responses' },
  { value: 'flex', label: 'Flex', title: 'Use flexible service tier when available' },
];

const VERBOSITY_OPTIONS: { value: VerbosityLevel; label: string; title: string }[] = [
  { value: 'low', label: 'Brief', title: 'Shorter responses' },
  { value: 'medium', label: 'Normal', title: 'Balanced response detail' },
  { value: 'high', label: 'Detail', title: 'More detailed responses' },
];

export class ServiceTierSelector {
  private container: HTMLElement;
  private controlEl: HTMLElement | null = null;
  private currentEl: HTMLElement | null = null;
  private optionsEl: HTMLElement | null = null;
  private callbacks: ToolbarCallbacks;

  constructor(parentEl: HTMLElement, callbacks: ToolbarCallbacks) {
    this.callbacks = callbacks;
    this.container = parentEl.createDiv({ cls: 'codexdian-service-tier-selector' });
    this.render();
  }

  getElement(): HTMLElement {
    return this.container;
  }

  private render(): void {
    this.container.empty();
    this.controlEl = this.container.createDiv({ cls: 'codexdian-service-tier-control' });
    this.currentEl = this.controlEl.createDiv({ cls: 'codexdian-service-tier-current' });
    this.optionsEl = this.controlEl.createDiv({ cls: 'codexdian-service-tier-options' });
    createToolbarHoverHint(
      this.container,
      'Mode',
      'Choose Codex service tier',
      'codexdian-toolbar-hint--service-tier',
    );
    this.updateDisplay();
  }

  updateDisplay(): void {
    const current = this.callbacks.getSettings().serviceTier ?? 'auto';
    const currentOption = SERVICE_TIER_OPTIONS.find(option => option.value === current) ?? SERVICE_TIER_OPTIONS[0];
    this.container.toggleClass('codexdian-service-tier-fast', current === 'fast');
    this.container.toggleClass('codexdian-service-tier-flex', current === 'flex');
    this.currentEl?.setText(currentOption.label);
    this.currentEl?.setAttribute('title', currentOption.title);
    this.renderOptions();
  }

  private renderOptions(): void {
    if (!this.optionsEl) return;
    this.optionsEl.empty();
    const current = this.callbacks.getSettings().serviceTier ?? 'auto';
    for (const option of SERVICE_TIER_OPTIONS) {
      const optionEl = this.optionsEl.createDiv({ cls: 'codexdian-service-tier-option' });
      optionEl.setText(option.label);
      optionEl.setAttribute('title', option.title);
      if (option.value === current) {
        optionEl.addClass('selected');
      }
      optionEl.addEventListener('click', async (event) => {
        event.stopPropagation();
        await this.callbacks.onServiceTierChange?.(option.value);
        this.updateDisplay();
      });
    }
  }
}

export class VerbositySelector {
  private container: HTMLElement;
  private controlEl: HTMLElement | null = null;
  private currentEl: HTMLElement | null = null;
  private optionsEl: HTMLElement | null = null;
  private callbacks: ToolbarCallbacks;

  constructor(parentEl: HTMLElement, callbacks: ToolbarCallbacks) {
    this.callbacks = callbacks;
    this.container = parentEl.createDiv({ cls: 'codexdian-verbosity-selector' });
    this.render();
  }

  getElement(): HTMLElement {
    return this.container;
  }

  private render(): void {
    this.container.empty();
    this.controlEl = this.container.createDiv({ cls: 'codexdian-verbosity-control' });
    this.currentEl = this.controlEl.createDiv({ cls: 'codexdian-verbosity-current' });
    this.optionsEl = this.controlEl.createDiv({ cls: 'codexdian-verbosity-options' });
    createToolbarHoverHint(
      this.container,
      'Verbosity',
      'Control response detail',
      'codexdian-toolbar-hint--verbosity',
    );
    this.updateDisplay();
  }

  updateDisplay(): void {
    const current = this.callbacks.getSettings().verbosity ?? 'medium';
    const currentOption = VERBOSITY_OPTIONS.find(option => option.value === current) ?? VERBOSITY_OPTIONS[1];
    this.currentEl?.setText(currentOption.label);
    this.currentEl?.setAttribute('title', currentOption.title);
    this.renderOptions();
  }

  private renderOptions(): void {
    if (!this.optionsEl) return;
    this.optionsEl.empty();
    const current = this.callbacks.getSettings().verbosity ?? 'medium';
    for (const option of VERBOSITY_OPTIONS) {
      const optionEl = this.optionsEl.createDiv({ cls: 'codexdian-verbosity-option' });
      optionEl.setText(option.label);
      optionEl.setAttribute('title', option.title);
      if (option.value === current) {
        optionEl.addClass('selected');
      }
      optionEl.addEventListener('click', async (event) => {
        event.stopPropagation();
        await this.callbacks.onVerbosityChange?.(option.value);
        this.updateDisplay();
      });
    }
  }
}

export class RunningIndicator {
  private container: HTMLElement;

  constructor(parentEl: HTMLElement) {
    this.container = parentEl.createDiv({ cls: 'codexdian-running-indicator' });
    this.container.createSpan({ cls: 'codexdian-running-dot' });
    this.container.createSpan({ cls: 'codexdian-running-label', text: 'Running' });
    this.container.setAttribute('title', 'Codex is currently running');
    this.update(false);
  }

  getElement(): HTMLElement {
    return this.container;
  }

  update(isRunning: boolean): void {
    this.container.toggleClass('active', isRunning);
    this.container.setAttribute('aria-hidden', isRunning ? 'false' : 'true');
  }
}

export class PermissionToggle {
  private container: HTMLElement;
  private toggleEl: HTMLElement | null = null;
  private labelEl: HTMLElement | null = null;
  private callbacks: ToolbarCallbacks;

  constructor(parentEl: HTMLElement, callbacks: ToolbarCallbacks) {
    this.callbacks = callbacks;
    this.container = parentEl.createDiv({ cls: 'codexdian-permission-toggle' });
    this.render();
  }

  getElement(): HTMLElement {
    return this.container;
  }

  private render() {
    this.container.empty();
    this.container.setAttribute('title', 'Permission mode: Safe asks before risky actions; YOLO allows edits and commands without prompts; PLAN avoids edits.');

    this.labelEl = this.container.createSpan({ cls: 'codexdian-permission-label' });
    this.toggleEl = this.container.createDiv({ cls: 'codexdian-toggle-switch' });

    this.updateDisplay();

    this.toggleEl.addEventListener('click', () => this.toggle());
  }

  updateDisplay() {
    if (!this.toggleEl || !this.labelEl) return;

    const mode = this.callbacks.getSettings().permissionMode;

    if (mode === 'plan') {
      this.toggleEl.style.display = 'none';
      this.labelEl.setText('PLAN');
      this.labelEl.addClass('plan-active');
    } else {
      this.toggleEl.style.display = '';
      this.labelEl.removeClass('plan-active');
      if (mode === 'yolo') {
        this.toggleEl.addClass('active');
        this.labelEl.setText('YOLO');
      } else {
        this.toggleEl.removeClass('active');
        this.labelEl.setText('Safe');
      }
    }
  }

  private async toggle() {
    const current = this.callbacks.getSettings().permissionMode;
    const newMode: PermissionMode = current === 'yolo' ? 'normal' : 'yolo';
    await this.callbacks.onPermissionModeChange(newMode);
    this.updateDisplay();
  }
}

export type AddExternalContextResult =
  | { success: true; normalizedPath: string }
  | { success: false; error: string };

export class ExternalContextSelector {
  private container: HTMLElement;
  private iconEl: HTMLElement | null = null;
  private badgeEl: HTMLElement | null = null;
  private dropdownEl: HTMLElement | null = null;
  private callbacks: ToolbarCallbacks;
  /**
   * Current external context paths. May contain:
   * - Persistent paths only (new sessions via clearExternalContexts)
   * - Restored session paths (loaded sessions via setExternalContexts)
   * - Mixed paths during active sessions
   */
  private externalContextPaths: string[] = [];
  /** Paths that persist across all sessions (stored in settings). */
  private persistentPaths: Set<string> = new Set();
  private onChangeCallback: ((paths: string[]) => void) | null = null;
  private onPersistenceChangeCallback: ((paths: string[]) => void) | null = null;

  constructor(parentEl: HTMLElement, callbacks: ToolbarCallbacks) {
    this.callbacks = callbacks;
    this.container = parentEl.createDiv({ cls: 'codexdian-external-context-selector' });
    this.render();
  }

  getElement(): HTMLElement {
    return this.container;
  }

  setOnChange(callback: (paths: string[]) => void): void {
    this.onChangeCallback = callback;
  }

  setOnPersistenceChange(callback: (paths: string[]) => void): void {
    this.onPersistenceChangeCallback = callback;
  }

  getExternalContexts(): string[] {
    return [...this.externalContextPaths];
  }

  getPersistentPaths(): string[] {
    return [...this.persistentPaths];
  }

  setPersistentPaths(paths: string[]): void {
    // Validate paths - remove non-existent directories
    const validPaths = filterValidPaths(paths);
    const invalidPaths = paths.filter(p => !validPaths.includes(p));

    this.persistentPaths = new Set(validPaths);
    // Merge persistent paths into external context paths
    this.mergePersistentPaths();
    this.updateDisplay();
    this.renderDropdown();

    // If invalid paths were removed, notify user and save updated list
    if (invalidPaths.length > 0) {
      const pathNames = invalidPaths.map(p => this.shortenPath(p)).join(', ');
      new Notice(`Removed ${invalidPaths.length} invalid external context path(s): ${pathNames}`, 5000);
      this.onPersistenceChangeCallback?.([...this.persistentPaths]);
    }
  }

  togglePersistence(path: string): void {
    if (this.persistentPaths.has(path)) {
      this.persistentPaths.delete(path);
    } else {
      // Validate path still exists before persisting
      if (!isValidDirectoryPath(path)) {
        new Notice(`Cannot persist "${this.shortenPath(path)}" - directory no longer exists`, 4000);
        return;
      }
      this.persistentPaths.add(path);
    }
    this.onPersistenceChangeCallback?.([...this.persistentPaths]);
    this.renderDropdown();
  }

  private mergePersistentPaths(): void {
    const pathSet = new Set(this.externalContextPaths);
    for (const path of this.persistentPaths) {
      pathSet.add(path);
    }
    this.externalContextPaths = [...pathSet];
  }

  /**
   * Restore exact external context paths from a saved conversation.
   * Does NOT merge with persistent paths - preserves the session's historical state.
   * Use clearExternalContexts() for new sessions to start with current persistent paths.
   */
  setExternalContexts(paths: string[]): void {
    this.externalContextPaths = [...paths];
    this.updateDisplay();
    this.renderDropdown();
  }

  /**
   * Remove a path from external contexts (and persistent paths if applicable).
   * Exposed for testing the remove button behavior.
   */
  removePath(pathStr: string): void {
    this.externalContextPaths = this.externalContextPaths.filter(p => p !== pathStr);
    // Also remove from persistent paths if it was persistent
    if (this.persistentPaths.has(pathStr)) {
      this.persistentPaths.delete(pathStr);
      this.onPersistenceChangeCallback?.([...this.persistentPaths]);
    }
    this.onChangeCallback?.(this.externalContextPaths);
    this.updateDisplay();
    this.renderDropdown();
  }

  /**
   * Add an external context path programmatically (e.g., from /add-dir command).
   * Validates the path and handles duplicates/conflicts.
   * @param pathInput - Path string (supports ~/ expansion)
   * @returns Result with success status and normalized path, or error message on failure
   */
  addExternalContext(pathInput: string): AddExternalContextResult {
    const trimmed = pathInput?.trim();
    if (!trimmed) {
      return { success: false, error: 'No path provided. Usage: /add-dir /absolute/path' };
    }

    // Strip surrounding quotes if present (e.g., "/path/with spaces")
    let cleanPath = trimmed;
    if ((cleanPath.startsWith('"') && cleanPath.endsWith('"')) ||
        (cleanPath.startsWith("'") && cleanPath.endsWith("'"))) {
      cleanPath = cleanPath.slice(1, -1);
    }

    // Expand home directory and normalize path
    const expandedPath = expandHomePath(cleanPath);
    const normalizedPath = normalizePathForFilesystem(expandedPath);

    if (!path.isAbsolute(normalizedPath)) {
      return { success: false, error: 'Path must be absolute. Usage: /add-dir /absolute/path' };
    }

    // Validate path exists and is a directory with specific error messages
    const validation = validateDirectoryPath(normalizedPath);
    if (!validation.valid) {
      return { success: false, error: `${validation.error}: ${pathInput}` };
    }

    // Check for duplicate (normalized comparison for cross-platform support)
    if (isDuplicatePath(normalizedPath, this.externalContextPaths)) {
      return { success: false, error: 'This folder is already added as an external context.' };
    }

    // Check for nested/overlapping paths
    const conflict = findConflictingPath(normalizedPath, this.externalContextPaths);
    if (conflict) {
      return { success: false, error: this.formatConflictMessage(normalizedPath, conflict) };
    }

    // Add the path
    this.externalContextPaths = [...this.externalContextPaths, normalizedPath];
    this.onChangeCallback?.(this.externalContextPaths);
    this.updateDisplay();
    this.renderDropdown();

    return { success: true, normalizedPath };
  }

  /**
   * Clear session-only external context paths (call on new conversation).
   * Uses persistent paths from settings if provided, otherwise falls back to local cache.
   * Validates paths before using them (silently filters invalid during session init).
   */
  clearExternalContexts(persistentPathsFromSettings?: string[]): void {
    // Use settings value if provided (most up-to-date), otherwise use local cache
    if (persistentPathsFromSettings) {
      // Validate paths - silently filter during session initialization (not user action)
      const validPaths = filterValidPaths(persistentPathsFromSettings);
      this.persistentPaths = new Set(validPaths);
    }
    this.externalContextPaths = [...this.persistentPaths];
    this.updateDisplay();
    this.renderDropdown();
  }

  private render() {
    this.container.empty();

    const iconWrapper = this.container.createDiv({ cls: 'codexdian-external-context-icon-wrapper' });

    this.iconEl = iconWrapper.createDiv({ cls: 'codexdian-external-context-icon' });
    setIcon(this.iconEl, 'folder');

    this.badgeEl = iconWrapper.createDiv({ cls: 'codexdian-external-context-badge' });

    this.updateDisplay();

    // Click to open native folder picker
    iconWrapper.addEventListener('click', (e) => {
      e.stopPropagation();
      this.openFolderPicker();
    });

    this.dropdownEl = this.container.createDiv({ cls: 'codexdian-external-context-dropdown' });
    this.renderDropdown();
  }

  private async openFolderPicker() {
    try {
      // Access Electron's dialog through remote
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { remote } = require('electron');
      const result = await remote.dialog.showOpenDialog({
        properties: ['openDirectory'],
        title: 'Select External Context',
      });

      if (!result.canceled && result.filePaths.length > 0) {
        const selectedPath = result.filePaths[0];

        // Check for duplicate (normalized comparison for cross-platform support)
        if (isDuplicatePath(selectedPath, this.externalContextPaths)) {
          new Notice('This folder is already added as an external context.', 3000);
          return;
        }

        // Check for nested/overlapping paths
        const conflict = findConflictingPath(selectedPath, this.externalContextPaths);
        if (conflict) {
          new Notice(this.formatConflictMessage(selectedPath, conflict), 5000);
          return;
        }

        this.externalContextPaths = [...this.externalContextPaths, selectedPath];
        this.onChangeCallback?.(this.externalContextPaths);
        this.updateDisplay();
        this.renderDropdown();
      }
    } catch {
      new Notice('Unable to open folder picker.', 5000);
    }
  }

  /** Formats a conflict error message for display. */
  private formatConflictMessage(newPath: string, conflict: { path: string; type: 'parent' | 'child' }): string {
    const shortNew = this.shortenPath(newPath);
    const shortExisting = this.shortenPath(conflict.path);
    return conflict.type === 'parent'
      ? `Cannot add "${shortNew}" - it's inside existing path "${shortExisting}"`
      : `Cannot add "${shortNew}" - it contains existing path "${shortExisting}"`;
  }

  private renderDropdown() {
    if (!this.dropdownEl) return;

    this.dropdownEl.empty();

    // Header
    const headerEl = this.dropdownEl.createDiv({ cls: 'codexdian-external-context-header' });
    headerEl.setText('External Contexts');

    // Path list
    const listEl = this.dropdownEl.createDiv({ cls: 'codexdian-external-context-list' });

    if (this.externalContextPaths.length === 0) {
      const emptyEl = listEl.createDiv({ cls: 'codexdian-external-context-empty' });
      emptyEl.setText('Click folder icon to add');
    } else {
      for (const pathStr of this.externalContextPaths) {
        const itemEl = listEl.createDiv({ cls: 'codexdian-external-context-item' });

        const pathTextEl = itemEl.createSpan({ cls: 'codexdian-external-context-text' });
        // Show shortened path for display
        const displayPath = this.shortenPath(pathStr);
        pathTextEl.setText(displayPath);
        pathTextEl.setAttribute('title', pathStr);

        // Lock toggle button
        const isPersistent = this.persistentPaths.has(pathStr);
        const lockBtn = itemEl.createSpan({ cls: 'codexdian-external-context-lock' });
        if (isPersistent) {
          lockBtn.addClass('locked');
        }
        setIcon(lockBtn, isPersistent ? 'lock' : 'unlock');
        lockBtn.setAttribute('title', isPersistent ? 'Persistent (click to make session-only)' : 'Session-only (click to persist)');
        lockBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          this.togglePersistence(pathStr);
        });

        const removeBtn = itemEl.createSpan({ cls: 'codexdian-external-context-remove' });
        setIcon(removeBtn, 'x');
        removeBtn.setAttribute('title', 'Remove path');
        removeBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          this.removePath(pathStr);
        });
      }
    }
  }

  /** Shorten path for display (replace home dir with ~) */
  private shortenPath(fullPath: string): string {
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const os = require('os');
      const homeDir = os.homedir();
      const normalize = (value: string) => value.replace(/\\/g, '/');
      const normalizedFull = normalize(fullPath);
      const normalizedHome = normalize(homeDir);
      const compareFull = process.platform === 'win32'
        ? normalizedFull.toLowerCase()
        : normalizedFull;
      const compareHome = process.platform === 'win32'
        ? normalizedHome.toLowerCase()
        : normalizedHome;
      if (compareFull.startsWith(compareHome)) {
        // Use normalized path length and normalize the result for consistent display
        const remainder = normalizedFull.slice(normalizedHome.length);
        return '~' + remainder;
      }
    } catch {
      // Fall through to return full path
    }
    return fullPath;
  }

  updateDisplay() {
    if (!this.iconEl || !this.badgeEl) return;

    const count = this.externalContextPaths.length;

    if (count > 0) {
      this.iconEl.addClass('active');
      this.iconEl.setAttribute('title', `${count} external context${count > 1 ? 's' : ''} (click to add more)`);

      // Show badge only when more than 1 path
      if (count > 1) {
        this.badgeEl.setText(String(count));
        this.badgeEl.addClass('visible');
      } else {
        this.badgeEl.removeClass('visible');
      }
    } else {
      this.iconEl.removeClass('active');
      this.iconEl.setAttribute('title', 'Add external contexts (click)');
      this.badgeEl.removeClass('visible');
    }
  }
}

export class McpServerSelector {
  private container: HTMLElement;
  private iconEl: HTMLElement | null = null;
  private badgeEl: HTMLElement | null = null;
  private dropdownEl: HTMLElement | null = null;
  private mcpManager: McpServerManager | null = null;
  private enabledServers: Set<string> = new Set();
  private onChangeCallback: ((enabled: Set<string>) => void) | null = null;

  constructor(parentEl: HTMLElement) {
    this.container = parentEl.createDiv({ cls: 'codexdian-mcp-selector' });
    this.render();
  }

  getElement(): HTMLElement {
    return this.container;
  }

  setMcpManager(manager: McpServerManager | null): void {
    this.mcpManager = manager;
    this.pruneEnabledServers();
    this.updateDisplay();
    this.renderDropdown();
  }

  setOnChange(callback: (enabled: Set<string>) => void): void {
    this.onChangeCallback = callback;
  }

  getEnabledServers(): Set<string> {
    return new Set(this.enabledServers);
  }

  addMentionedServers(names: Set<string>): void {
    let changed = false;
    for (const name of names) {
      if (!this.enabledServers.has(name)) {
        this.enabledServers.add(name);
        changed = true;
      }
    }
    if (changed) {
      this.updateDisplay();
      this.renderDropdown();
    }
  }

  clearEnabled(): void {
    this.enabledServers.clear();
    this.updateDisplay();
    this.renderDropdown();
  }

  setEnabledServers(names: string[]): void {
    this.enabledServers = new Set(names);
    this.pruneEnabledServers();
    this.updateDisplay();
    this.renderDropdown();
  }

  private pruneEnabledServers(): void {
    if (!this.mcpManager) return;
    const activeNames = new Set(this.mcpManager.getServers().filter((s) => s.enabled).map((s) => s.name));
    let changed = false;
    for (const name of this.enabledServers) {
      if (!activeNames.has(name)) {
        this.enabledServers.delete(name);
        changed = true;
      }
    }
    if (changed) {
      this.onChangeCallback?.(this.enabledServers);
    }
  }

  private render() {
    this.container.empty();

    const iconWrapper = this.container.createDiv({ cls: 'codexdian-mcp-selector-icon-wrapper' });

    this.iconEl = iconWrapper.createDiv({ cls: 'codexdian-mcp-selector-icon' });
    this.iconEl.innerHTML = MCP_ICON_SVG;

    this.badgeEl = iconWrapper.createDiv({ cls: 'codexdian-mcp-selector-badge' });

    this.updateDisplay();

    this.dropdownEl = this.container.createDiv({ cls: 'codexdian-mcp-selector-dropdown' });
    this.renderDropdown();

    // Re-render dropdown content on hover (CSS handles visibility)
    this.container.addEventListener('mouseenter', () => {
      this.renderDropdown();
    });
  }

  private renderDropdown() {
    if (!this.dropdownEl) return;
    this.pruneEnabledServers();
    this.dropdownEl.empty();

    // Header
    const headerEl = this.dropdownEl.createDiv({ cls: 'codexdian-mcp-selector-header' });
    headerEl.setText('MCP Servers');

    // Server list
    const listEl = this.dropdownEl.createDiv({ cls: 'codexdian-mcp-selector-list' });

    const allServers = this.mcpManager?.getServers() || [];
    const servers = allServers.filter(s => s.enabled);

    if (servers.length === 0) {
      const emptyEl = listEl.createDiv({ cls: 'codexdian-mcp-selector-empty' });
      emptyEl.setText(allServers.length === 0 ? 'No MCP servers configured' : 'All MCP servers disabled');
      return;
    }

    for (const server of servers) {
      this.renderServerItem(listEl, server);
    }
  }

  private renderServerItem(listEl: HTMLElement, server: CodexdianMcpServer) {
    const itemEl = listEl.createDiv({ cls: 'codexdian-mcp-selector-item' });
    itemEl.dataset.serverName = server.name;

    const isEnabled = this.enabledServers.has(server.name);
    if (isEnabled) {
      itemEl.addClass('enabled');
    }

    // Checkbox
    const checkEl = itemEl.createDiv({ cls: 'codexdian-mcp-selector-check' });
    if (isEnabled) {
      checkEl.innerHTML = CHECK_ICON_SVG;
    }

    // Info
    const infoEl = itemEl.createDiv({ cls: 'codexdian-mcp-selector-item-info' });

    const nameEl = infoEl.createSpan({ cls: 'codexdian-mcp-selector-item-name' });
    nameEl.setText(server.name);

    // Badges
    if (server.contextSaving) {
      const csEl = infoEl.createSpan({ cls: 'codexdian-mcp-selector-cs-badge' });
      csEl.setText('@');
      csEl.setAttribute('title', 'Context-saving: can also enable via @' + server.name);
    }

    // Click to toggle (use mousedown for more reliable capture)
    itemEl.addEventListener('mousedown', (e) => {
      e.preventDefault();
      e.stopPropagation();
      this.toggleServer(server.name, itemEl);
    });
  }

  private toggleServer(name: string, itemEl: HTMLElement) {
    if (this.enabledServers.has(name)) {
      this.enabledServers.delete(name);
    } else {
      this.enabledServers.add(name);
    }

    // Update item visually in-place (immediate feedback)
    const isEnabled = this.enabledServers.has(name);
    const checkEl = itemEl.querySelector('.codexdian-mcp-selector-check') as HTMLElement | null;

    if (isEnabled) {
      itemEl.addClass('enabled');
      if (checkEl) checkEl.innerHTML = CHECK_ICON_SVG;
    } else {
      itemEl.removeClass('enabled');
      if (checkEl) checkEl.innerHTML = '';
    }

    this.updateDisplay();
    this.onChangeCallback?.(this.enabledServers);
  }

  updateDisplay() {
    this.pruneEnabledServers();
    if (!this.iconEl || !this.badgeEl) return;

    const count = this.enabledServers.size;
    const hasServers = (this.mcpManager?.getServers().length || 0) > 0;

    // Show/hide container based on whether there are servers
    if (!hasServers) {
      this.container.style.display = 'none';
      return;
    }
    this.container.style.display = '';

    if (count > 0) {
      this.iconEl.addClass('active');
      this.iconEl.setAttribute('title', `${count} MCP server${count > 1 ? 's' : ''} enabled (click to manage)`);

      // Show badge only when more than 1
      if (count > 1) {
        this.badgeEl.setText(String(count));
        this.badgeEl.addClass('visible');
      } else {
        this.badgeEl.removeClass('visible');
      }
    } else {
      this.iconEl.removeClass('active');
      this.iconEl.setAttribute('title', 'MCP servers (click to enable)');
      this.badgeEl.removeClass('visible');
    }
  }
}

export class ContextUsageMeter {
  private container: HTMLElement;
  private fillPath: SVGPathElement | null = null;
  private percentEl: HTMLElement | null = null;
  private circumference: number = 0;

  constructor(parentEl: HTMLElement) {
    this.container = parentEl.createDiv({ cls: 'codexdian-context-meter' });
    this.render();
    // Initially hidden
    this.container.style.display = 'none';
  }

  getElement(): HTMLElement {
    return this.container;
  }

  private render() {
    const size = 16;
    const strokeWidth = 2;
    const radius = (size - strokeWidth) / 2;
    const cx = size / 2;
    const cy = size / 2;

    // 240° arc: from 150° to 390° (upper-left through bottom to upper-right)
    const startAngle = 150;
    const endAngle = 390;
    const arcDegrees = endAngle - startAngle;
    const arcRadians = (arcDegrees * Math.PI) / 180;
    this.circumference = radius * arcRadians;

    const startRad = (startAngle * Math.PI) / 180;
    const endRad = (endAngle * Math.PI) / 180;
    const x1 = cx + radius * Math.cos(startRad);
    const y1 = cy + radius * Math.sin(startRad);
    const x2 = cx + radius * Math.cos(endRad);
    const y2 = cy + radius * Math.sin(endRad);

    const gaugeEl = this.container.createDiv({ cls: 'codexdian-context-meter-gauge' });
    gaugeEl.innerHTML = `
      <svg width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">
        <path class="codexdian-meter-bg"
          d="M ${x1} ${y1} A ${radius} ${radius} 0 1 1 ${x2} ${y2}"
          fill="none" stroke-width="${strokeWidth}" stroke-linecap="round"/>
        <path class="codexdian-meter-fill"
          d="M ${x1} ${y1} A ${radius} ${radius} 0 1 1 ${x2} ${y2}"
          fill="none" stroke-width="${strokeWidth}" stroke-linecap="round"
          stroke-dasharray="${this.circumference}" stroke-dashoffset="${this.circumference}"/>
      </svg>
    `;
    this.fillPath = gaugeEl.querySelector('.codexdian-meter-fill');

    this.percentEl = this.container.createSpan({ cls: 'codexdian-context-meter-percent' });
  }

  update(usage: UsageInfo | null): void {
    if (!usage || usage.contextTokens <= 0) {
      this.container.style.display = 'none';
      return;
    }
    this.container.style.display = 'flex';
    const fillLength = (usage.percentage / 100) * this.circumference;
    if (this.fillPath) {
      this.fillPath.style.strokeDashoffset = String(this.circumference - fillLength);
    }

    if (this.percentEl) {
      this.percentEl.setText(`${usage.percentage}%`);
    }

    // Toggle warning class for > 80%
    if (usage.percentage > 80) {
      this.container.addClass('warning');
    } else {
      this.container.removeClass('warning');
    }

    // Set tooltip with detailed usage
    let tooltip = `${this.formatTokens(usage.contextTokens)} / ${this.formatTokens(usage.contextWindow)}`;
    if (usage.percentage > 80) {
      tooltip += ' (Approaching limit, run `/compact` to continue)';
    }
    this.container.setAttribute('data-tooltip', tooltip);
    this.container.setAttribute('title', `Context usage: ${tooltip}`);
  }

  private formatTokens(tokens: number): string {
    if (tokens >= 1000) {
      return `${Math.round(tokens / 1000)}k`;
    }
    return String(tokens);
  }
}

interface ToolbarOverflowItem {
  id: string;
  label: string;
  description: string;
  element: HTMLElement;
  canOverflow?: boolean;
}

class ToolbarOverflowMenu {
  private parentEl: HTMLElement;
  private container: HTMLElement;
  private buttonEl: HTMLElement;
  private dropdownEl: HTMLElement;
  private items: ToolbarOverflowItem[];
  private hiddenIds = new Set<string>();
  private resizeObserver: ResizeObserver | null = null;
  private scheduled = false;

  constructor(parentEl: HTMLElement, items: ToolbarOverflowItem[]) {
    this.parentEl = parentEl;
    this.items = items;
    this.container = parentEl.createDiv({ cls: 'codexdian-toolbar-overflow' });
    this.buttonEl = this.container.createDiv({ cls: 'codexdian-toolbar-overflow-btn', text: '...' });
    this.buttonEl.setAttribute('title', 'More toolbar settings');
    this.dropdownEl = this.container.createDiv({ cls: 'codexdian-toolbar-overflow-menu' });

    this.buttonEl.addEventListener('click', (event) => {
      event.stopPropagation();
      this.container.toggleClass('open', !this.container.hasClass('open'));
    });

    if (typeof document !== 'undefined') {
      document.addEventListener('click', () => this.container.removeClass('open'));
    }

    if (typeof ResizeObserver !== 'undefined') {
      this.resizeObserver = new ResizeObserver(() => this.scheduleUpdate());
      this.resizeObserver.observe(parentEl);
    }

    this.scheduleUpdate();
  }

  private scheduleUpdate(): void {
    if (this.scheduled) return;
    this.scheduled = true;
    const requestFrame = typeof window !== 'undefined' && window.requestAnimationFrame
      ? window.requestAnimationFrame.bind(window)
      : (callback: FrameRequestCallback) => setTimeout(callback, 0);
    requestFrame(() => {
      this.scheduled = false;
      this.update();
    });
  }

  update(): void {
    const availableWidth = this.parentEl.clientWidth;
    if (!availableWidth) {
      this.container.style.display = 'none';
      return;
    }

    this.restoreItems();
    const candidates = this.items.filter(item => item.canOverflow !== false && this.isRenderable(item.element));
    const overflowWidth = this.measureElement(this.container) || 34;
    let usedWidth = this.items
      .filter(item => this.isRenderable(item.element))
      .reduce((sum, item) => sum + this.measureElement(item.element), 0);

    this.container.style.display = 'none';
    this.hiddenIds.clear();

    for (const item of [...candidates].reverse()) {
      if (usedWidth <= availableWidth) break;
      this.hiddenIds.add(item.id);
      usedWidth -= this.measureElement(item.element);
      usedWidth += this.hiddenIds.size === 1 ? overflowWidth : 0;
    }

    if (this.hiddenIds.size === 0) {
      this.dropdownEl.empty();
      this.container.removeClass('open');
      this.container.style.display = 'none';
      return;
    }

    this.container.style.display = 'flex';
    this.renderDropdown();
  }

  private restoreItems(): void {
    for (const item of this.items) {
      if (item.element.parentElement !== this.parentEl) {
        this.parentEl.insertBefore(item.element, this.container);
      }
    }
  }

  private renderDropdown(): void {
    this.dropdownEl.empty();

    for (const item of this.items.filter(entry => this.hiddenIds.has(entry.id))) {
      const rowEl = this.dropdownEl.createDiv({ cls: 'codexdian-toolbar-overflow-row' });
      const infoEl = rowEl.createDiv({ cls: 'codexdian-toolbar-overflow-info' });
      infoEl.createSpan({ cls: 'codexdian-toolbar-overflow-label', text: item.label });
      infoEl.createSpan({ cls: 'codexdian-toolbar-overflow-desc', text: item.description });
      const controlEl = rowEl.createDiv({ cls: 'codexdian-toolbar-overflow-control' });
      controlEl.appendChild(item.element);
    }
  }

  private isRenderable(element: HTMLElement): boolean {
    return element.style.display !== 'none';
  }

  private measureElement(element: HTMLElement): number {
    const rectWidth = element.getBoundingClientRect?.().width ?? 0;
    const baseWidth = element.offsetWidth || rectWidth || this.estimateWidth(element);
    const style = typeof window !== 'undefined' ? window.getComputedStyle?.(element) : null;
    const marginLeft = style ? parseFloat(style.marginLeft || '0') || 0 : 0;
    const marginRight = style ? parseFloat(style.marginRight || '0') || 0 : 0;
    return baseWidth + marginLeft + marginRight;
  }

  private estimateWidth(element: HTMLElement): number {
    if (element.hasClass('codexdian-model-selector')) return 142;
    if (element.hasClass('codexdian-thinking-selector')) return 76;
    if (element.hasClass('codexdian-service-tier-selector')) return 66;
    if (element.hasClass('codexdian-verbosity-selector')) return 76;
    if (element.hasClass('codexdian-context-meter')) return 62;
    if (element.hasClass('codexdian-external-context-selector')) return 36;
    if (element.hasClass('codexdian-mcp-selector')) return 36;
    if (element.hasClass('codexdian-permission-toggle')) return 78;
    if (element.hasClass('codexdian-running-indicator')) return 82;
    return 48;
  }
}

export function createInputToolbar(
  parentEl: HTMLElement,
  callbacks: ToolbarCallbacks
): {
  modelSelector: ModelSelector;
  thinkingBudgetSelector: ThinkingBudgetSelector;
  serviceTierSelector: ServiceTierSelector;
  verbositySelector: VerbositySelector;
  runningIndicator: RunningIndicator;
  overflowMenu: ToolbarOverflowMenu;
  contextUsageMeter: ContextUsageMeter | null;
  externalContextSelector: ExternalContextSelector;
  mcpServerSelector: McpServerSelector;
  permissionToggle: PermissionToggle;
} {
  const modelSelector = new ModelSelector(parentEl, callbacks);
  const thinkingBudgetSelector = new ThinkingBudgetSelector(parentEl, callbacks);
  const serviceTierSelector = new ServiceTierSelector(parentEl, callbacks);
  const verbositySelector = new VerbositySelector(parentEl, callbacks);
  const runningIndicator = new RunningIndicator(parentEl);
  const contextUsageMeter = new ContextUsageMeter(parentEl);
  const externalContextSelector = new ExternalContextSelector(parentEl, callbacks);
  const mcpServerSelector = new McpServerSelector(parentEl);
  const permissionToggle = new PermissionToggle(parentEl, callbacks);
  const overflowMenu = new ToolbarOverflowMenu(parentEl, [
    {
      id: 'model',
      label: 'Model',
      description: 'Choose which Codex model answers this chat.',
      element: modelSelector.getElement(),
      canOverflow: true,
    },
    {
      id: 'thinking',
      label: 'Reasoning',
      description: 'Balance answer speed and depth.',
      element: thinkingBudgetSelector.getElement(),
      canOverflow: true,
    },
    {
      id: 'service-tier',
      label: 'Mode',
      description: 'Auto, Fast, or Flex service tier.',
      element: serviceTierSelector.getElement(),
    },
    {
      id: 'verbosity',
      label: 'Verbosity',
      description: 'Brief, Normal, or Detailed responses.',
      element: verbositySelector.getElement(),
    },
    {
      id: 'running',
      label: 'Status',
      description: 'Shows whether Codex is currently running.',
      element: runningIndicator.getElement(),
    },
    {
      id: 'context',
      label: 'Context',
      description: 'Current context-window usage.',
      element: contextUsageMeter.getElement(),
    },
    {
      id: 'external-context',
      label: 'Folders',
      description: 'Add extra folders to the current Codex session.',
      element: externalContextSelector.getElement(),
    },
    {
      id: 'mcp',
      label: 'MCP',
      description: 'Enable MCP servers for this chat.',
      element: mcpServerSelector.getElement(),
    },
    {
      id: 'permission',
      label: 'Permissions',
      description: 'Switch between Safe, YOLO, and Plan behavior.',
      element: permissionToggle.getElement(),
    },
  ]);

  return {
    modelSelector,
    thinkingBudgetSelector,
    serviceTierSelector,
    verbositySelector,
    runningIndicator,
    overflowMenu,
    contextUsageMeter,
    externalContextSelector,
    mcpServerSelector,
    permissionToggle,
  };
}
