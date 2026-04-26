import type { ServerNotification } from '../../../generated/ServerNotification';
import type { ThreadItem } from '../../../generated/v2/ThreadItem';
import type { EffortLevel, ThinkingBudget } from '../types';
import { isAdaptiveThinkingModel, THINKING_BUDGETS } from '../types';
import { CodexAppServerClient } from './CodexAppServerClient';

export interface CodexTextQueryOptions {
  cliPath: string;
  cwd: string;
  env: NodeJS.ProcessEnv;
  model: string;
  systemPrompt: string;
  prompt: string;
  effortLevel: EffortLevel;
  thinkingBudget: ThinkingBudget;
  resumeThreadId?: string | null;
  onTextDelta?: (text: string) => void;
  signal?: AbortSignal;
}

export interface CodexTextQueryResult {
  text: string;
  threadId: string;
}

function buildTextInput(prompt: string) {
  return [{ type: 'text' as const, text: prompt, text_elements: [] }];
}

function appendCompletedMessageText(
  item: ThreadItem,
  chunks: string[],
  completedAgentItems: Set<string>
): void {
  if (item.type !== 'agentMessage' || completedAgentItems.has(item.id) || !item.text) {
    return;
  }

  completedAgentItems.add(item.id);
  chunks.push(item.text);
}

export async function runCodexTextQuery(options: CodexTextQueryOptions): Promise<CodexTextQueryResult> {
  const client = new CodexAppServerClient();
  const chunks: string[] = [];
  const seenDeltaItems = new Set<string>();
  const completedAgentItems = new Set<string>();
  let threadId: string | null = null;
  let turnId: string | null = null;
  let completed = false;

  const unsubscribeNotification = client.onNotification((notification: ServerNotification) => {
    switch (notification.method) {
      case 'thread/started':
        threadId = notification.params.thread.id;
        break;

      case 'turn/started':
        turnId = notification.params.turn.id;
        break;

      case 'item/agentMessage/delta':
        seenDeltaItems.add(notification.params.itemId);
        chunks.push(notification.params.delta);
        options.onTextDelta?.(chunks.join(''));
        break;

      case 'item/completed':
        if (notification.params.item.type === 'agentMessage' && !seenDeltaItems.has(notification.params.item.id)) {
          appendCompletedMessageText(notification.params.item, chunks, completedAgentItems);
          if (notification.params.item.text) {
            options.onTextDelta?.(chunks.join(''));
          }
        }
        break;

      case 'turn/completed':
        break;

      case 'error':
        break;
    }
  });

  const completion = new Promise<void>((resolve, reject) => {
    let settled = false;
    const settleResolve = () => {
      if (settled) {
        return;
      }
      settled = true;
      unsubscribeCompletionNotification();
      unsubscribeStderr();
      resolve();
    };
    const settleReject = (error: Error) => {
      if (settled) {
        return;
      }
      settled = true;
      unsubscribeCompletionNotification();
      unsubscribeStderr();
      reject(error);
    };
    const onNotification = (notification: ServerNotification) => {
      switch (notification.method) {
        case 'turn/completed':
          if (notification.params.turn.status === 'failed' && notification.params.turn.error?.message) {
            settleReject(new Error(notification.params.turn.error.message));
            return;
          }
          if (notification.params.turn.status === 'interrupted') {
            settleReject(new Error('Cancelled'));
            return;
          }
          completed = true;
          settleResolve();
          return;

        case 'error':
          settleReject(new Error(notification.params.error.message));
          return;
      }
    };

    const unsubscribeCompletionNotification = client.onNotification(onNotification);
    const unsubscribeStderr = client.onStderr((line) => {
      if (!completed && line.trim()) {
        settleReject(new Error(line.trim()));
      }
    });

    options.signal?.addEventListener('abort', () => {
      if (threadId && turnId) {
        void client.request({
          method: 'turn/interrupt',
          params: { threadId, turnId },
        }).catch(() => {
          // Ignore interruption errors.
        });
      } else {
        settleReject(new Error('Cancelled'));
      }
    }, { once: true });

    void (async () => {
      try {
        client.start(options.cliPath, options.cwd, options.env);

        await client.request({
          method: 'initialize',
          params: {
            clientInfo: {
              name: 'codexdian',
              title: 'Codexdian',
              version: '1.0.0',
            },
            capabilities: {
              experimentalApi: false,
              optOutNotificationMethods: [],
            },
          },
        });

        const threadResponse = options.resumeThreadId
          ? await client.request<{ thread: { id: string } }>({
            method: 'thread/resume',
            params: {
              threadId: options.resumeThreadId,
              model: options.model,
              cwd: options.cwd,
              approvalPolicy: 'never',
              sandbox: 'workspace-write',
              developerInstructions: options.systemPrompt,
              persistExtendedHistory: false,
            },
          })
          : await client.request<{ thread: { id: string } }>({
            method: 'thread/start',
            params: {
              model: options.model,
              cwd: options.cwd,
              approvalPolicy: 'never',
              sandbox: 'workspace-write',
              developerInstructions: options.systemPrompt,
              persistExtendedHistory: false,
              ephemeral: true,
              experimentalRawEvents: false,
              baseInstructions: null,
              config: null,
            },
          });

        threadId = threadResponse.thread.id;

        const thinkingBudget = THINKING_BUDGETS.find(entry => entry.value === options.thinkingBudget);
        const effort = isAdaptiveThinkingModel(options.model)
          ? (options.effortLevel === 'max' ? 'high' : options.effortLevel)
          : null;

        const turnResponse = await client.request<{ turn: { id: string } }>({
          method: 'turn/start',
          params: {
            threadId,
            input: buildTextInput(options.prompt),
            cwd: options.cwd,
            approvalPolicy: 'never',
            sandboxPolicy: {
              type: 'workspaceWrite',
              writableRoots: [options.cwd],
              readOnlyAccess: {
                type: 'restricted',
                includePlatformDefaults: true,
                readableRoots: [options.cwd],
              },
              networkAccess: false,
              excludeTmpdirEnvVar: false,
              excludeSlashTmp: false,
            },
            model: options.model,
            effort,
            summary: thinkingBudget && thinkingBudget.tokens > 0 ? 'auto' : null,
          },
        });

        turnId = turnResponse.turn.id;
      } catch (error) {
        settleReject(error instanceof Error ? error : new Error(String(error)));
      }
    })();
  });

  try {
    await completion;
  } finally {
    unsubscribeNotification();
    client.stop();
  }

  if (!threadId) {
    throw new Error('No Codex thread created');
  }

  return {
    text: chunks.join(''),
    threadId,
  };
}
