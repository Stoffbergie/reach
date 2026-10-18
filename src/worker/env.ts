import type { CommandBridge } from "./durable-objects/command-bridge";

export type Env = {
  COMMAND_BRIDGES: DurableObjectNamespace<CommandBridge>;
  LOOKUPS: RateLimit;
};
