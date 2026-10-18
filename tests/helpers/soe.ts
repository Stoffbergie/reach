import { strict as assert } from "node:assert";
import { spawn, spawnSync, type SpawnOptions } from "node:child_process";
import { inject } from "vite-plus/test";

export const baseUrl = inject("baseUrl");
export const sessionCodePattern = /^[23456789abcdefghjkmnpqrstuvwxyz]{8}$/;

export type Agent = {
  code: string;
  output: () => string;
  exit: (timeoutMs?: number) => Promise<number | null>;
  stop: () => void;
};

export type CommandResult = {
  status: number;
  text: string;
  headers: Headers;
};

export type SendOptions = {
  timeout?: number;
  cwd?: string;
};

export function findCommand(names: string | string[]): string {
  for (const name of Array.isArray(names) ? names : [names]) {
    const lookup = process.platform === "win32" ? spawnSync("where.exe", [name], { encoding: "utf8" }) : spawnSync("sh", ["-c", `command -v '${name}'`], { encoding: "utf8" });
    if (!lookup.error && lookup.status === 0) return lookup.stdout.trim().split(/\r?\n/, 1)[0] || name;
  }
  return "";
}

export function startShellAgent(options: SpawnOptions = {}): Promise<Agent> {
  return startAgent("sh", ["-c", `curl -sS ${baseUrl} | sh`], options);
}

export function startPowerShellAgent(powerShell: string, options: SpawnOptions = {}): Promise<Agent> {
  return startAgent(powerShell, ["-NoProfile", "-Command", `irm ${baseUrl} | iex`], options);
}

export async function startAgent(command: string, args: string[], options: SpawnOptions = {}, startTimeoutMs = 20_000): Promise<Agent> {
  const child = spawn(command, args, { ...options, env: { ...process.env, NO_PROXY: "*", ...options.env } });
  const chunks: Buffer[] = [];
  child.stdout?.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
  child.stderr?.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
  const output = () => Buffer.concat(chunks).toString("utf8");
  const exited = new Promise<number | null>((resolve) => child.once("exit", (code) => resolve(code)));

  const agent: Agent = {
    code: "",
    output,
    exit: async (timeoutMs = 10_000) => {
      const timeout = sleep(timeoutMs).then(() => {
        throw new Error(`Agent did not exit\n${output()}`);
      });
      return Promise.race([exited, timeout]);
    },
    stop: () => {
      if (child.exitCode === null) child.kill();
    }
  };

  const startedAt = Date.now();
  while (Date.now() - startedAt < startTimeoutMs) {
    const match = output().match(/Session: ([a-z0-9]{8})/);
    if (match) {
      agent.code = match[1];
      return agent;
    }
    if (child.exitCode !== null) break;
    await sleep(50);
  }
  agent.stop();
  throw new Error(`Agent did not print a session code\n${output()}`);
}

export async function send(code: string, command: string, options: SendOptions = {}): Promise<CommandResult> {
  const response = await fetch(`${baseUrl}/${code}/send?timeout=${options.timeout ?? 10}`, {
    method: "POST",
    body: JSON.stringify({ body: command, cwd: options.cwd })
  });
  return { status: response.status, text: await response.text(), headers: response.headers };
}

export async function end(code: string): Promise<Response> {
  return fetch(`${baseUrl}/${code}/end`, { method: "POST" });
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function assertOk(result: CommandResult, agent: Agent): void {
  assert.equal(result.status, 200, `${result.text}\n${agent.output()}`);
}
