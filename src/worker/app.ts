import type { Context } from "hono";
import { HonoBase } from "hono/hono-base";
import { TrieRouter } from "hono/router/trie-router";
import { powerShellAgentScript } from "../agent/powershell";
import { shellAgentScript } from "../agent/shell";
import { maxCommandBytes, maxResultBytes } from "../shared/config";
import { base64Encode, randomSessionCode } from "../shared/crypto";
import { BadRequestError, cleanString, normalizeTimeout, PayloadTooLargeError, readLimitedBytes, textResponse } from "../shared/http";
import { logInfo } from "../shared/log";
import { homePage, notFoundPage } from "../site/pages";
import type { CommandBridge, Session } from "./durable-objects/command-bridge";
import type { Env } from "./env";

type AppContext = Context<{ Bindings: Env }>;
type SessionGuard = { session: Session; bridge: DurableObjectStub<CommandBridge> } | { response: Response };

const sessionCodePattern = /^[23456789abcdefghjkmnpqrstuvwxyz]{8}$/;
const textDecoder = new TextDecoder();

export const app = new HonoBase<{ Bindings: Env }>({ router: new TrieRouter() });

app.onError((error) => {
  if (error instanceof PayloadTooLargeError) return textResponse(`${error.message}\n`, 413);
  if (error instanceof BadRequestError) return textResponse(`${error.message}\n`, 400);
  console.error(error);
  return textResponse("Internal server error\n", 500);
});

app.use("*", async (c, next) => {
  await next();
  c.res.headers.set("Cache-Control", "no-store");
});

app.get("/", (c) => {
  const baseUrl = new URL(c.req.url).origin;
  if (wantsHtml(c.req.raw.headers)) return c.html(homePage(baseUrl));
  if (wantsPowerShell(c.req.raw.headers)) return textResponse(powerShellAgentScript(baseUrl));
  return textResponse(shellAgentScript(baseUrl), 200, { "Content-Type": "text/x-shellscript; charset=utf-8" });
});

app.get("/robots.txt", (c) => textResponse(`User-agent: *\nAllow: /\nSitemap: ${new URL(c.req.url).origin}/sitemap.xml\n`));

app.get("/sitemap.xml", (c) => {
  const origin = new URL(c.req.url).origin;
  return c.body(`<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><url><loc>${origin}/</loc></url></urlset>`, 200, {
    "Content-Type": "application/xml; charset=utf-8"
  });
});

app.post("/", async (c) => {
  const agent = {
    shell: cleanString(c.req.header("x-agent-shell"), 40) || "sh",
    platform: cleanString(c.req.header("x-agent-platform"), 120)
  };
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const code = randomSessionCode();
    if (await c.env.COMMAND_BRIDGES.getByName(code).create(code, agent)) {
      logInfo("session_created", agent);
      return textResponse(`${code}\n`, 201);
    }
  }
  throw new Error("Could not allocate session code");
});

app.get("/:code", async (c) => {
  const guard = await requireSession(c);
  if ("response" in guard) return guard.response;

  const { session } = guard;
  return Response.json({
    code: session.code,
    shell: session.shell,
    platform: session.platform,
    connected: await guard.bridge.connected(),
    expiresAt: new Date(session.expiresAt).toISOString()
  });
});

app.post("/:code", async (c) => {
  const guard = await requireSession(c);
  if ("response" in guard) return guard.response;

  const input = await readCommand(c.req.raw);
  if (!input.command) return textResponse("Command is required\n", 400);

  const outcome = await guard.bridge.run(input);
  if (outcome.kind === "timeout") return textResponse("Timed out waiting for command result\n", 504);
  if (outcome.kind === "ended") return textResponse("Session ended\n", 410);
  if (outcome.kind === "oversized") return textResponse(`Command output exceeds ${maxResultBytes} bytes\n`, 413);

  const { exitCode, stdout, stderr } = outcome.output;
  if (c.req.header("accept")?.includes("application/json")) return Response.json({ exitCode, stdout, stderr });
  return textResponse(stdout + stderr, 200, { "X-Exit-Code": String(exitCode) });
});

app.delete("/:code", async (c) => {
  const guard = await requireSession(c, { allowEnded: true });
  if ("response" in guard) return guard.response;

  await guard.bridge.end();
  return textResponse("ended\n");
});

app.get("/:code/next", async (c) => {
  const guard = await requireSession(c);
  if ("response" in guard) return guard.response;

  const command = await guard.bridge.next();
  if (!command) return new Response(null, { status: 204 });

  const headers = new Headers({
    "Content-Type": "application/octet-stream",
    "X-Command-Id": command.id,
    "X-Command-Timeout": String(command.timeout)
  });
  if (command.cwd) headers.set("X-Command-Cwd-Base64", base64Encode(command.cwd));
  return new Response(command.command, { headers });
});

app.post("/:code/result/:commandId", async (c) => {
  const guard = await requireSession(c);
  if ("response" in guard) return guard.response;

  let bytes: Uint8Array;
  try {
    bytes = await readLimitedBytes(c.req.raw, maxResultBytes);
  } catch (error) {
    if (error instanceof PayloadTooLargeError) await guard.bridge.rejectOversizedResult(c.req.param("commandId"));
    throw error;
  }
  const stdoutBytes = Math.min(Number(c.req.header("x-stdout-bytes")) || 0, bytes.byteLength);
  const exitCode = Number.parseInt(c.req.query("exit") ?? "", 10);
  await guard.bridge.result(c.req.param("commandId"), {
    exitCode: Number.isNaN(exitCode) ? 1 : exitCode,
    stdout: textDecoder.decode(bytes.subarray(0, stdoutBytes)),
    stderr: textDecoder.decode(bytes.subarray(stdoutBytes))
  });
  return textResponse("ok\n");
});

app.notFound((c) => (wantsHtml(c.req.raw.headers) ? c.html(notFoundPage(), 404) : textResponse("Not found\n", 404)));

async function requireSession(c: AppContext, options: { allowEnded?: boolean } = {}): Promise<SessionGuard> {
  const address = c.req.header("cf-connecting-ip");
  if (address && !(await c.env.LOOKUPS.limit({ key: address })).success) {
    return { response: textResponse("Too many requests. Try again in a minute.\n", 429, { "Retry-After": "60" }) };
  }

  const code = (c.req.param("code") ?? "").toLowerCase();
  if (!sessionCodePattern.test(code)) return { response: textResponse("Session not found\n", 404) };

  const bridge = c.env.COMMAND_BRIDGES.getByName(code);
  const session = await bridge.session();
  if (!session) return { response: textResponse("Session not found\n", 404) };
  if (session.endedAt && !options.allowEnded) return { response: textResponse("Session ended\n", 410) };
  return { session, bridge };
}

async function readCommand(request: Request): Promise<{ command: string; cwd: string; timeout: number }> {
  const url = new URL(request.url);
  const text = textDecoder.decode(await readLimitedBytes(request, maxCommandBytes));
  if (!request.headers.get("content-type")?.includes("application/json")) {
    return {
      command: text.trim(),
      cwd: cleanString(url.searchParams.get("cwd"), 500),
      timeout: normalizeTimeout(url.searchParams.get("timeout"))
    };
  }

  let payload: { command?: unknown; cwd?: unknown; timeout?: unknown } | null;
  try {
    payload = JSON.parse(text);
  } catch {
    throw new BadRequestError("Invalid JSON");
  }
  if (payload === null) throw new BadRequestError("Command is required");
  return {
    command: cleanString(payload.command, maxCommandBytes).trim(),
    cwd: cleanString(payload.cwd ?? url.searchParams.get("cwd"), 500),
    timeout: normalizeTimeout(payload.timeout ?? url.searchParams.get("timeout"))
  };
}

function wantsHtml(headers: Headers): boolean {
  const crawler = /WhatsApp|facebookexternalhit|Facebot|meta-externalagent|meta-externalfetcher|Twitterbot|LinkedInBot|Slackbot|Discordbot|TelegramBot|Googlebot|bingbot/i;
  return (headers.get("accept") ?? "").includes("text/html") || crawler.test(headers.get("user-agent") ?? "");
}

function wantsPowerShell(headers: Headers): boolean {
  const signal = `${headers.get("accept") ?? ""} ${headers.get("user-agent") ?? ""}`;
  return /\b(?:windowspowershell|powershell|pwsh)\b/i.test(signal);
}
