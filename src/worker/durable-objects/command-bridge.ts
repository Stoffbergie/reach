import { DurableObject } from "cloudflare:workers";
import { maxCommandWaitMs, nextWaitMs, resultGraceMs, sessionTtlMs } from "../../shared/config";
import { logInfo } from "../../shared/log";
import type { Env } from "../env";

export type Agent = {
  shell: string;
  platform: string;
};

export type Session = Agent & {
  code: string;
  createdAt: number;
  expiresAt: number;
  endedAt?: number;
};

export type Command = {
  id: string;
  command: string;
  cwd: string;
  timeout: number;
};

export type CommandOutput = {
  exitCode: number;
  stdout: string;
  stderr: string;
};

export type CommandOutcome = { kind: "done"; output: CommandOutput } | { kind: "timeout" } | { kind: "ended" } | { kind: "oversized" };

type Pending = {
  command: Command;
  resolve: (outcome: CommandOutcome) => void;
  timer: ReturnType<typeof setTimeout>;
};

type Poller = {
  resolve: (command: Command | null) => void;
  timer: ReturnType<typeof setTimeout>;
};

const agentGoneAfterMs = nextWaitMs + 15_000;

export class CommandBridge extends DurableObject<Env> {
  private queue: Command[] = [];
  private pending = new Map<string, Pending>();
  private pollers: Poller[] = [];
  private lastPollAt = 0;

  async create(code: string, agent: Agent): Promise<boolean> {
    if (await this.session()) return false;
    const now = Date.now();
    const session: Session = { code, ...agent, createdAt: now, expiresAt: now + sessionTtlMs };
    await this.ctx.storage.put("session", session);
    await this.ctx.storage.setAlarm(session.expiresAt);
    this.lastPollAt = now;
    return true;
  }

  async session(): Promise<Session | undefined> {
    return this.ctx.storage.get<Session>("session");
  }

  connected(): boolean {
    return this.pollers.length > 0 || Date.now() - this.lastPollAt < agentGoneAfterMs;
  }

  async run(input: Omit<Command, "id">): Promise<CommandOutcome> {
    if (!(await this.active())) return { kind: "ended" };
    const command: Command = { id: crypto.randomUUID(), ...input };
    logInfo("command_sent", { commandId: command.id, bytes: command.command.length, timeout: command.timeout });
    return new Promise((resolve) => {
      const timer = setTimeout(() => this.finish(command.id, { kind: "timeout" }), maxCommandWaitMs);
      this.pending.set(command.id, { command, resolve, timer });
      this.dispatch(command);
    });
  }

  async next(): Promise<Command | null> {
    this.lastPollAt = Date.now();
    if (!(await this.active())) return null;
    const queued = this.queue.shift();
    if (queued) return this.deliver(queued);
    return new Promise((resolve) => {
      const poller: Poller = {
        resolve: (command) => {
          this.lastPollAt = Date.now();
          resolve(command);
        },
        timer: setTimeout(() => {
          this.pollers = this.pollers.filter((waiting) => waiting !== poller);
          poller.resolve(null);
        }, nextWaitMs)
      };
      this.pollers.push(poller);
    });
  }

  result(commandId: string, output: CommandOutput): void {
    logInfo("command_result", { commandId, exitCode: output.exitCode, bytes: output.stdout.length + output.stderr.length });
    this.finish(commandId, { kind: "done", output });
  }

  rejectOversizedResult(commandId: string): void {
    this.finish(commandId, { kind: "oversized" });
  }

  async end(): Promise<void> {
    const session = await this.session();
    if (session && !session.endedAt) await this.ctx.storage.put("session", { ...session, endedAt: Date.now() });
    this.cancelAll();
  }

  async alarm(): Promise<void> {
    this.cancelAll();
    await this.ctx.storage.deleteAll();
  }

  private async active(): Promise<boolean> {
    const session = await this.session();
    return Boolean(session && !session.endedAt);
  }

  private dispatch(command: Command): void {
    const poller = this.pollers.shift();
    if (!poller) {
      this.queue.push(command);
      return;
    }
    clearTimeout(poller.timer);
    poller.resolve(this.deliver(command));
  }

  private deliver(command: Command): Command {
    const pending = this.pending.get(command.id);
    if (pending) {
      clearTimeout(pending.timer);
      pending.timer = setTimeout(() => this.finish(command.id, { kind: "timeout" }), command.timeout * 1000 + resultGraceMs);
    }
    return command;
  }

  private finish(commandId: string, outcome: CommandOutcome): void {
    const pending = this.pending.get(commandId);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.pending.delete(commandId);
    if (this.queue.length > 0) {
      const queueIndex = this.queue.findIndex((command) => command.id === commandId);
      if (queueIndex !== -1) this.queue.splice(queueIndex, 1);
    }
    if (outcome.kind === "timeout") logInfo("command_timeout", { commandId });
    pending.resolve(outcome);
  }

  private cancelAll(): void {
    for (const commandId of this.pending.keys()) this.finish(commandId, { kind: "ended" });
    for (const poller of this.pollers) {
      clearTimeout(poller.timer);
      poller.resolve(null);
    }
    this.pollers = [];
    this.queue = [];
  }
}
