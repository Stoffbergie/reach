import { strict as assert } from "node:assert";
import { mkdir, mkdtemp, realpath, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { test } from "vite-plus/test";
import { assertOk, baseUrl, end, findCommand, send, sessionCodePattern, startPowerShellAgent, startShellAgent, type JsonOutput, type SessionStatus } from "../helpers/reach";

const posix = Boolean(findCommand("sh") && findCommand("curl"));
const powerShell = findCommand(process.platform === "win32" ? ["pwsh", "powershell.exe"] : ["pwsh"]);

test.skipIf(!posix)("POSIX agent prints a code, runs commands and exits when the session ends", async () => {
  const agent = await startShellAgent();
  try {
    assert.match(agent.code, sessionCodePattern);
    assert.match(agent.output(), /Stop anytime: Ctrl\+C/);

    const result = await send(agent.code, "printf hello");
    assertOk(result, agent);
    assert.equal(result.text, "hello");

    assert.equal((await end(agent.code)).status, 200);
    assert.equal(await agent.exit(), 0);
  } finally {
    agent.stop();
  }
});

test.skipIf(!posix)("POSIX agent runs raw shell syntax and reports failed commands with their exit code", async () => {
  const agent = await startShellAgent();
  try {
    const grouped = await send(agent.code, "{ printf grouped; }");
    assertOk(grouped, agent);
    assert.equal(grouped.text, "grouped");

    const failed = await send(agent.code, "printf broken; exit 3");
    assertOk(failed, agent);
    assert.equal(failed.text, "broken");
    assert.equal(failed.headers.get("X-Exit-Code"), "3");
  } finally {
    await end(agent.code);
    agent.stop();
  }
});

test.skipIf(!posix)("POSIX agent runs commands in the requested working directory", async () => {
  const dir = await realpath(await mkdtemp(join(tmpdir(), "reach-cwd-")));
  const agent = await startShellAgent();
  try {
    const result = await send(agent.code, "pwd", { cwd: dir });
    assertOk(result, agent);
    assert.equal(result.text.trim(), dir);
  } finally {
    await end(agent.code);
    agent.stop();
    await rm(dir, { force: true, recursive: true });
  }
});

test.skipIf(!posix)("POSIX agent keeps parallel command output apart", async () => {
  const agent = await startShellAgent();
  try {
    const results = await Promise.all(Array.from({ length: 8 }, (_, index) => send(agent.code, `printf parallel-${index}`)));
    results.forEach((result, index) => {
      assertOk(result, agent);
      assert.equal(result.text, `parallel-${index}`);
    });
  } finally {
    await end(agent.code);
    agent.stop();
  }
});

test.skipIf(!posix || process.platform === "win32")("POSIX agent stops slow commands without a timeout binary", async () => {
  const dir = await mkdtemp(join(tmpdir(), "reach-no-timeout-"));
  const bin = join(dir, "bin");
  await mkdir(bin);
  for (const command of ["awk", "base64", "cat", "curl", "kill", "mktemp", "rm", "sh", "sleep", "uname"]) {
    const path = findCommand(command);
    if (path) await symlink(path, join(bin, command));
  }
  const agent = await startShellAgent({ env: { PATH: bin } });
  try {
    const startedAt = performance.now();
    const slow = await send(agent.code, "sleep 5; printf too-late", { timeout: 1 });
    assert.ok(performance.now() - startedAt < 4000, agent.output());
    assert.notEqual(slow.text, "too-late");

    const recovered = await send(agent.code, "printf recovered");
    assertOk(recovered, agent);
    assert.equal(recovered.text, "recovered");
  } finally {
    await end(agent.code);
    agent.stop();
    await rm(dir, { force: true, recursive: true });
  }
});

test.skipIf(!powerShell)(
  "PowerShell agent runs commands, stops slow ones and exits when the session ends",
  async () => {
    const agent = await startPowerShellAgent(powerShell);
    try {
      const result = await send(agent.code, "Write-Output hello");
      assertOk(result, agent);
      assert.equal(result.text.trim(), "hello");

      const status = (await (await fetch(`${baseUrl}/${agent.code}`)).json()) as SessionStatus;
      assert.equal(status.shell, "powershell");

      const split = await fetch(`${baseUrl}/${agent.code}`, { method: "POST", headers: { Accept: "application/json" }, body: "Write-Output out; Write-Error err" });
      const output = (await split.json()) as JsonOutput;
      assert.equal(output.stdout.trim(), "out", agent.output());
      assert.match(output.stderr, /err/);

      const exited = await fetch(`${baseUrl}/${agent.code}`, { method: "POST", headers: { Accept: "application/json" }, body: "Write-Output before; exit 3" });
      assert.equal(exited.status, 200);
      const exitOutput = (await exited.json()) as JsonOutput;
      assert.equal(exitOutput.exitCode, 3);
      assert.equal(exitOutput.stdout.trim(), "before");
      assert.equal(exitOutput.stderr, "");

      const startedAt = performance.now();
      const slow = await send(agent.code, "Start-Sleep -Seconds 10; Write-Output too-late", { timeout: 2 });
      assert.ok(performance.now() - startedAt < 8000, agent.output());
      assert.match(slow.text, /timed out/i);

      assert.equal((await end(agent.code)).status, 200);
      assert.equal(await agent.exit(), 0);
    } finally {
      agent.stop();
    }
  },
  30_000
);
