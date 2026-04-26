import type { ClientRequest } from '../../../generated/ClientRequest';
import type { ServerNotification } from '../../../generated/ServerNotification';
import type { ServerRequest } from '../../../generated/ServerRequest';
import { CodexProcessManager } from './CodexProcessManager';

type RequestId = string | number;

interface JsonRpcSuccess {
  id: RequestId;
  result: unknown;
}

interface JsonRpcError {
  id: RequestId | null;
  error: {
    code: number;
    message: string;
    data?: unknown;
  };
}

function isServerNotification(payload: unknown): payload is ServerNotification {
  return !!payload && typeof payload === 'object' && 'method' in payload && !('id' in payload);
}

function isServerRequest(payload: unknown): payload is ServerRequest {
  return !!payload && typeof payload === 'object' && 'method' in payload && 'id' in payload;
}

function isJsonRpcSuccess(payload: unknown): payload is JsonRpcSuccess {
  return !!payload && typeof payload === 'object' && 'id' in payload && 'result' in payload;
}

function isJsonRpcError(payload: unknown): payload is JsonRpcError {
  return !!payload && typeof payload === 'object' && 'error' in payload;
}

export class CodexAppServerClient {
  private processManager = new CodexProcessManager();
  private requestId = 0;
  private pending = new Map<RequestId, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
  private notificationListeners = new Set<(notification: ServerNotification) => void>();
  private requestListeners = new Set<(request: ServerRequest) => void>();
  private stderrListeners = new Set<(line: string) => void>();

  constructor() {
    this.processManager.on('stdout', (line: string) => this.handleStdout(line));
    this.processManager.on('stderr', (line: string) => {
      for (const listener of this.stderrListeners) {
        listener(line);
      }
    });
    this.processManager.on('exit', (code, signal) => {
      const error = new Error(`Codex app-server exited (${code ?? 'null'}${signal ? `, ${signal}` : ''})`);
      for (const pending of this.pending.values()) {
        pending.reject(error);
      }
      this.pending.clear();
    });
    this.processManager.on('error', (error: Error) => {
      for (const pending of this.pending.values()) {
        pending.reject(error);
      }
      this.pending.clear();
    });
  }

  start(cliPath: string, cwd: string, env: NodeJS.ProcessEnv): void {
    this.processManager.start({ cliPath, cwd, env });
  }

  stop(): void {
    this.processManager.stop();
  }

  isRunning(): boolean {
    return this.processManager.isRunning();
  }

  onNotification(listener: (notification: ServerNotification) => void): () => void {
    this.notificationListeners.add(listener);
    return () => this.notificationListeners.delete(listener);
  }

  onRequest(listener: (request: ServerRequest) => void): () => void {
    this.requestListeners.add(listener);
    return () => this.requestListeners.delete(listener);
  }

  onStderr(listener: (line: string) => void): () => void {
    this.stderrListeners.add(listener);
    return () => this.stderrListeners.delete(listener);
  }

  async request<T = unknown>(payload: Omit<ClientRequest, 'id'>): Promise<T> {
    const id = ++this.requestId;
    const message = { ...payload, id };

    return await new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (value: unknown) => void, reject });
      this.processManager.write(JSON.stringify(message));
    });
  }

  respond(id: RequestId, result: unknown): void {
    this.processManager.write(JSON.stringify({ id, result }));
  }

  respondError(id: RequestId, code: number, message: string, data?: unknown): void {
    this.processManager.write(JSON.stringify({ id, error: { code, message, data } }));
  }

  private handleStdout(line: string): void {
    let parsed: unknown;

    try {
      parsed = JSON.parse(line);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown parse error';
      for (const listener of this.stderrListeners) {
        listener(`Failed to parse Codex app-server JSON: ${message}`);
      }
      return;
    }

    if (isServerNotification(parsed)) {
      for (const listener of this.notificationListeners) {
        listener(parsed);
      }
      return;
    }

    if (isServerRequest(parsed)) {
      for (const listener of this.requestListeners) {
        listener(parsed);
      }
      return;
    }

    if (isJsonRpcSuccess(parsed)) {
      const pending = this.pending.get(parsed.id);
      if (pending) {
        this.pending.delete(parsed.id);
        pending.resolve(parsed.result);
      }
      return;
    }

    if (isJsonRpcError(parsed)) {
      const pending = parsed.id !== null ? this.pending.get(parsed.id) : undefined;
      if (pending && parsed.id !== null) {
        this.pending.delete(parsed.id);
        pending.reject(new Error(parsed.error.message));
      }
    }
  }
}
