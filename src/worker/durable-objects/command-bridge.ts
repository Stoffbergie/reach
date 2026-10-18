import { DurableObject } from "cloudflare:workers";
import { sessionTtlMs } from "../../shared/config";
import type { Env } from "../env";
import { CommandBridgeCore } from "./command-bridge-core";

export type Session = {
  code: string;
  createdAt: number;
  expiresAt: number;
  endedAt?: number;
};

export class CommandBridge extends DurableObject<Env> {
  private readonly core = new CommandBridgeCore();

  async create(code: string): Promise<boolean> {
    if (await this.session()) return false;
    const now = Date.now();
    const session: Session = { code, createdAt: now, expiresAt: now + sessionTtlMs };
    await this.ctx.storage.put("session", session);
    await this.ctx.storage.setAlarm(session.expiresAt);
    return true;
  }

  async session(): Promise<Session | undefined> {
    return this.ctx.storage.get<Session>("session");
  }

  async end(): Promise<void> {
    const session = await this.session();
    if (session && !session.endedAt) await this.ctx.storage.put("session", { ...session, endedAt: Date.now() });
    this.core.endSession();
  }

  async alarm(): Promise<void> {
    this.core.endSession();
    await this.ctx.storage.deleteAll();
  }

  async fetch(request: Request): Promise<Response> {
    return this.core.fetch(request);
  }
}
