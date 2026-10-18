import { strict as assert } from "node:assert";
import { test } from "vite-plus/test";
import { baseUrl, end, send, startShellAgent, type SessionStatus } from "../helpers/reach";

test("unknown sessions and empty commands return plain text errors", async () => {
  const unknown = await send("23456789", "pwd");
  assert.equal(unknown.status, 404);
  assert.equal(unknown.text, "Session not found\n");

  const agent = await startShellAgent();
  try {
    const empty = await send(agent.code, "");
    assert.equal(empty.status, 400);
    assert.equal(empty.text, "Command is required\n");

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

test("status shows the agent's shell and whether it is connected", async () => {
  const agent = await startShellAgent();
  try {
    const response = await fetch(`${baseUrl}/${agent.code}`);
    assert.equal(response.status, 200);
    const status = (await response.json()) as SessionStatus;
    assert.equal(status.code, agent.code);
    assert.equal(status.shell, "sh");
    assert.equal(status.connected, true);
    assert.ok(Date.parse(status.expiresAt) > Date.now());
  } finally {
    await end(agent.code);
    agent.stop();
  }
});

test("JSON requests and responses carry the exit code, stdout and stderr separately", async () => {
  const agent = await startShellAgent();
  try {
    const response = await fetch(`${baseUrl}/${agent.code}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ command: "printf out; printf err >&2; exit 2", cwd: "/", timeout: 5 })
    });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { exitCode: 2, stdout: "out", stderr: "err" });
  } finally {
    await end(agent.code);
    agent.stop();
  }
});

test("too many lookups from one address are refused", async () => {
  const headers = { "cf-connecting-ip": "203.0.113.9" };
  const statuses: number[] = [];
  for (let batch = 0; batch < 16; batch += 1) {
    const responses = await Promise.all(Array.from({ length: 20 }, () => fetch(`${baseUrl}/23456789`, { headers })));
    statuses.push(...responses.map((response) => response.status));
  }
  assert.equal(statuses.at(0), 404);
  assert.equal(statuses.at(-1), 429);
});
