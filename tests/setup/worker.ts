import type { AddressInfo } from "node:net";
import { cloudflare } from "@cloudflare/vite-plugin";
import { createServer } from "vite-plus";
import type { TestProject } from "vite-plus/test/node";

declare module "vite-plus/test" {
  export interface ProvidedContext {
    baseUrl: string;
  }
}

export default async function startWorker(project: TestProject): Promise<() => Promise<void>> {
  const server = await createServer({
    configFile: false,
    logLevel: "error",
    plugins: [cloudflare({ persistState: false })],
    server: { host: "0.0.0.0", port: 0, allowedHosts: true }
  });
  await server.listen();
  const address = server.httpServer?.address() as AddressInfo;
  project.provide("baseUrl", `http://127.0.0.1:${address.port}`);
  return () => server.close();
}
