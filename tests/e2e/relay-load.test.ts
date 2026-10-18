import { performance } from "node:perf_hooks";
import { test } from "vite-plus/test";
import { strict as assert } from "node:assert";
import { baseUrl, send, sleep } from "../helpers/soe";

test("relay bridge handles a burst of parallel commands without timeouts or result mixups", async () => {
  const session = await createSession();
  try {
    const count = 64;
    const startedAt = performance.now();
    const sends = Array.from({ length: count }, (_, index) => {
      const body = `load-${index}`;
      return send(session.id, body, { timeout: 20 }).then((response) => ({ body, response }));
    });

    const commands = [];
    for (let index = 0; index < count; index += 1) {
      commands.push(await nextCommand(session.id));
    }

    for (const command of commands.reverse()) {
      const response = await fetch(`${baseUrl}/${session.id}/result/${command.id}?exit=0`, {
        method: "POST",
        body: `done:${command.body}`
      });
      assert.equal(response.status, 200);
    }

    const results = await Promise.all(sends);
    const elapsedMs = performance.now() - startedAt;
    assert.ok(elapsedMs < 2500, `relay burst took ${elapsedMs}ms`);
    assert.equal(new Set(commands.map((command) => command.id)).size, count);
    for (const item of results) {
      assert.equal(item.response.status, 200);
      assert.equal(item.response.text, `done:${item.body}`);
    }
  } finally {
    await fetch(`${baseUrl}/${session.id}`, { method: "DELETE" });
  }
});

async function createSession(): Promise<{ id: string }> {
  const response = await fetch(baseUrl, { method: "POST" });
  assert.equal(response.status, 201);
  const id = (await response.text()).trim();
  assert.match(id, /^[23456789abcdefghjkmnpqrstuvwxyz]{8}$/);
  return { id };
}

async function nextCommand(sessionId: string): Promise<{ id: string; body: string }> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const response = await fetch(`${baseUrl}/${sessionId}/next`);
    if (response.status === 200) {
      const id = response.headers.get("X-Command-Id") || "";
      assert.ok(id);
      return { id, body: await response.text() };
    }
    assert.equal(response.status, 204);
    await sleep(25);
  }
  throw new Error("Timed out waiting for load-test command");
}
