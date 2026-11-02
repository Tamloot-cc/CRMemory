import type { Readable, Writable } from 'node:stream';
import {
  isJSONRPCRequest,
  isJSONRPCResponse,
  isJSONRPCResultResponse,
  type JSONRPCMessage,
  ReadBuffer,
  type RequestId,
  SdkHttpError,
  StreamableHTTPClientTransport,
  serializeMessage,
} from '@modelcontextprotocol/client';

/**
 * Relays MCP messages between stdio and a Retainer server's Streamable HTTP
 * endpoint. It does not parse or define tools: every message passes through
 * unchanged, so the tools stay defined once, on the server.
 */

export type BridgeConfig = { url: URL; apiKey: string };

export class ConfigError extends Error {}

/** Reads `RETAINER_URL` and `RETAINER_API_KEY`. A base URL gets `/mcp` appended. */
export function readConfig(env: Record<string, string | undefined>): BridgeConfig {
  const rawUrl = env.RETAINER_URL?.trim();
  const apiKey = env.RETAINER_API_KEY?.trim();
  if (!rawUrl) throw new ConfigError('RETAINER_URL is not set (e.g. https://retainer.example.com)');
  if (!apiKey) throw new ConfigError('RETAINER_API_KEY is not set');
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new ConfigError(`RETAINER_URL is not a valid URL: ${rawUrl}`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new ConfigError(`RETAINER_URL must use http or https: ${rawUrl}`);
  }
  const path = url.pathname.replace(/\/+$/, '');
  url.pathname = path.endsWith('/mcp') ? path : `${path}/mcp`;
  return { url, apiKey };
}

export type Bridge = {
  /** Settles when stdin has ended, every forwarded request is answered, and the connection is closed. */
  closed: Promise<void>;
  close: () => Promise<void>;
};

/** JSON-RPC "internal error": the bridge could not get an answer from the server. */
const BRIDGE_ERROR = -32603;

/** Diagnostics go to stderr; stdout carries only protocol messages. */
const log = (message: string) => process.stderr.write(`retainer-mcp: ${message}\n`);

export async function startBridge(
  config: BridgeConfig,
  stdin: Readable,
  stdout: Writable,
): Promise<Bridge> {
  const http = new StreamableHTTPClientTransport(config.url, {
    requestInit: { headers: { authorization: `Bearer ${config.apiKey}` } },
  });
  /** The method of each client request not answered yet, by request ID. */
  const pending = new Map<RequestId, string>();
  let closing: Promise<void> | undefined;
  let resolveClosed!: () => void;
  const closed = new Promise<void>((resolve) => {
    resolveClosed = resolve;
  });

  const close = () => {
    closing ??= (async () => {
      stdin.off('data', onData);
      try {
        await http.close();
      } catch (error) {
        log(`closing the connection failed: ${describe(error)}`);
      }
      resolveClosed();
    })();
    return closing;
  };
  const closeIfDone = () => {
    if (stdin.readableEnded && pending.size === 0) void close();
  };

  const write = (message: JSONRPCMessage) => {
    if (isJSONRPCResponse(message)) pending.delete(message.id as RequestId);
    if (stdout.writable) stdout.write(serializeMessage(message));
    closeIfDone();
  };

  http.onmessage = (message) => {
    if (isJSONRPCResultResponse(message) && pending.get(message.id) === 'initialize') {
      // What a Client would do after initialize: later requests carry the negotiated version.
      const version = (message.result as { protocolVersion?: unknown }).protocolVersion;
      if (typeof version === 'string') http.setProtocolVersion(version);
    }
    write(message);
  };
  http.onerror = (error) => log(describe(error));

  const forward = (message: JSONRPCMessage) => {
    if (isJSONRPCRequest(message)) pending.set(message.id, message.method);
    http.send(message).catch((error: unknown) => {
      const reason = explain(error, config.url);
      log(reason);
      if (isJSONRPCRequest(message)) {
        write({ jsonrpc: '2.0', id: message.id, error: { code: BRIDGE_ERROR, message: reason } });
      }
    });
  };

  const buffer = new ReadBuffer();
  const onData = (chunk: Buffer) => {
    buffer.append(chunk);
    for (;;) {
      let message: JSONRPCMessage | null;
      try {
        message = buffer.readMessage();
      } catch (error) {
        log(`ignored a line that is not a JSON-RPC message: ${describe(error)}`);
        continue;
      }
      if (!message) break;
      forward(message);
    }
  };

  await http.start();
  stdin.on('data', onData);
  stdin.once('end', closeIfDone);
  stdout.on('error', () => void close());
  return { closed, close };
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** One line a person can act on, for stderr and for the error the client shows. */
function explain(error: unknown, url: URL): string {
  if (error instanceof SdkHttpError) {
    if (error.status === 401) {
      return `Retainer at ${url.origin} rejected the API key (401). Check RETAINER_API_KEY.`;
    }
    const body = typeof error.data.text === 'string' ? error.data.text : error.message;
    return `Retainer at ${url.origin} answered HTTP ${error.status}: ${body}`;
  }
  const cause = error instanceof Error && error.cause instanceof Error ? error.cause : undefined;
  if (cause && 'code' in cause && typeof cause.code === 'string') {
    return `cannot reach Retainer at ${url.origin} (${cause.code}). Check RETAINER_URL.`;
  }
  const detail = cause?.message ? ` (${cause.message})` : '';
  return `request to Retainer at ${url.origin} failed: ${describe(error)}${detail}`;
}
