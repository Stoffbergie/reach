import { strict as assert } from "node:assert";
import { test } from "vite-plus/test";
import { baseUrl, end, send, startShellAgent } from "../helpers/soe";

test("unknown sessions and empty commands return plain text errors", async () => {
  const unknown = await send("23456789", "pwd");
  assert.equal(unknown.status, 404);
  assert.equal(unknown.text, "Session not found\n");

  const agent = await startShellAgent();
  try {
    const empty = await send(agent.code, "");
    assert.equal(empty.status, 400);
    assert.equal(empty.text, "Command body is required\n");

    const tooLarge = await send(agent.code, "x".repeat(70_000));
    assert.equal(tooLarge.status, 413);
  } finally {
    await end(agent.code);
    agent.stop();
  }

  const ended = await send(agent.code, "pwd");
  assert.equal(ended.status, 410);
  assert.equal(ended.text, "Session ended\n");
});

test("unknown routes return not found", async () => {
  const response = await fetch(`${baseUrl}/api/agent/connect`);
  assert.equal(response.status, 404);
  assert.equal(await response.text(), "Not found\n");
});
