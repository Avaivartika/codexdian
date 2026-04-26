import { Notice, setIcon } from 'obsidian';

import type { CodexdianPlugin as CodexdianPluginType } from '../../../core/types';
import type CodexdianPlugin from '../../../main';

export class PluginSettingsManager {
  private containerEl: HTMLElement;
  private plugin: CodexdianPlugin;

  constructor(containerEl: HTMLElement, plugin: CodexdianPlugin) {
    this.containerEl = containerEl;
    this.plugin = plugin;
    this.render();
  }

  private render() {
    this.containerEl.empty();

    const headerEl = this.containerEl.createDiv({ cls: 'codexdian-plugin-header' });
    headerEl.createSpan({ text: 'Codex Plugins', cls: 'codexdian-plugin-label' });

    const refreshBtn = headerEl.createEl('button', {
      cls: 'codexdian-settings-action-btn',
      attr: { 'aria-label': 'Refresh' },
    });
    setIcon(refreshBtn, 'refresh-cw');
    refreshBtn.addEventListener('click', () => this.refreshPlugins());

    const plugins = this.plugin.pluginManager.getPlugins();

    if (plugins.length === 0) {
      const emptyEl = this.containerEl.createDiv({ cls: 'codexdian-plugin-empty' });
      emptyEl.setText('No Codex plugins found. Enable plugins via the Codex CLI.');
      return;
    }

    const projectPlugins = plugins.filter(p => p.scope === 'project');
    const userPlugins = plugins.filter(p => p.scope === 'user');

    const listEl = this.containerEl.createDiv({ cls: 'codexdian-plugin-list' });

    if (projectPlugins.length > 0) {
      const sectionHeader = listEl.createDiv({ cls: 'codexdian-plugin-section-header' });
      sectionHeader.setText('Project Plugins');

      for (const plugin of projectPlugins) {
        this.renderPluginItem(listEl, plugin);
      }
    }

    if (userPlugins.length > 0) {
      const sectionHeader = listEl.createDiv({ cls: 'codexdian-plugin-section-header' });
      sectionHeader.setText('User Plugins');

      for (const plugin of userPlugins) {
        this.renderPluginItem(listEl, plugin);
      }
    }
  }

  private renderPluginItem(listEl: HTMLElement, plugin: CodexdianPluginType) {
    const itemEl = listEl.createDiv({ cls: 'codexdian-plugin-item' });
    if (!plugin.enabled) {
      itemEl.addClass('codexdian-plugin-item-disabled');
    }

    const statusEl = itemEl.createDiv({ cls: 'codexdian-plugin-status' });
    if (plugin.enabled) {
      statusEl.addClass('codexdian-plugin-status-enabled');
    } else {
      statusEl.addClass('codexdian-plugin-status-disabled');
    }

    const infoEl = itemEl.createDiv({ cls: 'codexdian-plugin-info' });

    const nameRow = infoEl.createDiv({ cls: 'codexdian-plugin-name-row' });

    const nameEl = nameRow.createSpan({ cls: 'codexdian-plugin-name' });
    nameEl.setText(plugin.name);

    const actionsEl = itemEl.createDiv({ cls: 'codexdian-plugin-actions' });

    const toggleBtn = actionsEl.createEl('button', {
      cls: 'codexdian-plugin-action-btn',
      attr: { 'aria-label': plugin.enabled ? 'Disable' : 'Enable' },
    });
    setIcon(toggleBtn, plugin.enabled ? 'toggle-right' : 'toggle-left');
    toggleBtn.addEventListener('click', () => this.togglePlugin(plugin.id));
  }

  private async togglePlugin(pluginId: string) {
    const plugin = this.plugin.pluginManager.getPlugins().find(p => p.id === pluginId);
    const wasEnabled = plugin?.enabled ?? false;

    try {
      await this.plugin.pluginManager.togglePlugin(pluginId);
      await this.plugin.agentManager.loadAgents();

      const view = this.plugin.getView();
      const tabManager = view?.getTabManager();
      if (tabManager) {
        try {
          await tabManager.broadcastToAllTabs(
            async (service) => { await service.ensureReady({ force: true }); }
          );
        } catch {
          new Notice('Plugin toggled, but some tabs failed to restart.');
        }
      }

      new Notice(`Plugin "${pluginId}" ${wasEnabled ? 'disabled' : 'enabled'}`);
    } catch (err) {
      await this.plugin.pluginManager.togglePlugin(pluginId);
      const message = err instanceof Error ? err.message : 'Unknown error';
      new Notice(`Failed to toggle plugin: ${message}`);
    } finally {
      this.render();
    }
  }

  private async refreshPlugins() {
    try {
      await this.plugin.pluginManager.loadPlugins();
      await this.plugin.agentManager.loadAgents();

      new Notice('Plugin list refreshed');
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown error';
      new Notice(`Failed to refresh plugins: ${message}`);
    } finally {
      this.render();
    }
  }

  public refresh() {
    this.render();
  }
}
