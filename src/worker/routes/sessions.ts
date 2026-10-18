import type { Context, Hono } from "hono";
import { powerShellAgentScript } from "../../agent/powershell";
import { shellAgentScript } from "../../agent/shell";
import { defaultCommandTimeoutSeconds, maxCommandBytes } from "../../shared/config";
import { randomSessionCode } from "../../shared/crypto";
import { BadRequestError, cleanString, normalizeTimeout, publicBaseUrl, readLimitedText, textResponse } from "../../shared/http";
import { logInfo } from "../../shared/log";
import type { CommandBridge } from "../durable-objects/command-bridge";
import type { Env } from "../env";

type SessionApp = Hono<{ Bindings: Env }>;
type SessionContext = Context<{ Bindings: Env }>;
type SessionGuard = { bridge: DurableObjectStub<CommandBridge> } | { response: Response };
type ScriptKind = "shell" | "powershell";

const sessionCodePattern = /^[23456789abcdefghjkmnpqrstuvwxyz]{8}$/;

export function registerSessionRoutes(app: SessionApp): void {
  app.post("/:id/send", sendCommand);
  app.post("/:id/end", endSession);
  app.post("/api/sessions/:id/hello", agentHello);
  app.get("/api/sessions/:id/next", agentNext);
  app.post("/api/sessions/:id/result/:commandId", agentResult);
}

export function scriptKindForHeaders(headers: Headers): ScriptKind {
  const signal = `${headers.get("accept") || ""} ${headers.get("user-agent") || ""}`;
  return /\b(?:powershell|pwsh)\b/i.test(signal) ? "powershell" : "shell";
}

export async function createSessionResponse(c: SessionContext, kind: ScriptKind): Promise<Response> {
  const code = await createSessionCode(c.env);
  logInfo("session_created", {});

  const baseUrl = publicBaseUrl(c.req.raw);
  const body = kind === "shell" ? shellAgentScript(baseUrl, code) : powerShellAgentScript(baseUrl, code);
  return new Response(body, {
    headers: {
      "Cache-Control": "no-store",
      "Content-Type": kind === "shell" ? "text/x-shellscript; charset=utf-8" : "text/plain; charset=utf-8",
      "X-Session-Id": code,
      "X-Session-Code": code
    }
  });
}

async function sendCommand(c: SessionContext): Promise<Response> {
  const guard = await requireSession(c.env, c.req.param("id"));
  if ("response" in guard) return guard.response;

  const input = await readCommandInput(c.req.raw);
  if (!input.body) return textResponse("Command body is required\n", 400);

  return guard.bridge.fetch("https://session/send", {
    method: "POST",
    body: JSON.stringify(input)
  });
}

async function agentHello(c: SessionContext): Promise<Response> {
  const guard = await requireSession(c.env, c.req.param("id"));
  if ("response" in guard) return guard.response;

  logInfo("agent_connected", { platform: cleanString(c.req.header("x-agent-platform"), 120) });
  return textResponse("connected\n");
}

async function agentNext(c: SessionContext): Promise<Response> {
  const guard = await requireSession(c.env, c.req.param("id"));
  if ("response" in guard) return guard.response;

  return guard.bridge.fetch("https://session/next");
}

async function agentResult(c: SessionContext): Promise<Response> {
  const guard = await requireSession(c.env, c.req.param("id"));
  if ("response" in guard) return guard.response;

  const commandId = cleanString(c.req.param("commandId"), 200);
  if (!commandId) return textResponse("Command not found\n", 404);
  return guard.bridge.fetch(`https://session/result/${commandId}${new URL(c.req.url).search}`, {
    method: "POST",
    body: c.req.raw.body
  });
}

async function endSession(c: SessionContext): Promise<Response> {
  const guard = await requireSession(c.env, c.req.param("id"), { allowEnded: true });
  if ("response" in guard) return guard.response;

  await guard.bridge.end();
  return textResponse("ended\n");
}

async function requireSession(env: Env, id: string | undefined, options: { allowEnded?: boolean } = {}): Promise<SessionGuard> {
  const code = cleanString(id, 80).toLowerCase();
  if (!sessionCodePattern.test(code)) return { response: textResponse("Session not found\n", 404) };

  const bridge = env.COMMAND_BRIDGES.getByName(code);
  const session = await bridge.session();
  if (!session) return { response: textResponse("Session not found\n", 404) };
  if (session.endedAt && !options.allowEnded) return { response: textResponse("Session ended\n", 410) };
  return { bridge };
}

async function createSessionCode(env: Env): Promise<string> {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const code = randomSessionCode();
    if (await env.COMMAND_BRIDGES.getByName(code).create(code)) return code;
  }
  throw new Error("Could not allocate session code");
}

async function readCommandInput(request: Request): Promise<{ body: string; cwd: string; timeout: number }> {
  const url = new URL(request.url);
  const raw = (await readLimitedText(request, maxCommandBytes)).trim();
  const timeout = normalizeTimeout(url.searchParams.get("timeout") || defaultCommandTimeoutSeconds);
  if (!request.headers.get("content-type")?.includes("application/json")) {
    return { body: raw, cwd: "", timeout };
  }

  type CommandPayload = { body?: unknown; cwd?: unknown; timeout?: unknown; timeoutSeconds?: unknown };
  let payload: CommandPayload;
  try {
    payload = JSON.parse(raw) as CommandPayload;
  } catch {
    throw new BadRequestError("Invalid JSON command payload");
  }
  if (payload.timeout !== undefined || payload.timeoutSeconds !== undefined) {
    throw new BadRequestError("Use ?timeout= for command timeout");
  }

  return {
    body: cleanString(payload.body, maxCommandBytes).trim(),
    cwd: cleanString(payload.cwd, 500),
    timeout
  };
}
