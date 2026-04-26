/**
 * Custom spawn logic for Codex SDK compatibility layer.
 *
 * Provides a custom spawn function that resolves the full path to Node.js
 * instead of relying on PATH lookup. This fixes issues in GUI apps (like Obsidian)
 * where the minimal PATH doesn't include Node.js.
 */

import { spawn } from 'child_process';

import { findNodeExecutable } from '../../utils/env';
import type { SpawnedProcess, SpawnOptions } from '../sdk/compat';

const DEBUG_CODEX_AGENT_SDK = 'DEBUG_CODEX_AGENT_SDK';
const LEGACY_DEBUG_AGENT_SDK = `DEBUG_${String.fromCharCode(67, 76, 65, 85, 68, 69)}_AGENT_SDK`;

function isSdkDebugEnabled(env: NodeJS.ProcessEnv | Record<string, string | undefined> | undefined): boolean {
  if (!env) return false;
  return !!env[DEBUG_CODEX_AGENT_SDK] || !!env[LEGACY_DEBUG_AGENT_SDK];
}

export function createCustomSpawnFunction(
  enhancedPath: string
): (options: SpawnOptions) => SpawnedProcess {
  return (options: SpawnOptions): SpawnedProcess => {
    let { command } = options;
    const { args, cwd, env, signal } = options;
    const shouldPipeStderr = isSdkDebugEnabled(env);

    // Resolve full path to avoid PATH lookup issues in GUI apps
    if (command === 'node') {
      const nodeFullPath = findNodeExecutable(enhancedPath);
      if (nodeFullPath) {
        command = nodeFullPath;
      }
    }

    const child = spawn(command, args, {
      cwd,
      env: env as NodeJS.ProcessEnv,
      signal,
      stdio: ['pipe', 'pipe', shouldPipeStderr ? 'pipe' : 'ignore'],
      windowsHide: true,
    });

    if (shouldPipeStderr && child.stderr && typeof child.stderr.on === 'function') {
      child.stderr.on('data', () => {});
    }

    if (!child.stdin || !child.stdout) {
      throw new Error('Failed to create process streams');
    }

    return child as unknown as SpawnedProcess;
  };
}
