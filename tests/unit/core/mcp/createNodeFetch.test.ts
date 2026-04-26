import * as http from 'http';
import type { AddressInfo } from 'net';

import { createNodeFetch } from '@/core/mcp/McpTester';

interface ReceivedRequest {
  method: string;
  url: string;
  headers: http.IncomingHttpHeaders;
  body: string;
}

function createTestServer(handler?: (req: ReceivedRequest, res: http.ServerResponse) => void): {
  server: http.Server;
  getUrl: () => string;
  received: ReceivedRequest[];
  listenError: Error | null;
} {
  const received: ReceivedRequest[] = [];

  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      const entry: ReceivedRequest = {
        method: req.method ?? 'GET',
        url: req.url ?? '/',
        headers: req.headers,
        body: Buffer.concat(chunks).toString('utf-8'),
      };
      received.push(entry);

      if (handler) {
        handler(entry, res);
      } else {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
      }
    });
  });

  let listenError: Error | null = null;
  server.on('error', (error) => {
    listenError = error as Error;
  });
  try {
    server.listen(0);
  } catch (error) {
    listenError = error as Error;
  }

  return {
    server,
    getUrl: () => {
      const addr = server.address() as AddressInfo;
      return `http://127.0.0.1:${addr.port}`;
    },
    received,
    listenError,
  };
}

describe('createNodeFetch', () => {
  let server: http.Server;
  let getUrl: () => string;
  let received: ReceivedRequest[];
  let nodeFetch: ReturnType<typeof createNodeFetch>;
  let listenError: Error | null;
  const serversToClose: http.Server[] = [];

  beforeAll(() => {
    ({ server, getUrl, received, listenError } = createTestServer());
    nodeFetch = createNodeFetch();
  });

  afterAll(() => new Promise<void>((resolve) => {
    server.close(() => resolve());
  }));

  afterEach(async () => {
    received.length = 0;
    await Promise.all(
      serversToClose.map((s) => new Promise<void>((resolve) => s.close(() => resolve()))),
    );
    serversToClose.length = 0;
  });

  function skipIfSandboxBlocked() {
    if (listenError || !server.listening) {
      return true;
    }
    return false;
  }

  it('should set Content-Length header for POST with body', async () => {
    if (skipIfSandboxBlocked()) return;
    const body = JSON.stringify({ jsonrpc: '2.0', method: 'initialize', id: 1 });

    const response = await nodeFetch(getUrl(), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
    });

    expect(response.ok).toBe(true);
    expect(received).toHaveLength(1);
    expect(received[0].headers['content-length']).toBe(String(Buffer.byteLength(body)));
    expect(received[0].headers['transfer-encoding']).toBeUndefined();
  });

  it('should deliver valid JSON body without chunk framing', async () => {
    if (skipIfSandboxBlocked()) return;
    const payload = { jsonrpc: '2.0', method: 'tools/list', id: 2 };
    const body = JSON.stringify(payload);

    await nodeFetch(getUrl(), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
    });

    expect(received).toHaveLength(1);
    const parsed = JSON.parse(received[0].body);
    expect(parsed).toEqual(payload);
  });

  it('should not set Content-Length for GET requests without body', async () => {
    if (skipIfSandboxBlocked()) return;
    await nodeFetch(getUrl(), { method: 'GET' });

    expect(received).toHaveLength(1);
    expect(received[0].headers['content-length']).toBeUndefined();
    expect(received[0].method).toBe('GET');
  });

  it('should forward custom headers', async () => {
    if (skipIfSandboxBlocked()) return;
    await nodeFetch(getUrl(), {
      method: 'GET',
      headers: { 'X-Custom': 'test-value', Authorization: 'Bearer token123' },
    });

    expect(received).toHaveLength(1);
    expect(received[0].headers['x-custom']).toBe('test-value');
    expect(received[0].headers['authorization']).toBe('Bearer token123');
  });

  it('should return response status and body', async () => {
    if (skipIfSandboxBlocked()) return;
    const response = await nodeFetch(getUrl(), { method: 'GET' });

    expect(response.status).toBe(200);
    expect(response.ok).toBe(true);

    const data = await response.json() as { ok: boolean };
    expect(data).toEqual({ ok: true });
  });

  it('should handle non-200 responses', async () => {
    const { server: errorServer, getUrl: errorUrl, received: errorReceived } = createTestServer(
      (_req, res) => {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'not found' }));
      },
    );
    if (skipIfSandboxBlocked()) return;
    serversToClose.push(errorServer);

    const response = await nodeFetch(errorUrl(), { method: 'GET' });

    expect(response.status).toBe(404);
    expect(response.ok).toBe(false);
    expect(errorReceived).toHaveLength(1);

    const data = await response.json() as { error: string };
    expect(data).toEqual({ error: 'not found' });
  });

  it('should support abort signal', async () => {
    if (skipIfSandboxBlocked()) return;
    const controller = new AbortController();
    controller.abort();

    await expect(
      nodeFetch(getUrl(), { method: 'GET', signal: controller.signal }),
    ).rejects.toThrow();
  });

  it('should accept URL object as input', async () => {
    if (skipIfSandboxBlocked()) return;
    const url = new URL(getUrl());

    const response = await nodeFetch(url, { method: 'GET' });

    expect(response.ok).toBe(true);
    expect(received).toHaveLength(1);
  });

  it('should handle multi-byte characters in body with correct Content-Length', async () => {
    if (skipIfSandboxBlocked()) return;
    const body = JSON.stringify({ text: '你好世界' });

    await nodeFetch(getUrl(), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
    });

    expect(received).toHaveLength(1);
    // Content-Length should be byte length, not character length
    expect(received[0].headers['content-length']).toBe(String(Buffer.byteLength(body)));
    const parsed = JSON.parse(received[0].body) as { text: string };
    expect(parsed.text).toBe('你好世界');
  });
});
