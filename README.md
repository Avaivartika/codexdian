# Codexdian

Codexdian is an Obsidian desktop plugin that embeds Codex CLI into your vault. It lets Codex work directly inside the vault as a coding and knowledge-management collaborator with file editing, search, terminal execution, multi-step workflows, agents, skills, and MCP integrations.

This backup repo is intentionally sanitized for public upload.

## Included

- `manifest.json`
- `main.js`
- `styles.css`

## Excluded for Privacy

This repo does **not** include:

- `data.json` local plugin state
- API keys, auth tokens, or custom headers
- personal vault content
- local conversation/session records
- `.codex/config.toml` or other user-specific Codex config files

If you use private endpoints or keys, configure them locally after installation and do not commit them.

## Requirements

- Obsidian `>= 1.4.5`
- Desktop Obsidian
- Codex CLI installed and available in `PATH`

No extra Obsidian community plugins are required.

## Install

1. Install Codex CLI and confirm `which codex` works in your terminal.
2. Copy this folder to your vault plugin path:
   - `.obsidian/plugins/codexdian/`
3. Make sure these files exist in that folder:
   - `manifest.json`
   - `main.js`
   - `styles.css`
4. In Obsidian:
   - `Settings -> Community plugins -> Reload plugins`
   - Enable `Codexdian`
5. Configure local environment variables or Codex config on your own machine if needed.

## Optional Ecosystem Pieces

Codexdian can work with these optional local components:

- `~/.codex/skills`
  - User-installed Codex skills
- `.codex/agents` or `~/.codex/agents`
  - Custom agents / subagents
- `.codex/config.toml` or `~/.codex/config.toml`
  - Codex CLI config
- `~/.codex/plugins`
  - Optional Codex plugins discovered by the CLI
- `.codex/mcp.json`
  - MCP server definitions
- `AGENTS.md` / `CODEX.md`
  - Vault-level working instructions that Codex can read and follow
- `codex-in-chrome`
  - Optional browser extension for Chrome integration

## Notes

- This repository currently ships the built plugin bundle directly.
- Some internal CSS class names and implementation identifiers still use legacy `claudian-*` naming from the earlier codebase. That does not affect runtime usage.

## Publish to GitHub

If you want to push this sanitized backup to a new GitHub repository:

```bash
cd codexdian-github
git init
git branch -M main
git add .
git commit -m "Initial Codexdian backup"
git remote add origin <your-github-repo-url>
git push -u origin main
```

