import { strict as assert } from "node:assert";
import { test } from "vite-plus/test";
import { assertOk, baseUrl, end, findCommand, send, startAgent } from "../helpers/reach";

const docker = findCommand("docker");
const runContainers = Boolean(docker && process.platform !== "win32" && process.env.REACH_DOCKER_E2E === "1");

const targets = [
  { name: "Alpine BusyBox sh", image: "alpine:3.20", setup: "apk add --no-cache curl ca-certificates >/dev/null" },
  { name: "Debian 12 dash", image: "buildpack-deps:bookworm-curl", setup: "true" },
  { name: "Ubuntu 22.04 sh", image: "ubuntu:22.04", setup: "apt-get update -qq >/dev/null && DEBIAN_FRONTEND=noninteractive apt-get install -y -qq curl ca-certificates >/dev/null" }
];

for (const target of targets) {
  test.skipIf(!runContainers)(
    `POSIX agent runs in ${target.name}`,
    async () => {
      const url = baseUrl.replace("127.0.0.1", "host.docker.internal");
      const hostArgs = process.platform === "linux" ? ["--add-host", "host.docker.internal:host-gateway"] : [];
      const agent = await startAgent(docker, ["run", "--rm", ...hostArgs, target.image, "sh", "-c", `${target.setup} && curl -sS ${url} | sh`], {}, 120_000);
      try {
        const result = await send(agent.code, "printf container-e2e");
        assertOk(result, agent);
        assert.equal(result.text, "container-e2e");

        await end(agent.code);
        assert.equal(await agent.exit(20_000), 0);
      } finally {
        agent.stop();
      }
    },
    180_000
  );
}
