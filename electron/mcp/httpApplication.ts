// Port of OctoPunk/OctoPunk/Platform/MCP/OctoPunkHTTPApplication.swift.
// Stateful HTTP bridge for the official MCP Server/Transport API: each MCP
// session owns one transport; an HTTP POST is fed to the server's receive
// path while the matching Server response completes the HTTP request. Node's
// http module replaces SwiftNIO.

import http from "node:http";
import { randomUUID } from "node:crypto";
import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";

export interface HTTPRequest {
  method: string;
  headers: Record<string, string>;
  body?: Buffer;
  path: string;
}

export interface HTTPResponse {
  statusCode: number;
  headers: Record<string, string>;
  body?: Buffer;
}

interface PendingResponse {
  resolve: (data: Buffer) => void;
  reject: (error: Error) => void;
}

class HTTPTransportError extends Error {
  constructor(
    message: string,
    readonly kind: "requestTimedOut" | "disconnected" | "responseAlreadyPending",
  ) {
    super(message);
    this.name = "HTTPTransportError";
  }
}

/** One MCP session's transport; responses complete their pending HTTP request. */
class MCPHTTPTransport implements Transport {
  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: (message: JSONRPCMessage) => void;

  private isConnected = false;
  private pending = new Map<string, PendingResponse>();

  constructor(readonly sessionID: string) {}

  async start(): Promise<void> {
    this.isConnected = true;
  }

  async send(message: JSONRPCMessage): Promise<void> {
    const message_ = message as { id?: unknown };
    const responseKey = requestKeyForID(message_.id);
    let pending: PendingResponse | undefined;
    if (responseKey != null) {
      pending = this.pending.get(responseKey);
    } else if (this.pending.size === 1) {
      pending = [...this.pending.values()][0];
    }
    if (pending == null) {
      // Server-originated notifications have no HTTP request to complete.
      if (responseKey == null) return;
      throw new HTTPTransportError("MCP session disconnected.", "disconnected");
    }
    this.pending.delete(responseKey ?? [...this.pending.keys()][0]);
    pending.resolve(Buffer.from(JSON.stringify(message), "utf8"));
  }

  async close(): Promise<void> {
    this.isConnected = false;
    const pending = [...this.pending.values()];
    this.pending.clear();
    for (const continuation of pending) {
      continuation.reject(new HTTPTransportError("MCP session disconnected.", "disconnected"));
    }
    this.onclose?.();
  }

  async handle(request: HTTPRequest): Promise<HTTPResponse> {
    if (request.method.toUpperCase() === "DELETE") {
      await this.close();
      return emptyResponse(200, this.sessionID);
    }
    if (request.method.toUpperCase() !== "POST") {
      return errorResponse(405, "Only POST and DELETE are supported.");
    }
    if (!this.isConnected) {
      return errorResponse(410, "MCP session is disconnected.");
    }
    const body = request.body;
    if (body == null) {
      return errorResponse(400, "MCP request body is required.");
    }

    // Notifications carry no response id: they still enter the server
    // stream, but the HTTP request completes immediately.
    const requestKey = requestKeyFromBody(body);
    if (requestKey == null) {
      this.onmessage?.(JSON.parse(body.toString("utf8")) as JSONRPCMessage);
      return emptyResponse(202, this.sessionID);
    }

    try {
      const response = await Promise.race([
        this.submit(body, requestKey),
        (async (): Promise<Buffer> => {
          await new Promise((resolve) => setTimeout(resolve, 45_000));
          throw new HTTPTransportError("MCP request timed out.", "requestTimedOut");
        })(),
      ]);
      return jsonResponse(response, this.sessionID);
    } catch (error) {
      if (error instanceof HTTPTransportError && error.kind === "requestTimedOut") {
        return errorResponse(504, error.message);
      }
      return errorResponse(500, error instanceof Error ? error.message : String(error));
    }
  }

  private submit(body: Buffer, requestKey: string): Promise<Buffer> {
    return new Promise<Buffer>((resolve, reject) => {
      if (this.pending.has(requestKey)) {
        reject(new HTTPTransportError("This MCP session already has a request in flight.", "responseAlreadyPending"));
        return;
      }
      this.pending.set(requestKey, { resolve, reject });
      this.onmessage?.(JSON.parse(body.toString("utf8")) as JSONRPCMessage);
    });
  }
}

interface SessionContext {
  server: Server;
  transport: MCPHTTPTransport;
}

export class OctoPunkHTTPApplication {
  private readonly host: string;
  private readonly port: number;
  private readonly endpoint: string;
  private readonly token: string;
  private readonly serverFactory: (sessionID: string) => Promise<Server>;
  private readonly onSessionClose: ((sessionID: string) => void | Promise<void>) | null;
  private server: http.Server | null = null;
  private sessions = new Map<string, SessionContext>();

  constructor(input: {
    host: string;
    port: number;
    endpoint: string;
    token: string;
    serverFactory: (sessionID: string) => Promise<Server>;
    onSessionClose?: (sessionID: string) => void | Promise<void>;
  }) {
    this.host = input.host;
    this.port = input.port;
    this.endpoint = input.endpoint;
    this.token = input.token;
    this.serverFactory = input.serverFactory;
    this.onSessionClose = input.onSessionClose ?? null;
  }

  async start(): Promise<void> {
    if (this.server != null) return;
    const server = http.createServer((request, response) => {
      void this.handleNodeRequest(request, response);
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(this.port, this.host, () => resolve());
    });
    this.server = server;
  }

  async stop(): Promise<void> {
    for (const [sessionID, session] of [...this.sessions.entries()]) {
      await session.server.close().catch(() => {});
      await session.transport.close();
      await this.closeSession(sessionID);
    }
    this.sessions.clear();
    const server = this.server;
    if (server != null) {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
    this.server = null;
  }

  /** Best-effort session teardown; a throwing handler never blocks removal. */
  private async closeSession(sessionID: string): Promise<void> {
    if (this.onSessionClose == null) return;
    try {
      await this.onSessionClose(sessionID);
    } catch {
      // Session cleanup is advisory: the owning run can still be cancelled manually.
    }
  }

  private async handleNodeRequest(request: http.IncomingMessage, response: http.ServerResponse): Promise<void> {
    const chunks: Buffer[] = [];
    for await (const chunk of request) {
      chunks.push(chunk as Buffer);
    }
    const headers: Record<string, string> = {};
    for (const [name, value] of Object.entries(request.headers)) {
      if (typeof value === "string") {
        headers[name.toLowerCase()] = headers[name.toLowerCase()]
          ? `${headers[name.toLowerCase()]}, ${value}`
          : value;
      }
    }
    const body = chunks.length > 0 ? Buffer.concat(chunks) : undefined;
    const url = request.url ?? "/";
    const path = url.split("?")[0] ?? url;
    const httpResponse = await this.handle({
      method: request.method ?? "GET",
      headers,
      body,
      path,
    });
    response.writeHead(httpResponse.statusCode, httpResponse.headers);
    response.end(httpResponse.body);
  }

  private async handle(request: HTTPRequest): Promise<HTTPResponse> {
    if (request.path !== this.endpoint) {
      return errorResponse(404, "Not Found");
    }
    if (request.headers["authorization"] !== `Bearer ${this.token}`) {
      const unauthorized = errorResponse(401, "Unauthorized");
      return {
        ...unauthorized,
        headers: { ...unauthorized.headers, "WWW-Authenticate": "Bearer" },
      };
    }

    const sessionID = request.headers["mcp-session-id"];
    const existing = sessionID != null ? this.sessions.get(sessionID) : undefined;
    if (sessionID != null && existing) {
      const response = await existing.transport.handle(request);
      if (request.method.toUpperCase() === "DELETE") {
        await existing.server.close().catch(() => {});
        this.sessions.delete(sessionID);
        await this.closeSession(sessionID);
      }
      return response;
    }

    const isInitialize =
      request.body != null &&
      (() => {
        try {
          const parsed = JSON.parse(request.body.toString("utf8")) as { method?: string };
          return parsed.method === "initialize";
        } catch {
          return false;
        }
      })();
    if (request.method.toUpperCase() !== "POST" || !isInitialize) {
      return errorResponse(400, "Missing or expired MCP session.");
    }

    const newSessionID = randomUUID();
    const transport = new MCPHTTPTransport(newSessionID);
    try {
      const server = await this.serverFactory(newSessionID);
      await server.connect(transport);
      this.sessions.set(newSessionID, { server, transport });
      const response = await transport.handle(request);
      if (response.statusCode >= 400) {
        await server.close().catch(() => {});
        this.sessions.delete(newSessionID);
        await this.closeSession(newSessionID);
      }
      return response;
    } catch (error) {
      await transport.close();
      return errorResponse(500, error instanceof Error ? error.message : String(error));
    }
  }
}

function jsonResponse(body: Buffer, sessionID: string): HTTPResponse {
  return {
    statusCode: 200,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
      "Mcp-Session-Id": sessionID,
    },
    body,
  };
}

function emptyResponse(statusCode: number, sessionID: string): HTTPResponse {
  return {
    statusCode,
    headers: {
      "Cache-Control": "no-store",
      "Mcp-Session-Id": sessionID,
    },
  };
}

function errorResponse(statusCode: number, message: string): HTTPResponse {
  return {
    statusCode,
    headers: { "Content-Type": "text/plain; charset=utf-8" },
    body: Buffer.from(message, "utf8"),
  };
}

function requestKeyFromBody(body: Buffer): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body.toString("utf8"));
  } catch {
    return null;
  }
  if (Array.isArray(parsed)) {
    const keys = parsed
      .map((message) => scalarRequestKey((message as { id?: unknown }).id))
      .filter((key): key is string => key != null);
    if (keys.length === 0) return null;
    return `batch:${keys.join(",")}`;
  }
  if (typeof parsed === "object" && parsed != null) {
    return scalarRequestKey((parsed as { id?: unknown }).id);
  }
  return null;
}

function scalarRequestKey(id: unknown): string | null {
  if (typeof id === "string") return `string:${id}`;
  if (typeof id === "number") return `number:${id}`;
  return null;
}

function requestKeyForID(id: unknown): string | null {
  return scalarRequestKey(id);
}
