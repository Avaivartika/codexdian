import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { spawn } from 'node:child_process';
import * as path from 'node:path';

import { EventEmitter } from 'events';

interface StartOptions {
  cliPath: string;
  cwd: string;
  env: NodeJS.ProcessEnv;
}

function isJavaScriptEntry(cliPath: string): boolean {
  return cliPath.endsWith('.js') || cliPath.endsWith('.mjs') || cliPath.endsWith('.cjs');
}

function resolveNodeExecutable(cliPath: string): string {
  const dirname = path.dirname(cliPath);
  const candidate = process.platform === 'win32'
    ? path.join(dirname, 'node.exe')
    : path.join(dirname, 'node');

  return candidate;
}

export interface CodexProcessEvents {
  stdout: (line: string) => void;
  stderr: (line: string) => void;
  exit: (code: number | null, signal: NodeJS.Signals | null) => void;
  error: (error: Error) => void;
}

export class CodexProcessManager extends EventEmitter {
  private child: ChildProcessWithoutNullStreams | null = null;
  private stdoutBuffer = '';
  private stderrBuffer = '';

  start(options: StartOptions): void {
    this.stop();

    const args = isJavaScriptEntry(options.cliPath)
      ? [options.cliPath, 'app-server', '--listen', 'stdio://']
      : ['app-server', '--listen', 'stdio://'];
    const command = isJavaScriptEntry(options.cliPath)
      ? resolveNodeExecutable(options.cliPath)
      : options.cliPath;

    this.child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    this.child.stdout.setEncoding('utf8');
    this.child.stderr.setEncoding('utf8');

    this.child.stdout.on('data', (chunk: string) => {
      this.stdoutBuffer += chunk;
      this.flushBuffer('stdout');
    });

    this.child.stderr.on('data', (chunk: string) => {
      this.stderrBuffer += chunk;
      this.flushBuffer('stderr');
    });

    this.child.on('error', (error) => this.emit('error', error));
    this.child.on('exit', (code, signal) => {
      this.child = null;
      this.emit('exit', code, signal);
    });
  }

  write(line: string): void {
    if (!this.child?.stdin.writable) {
      throw new Error('Codex app-server is not writable.');
    }

    this.child.stdin.write(`${line}\n`);
  }

  stop(): void {
    if (!this.child) {
      return;
    }

    try {
      this.child.kill();
    } catch {
      // Ignore process shutdown failures.
    }

    this.child = null;
    this.stdoutBuffer = '';
    this.stderrBuffer = '';
  }

  isRunning(): boolean {
    return !!this.child;
  }

  private flushBuffer(kind: 'stdout' | 'stderr'): void {
    const key = kind === 'stdout' ? 'stdoutBuffer' : 'stderrBuffer';
    let buffer = this[key];
    let newlineIndex = buffer.indexOf('\n');

    while (newlineIndex >= 0) {
      const line = buffer.slice(0, newlineIndex).trim();
      buffer = buffer.slice(newlineIndex + 1);
      if (line.length > 0) {
        this.emit(kind, line);
      }
      newlineIndex = buffer.indexOf('\n');
    }

    this[key] = buffer;
  }
}
