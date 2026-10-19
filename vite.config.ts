import { cloudflare } from "@cloudflare/vite-plugin";
import { defineConfig } from "vite-plus";

export default defineConfig({
  plugins: process.env.VITEST ? [] : [cloudflare()],
  build: { minify: true },
  server: { host: "0.0.0.0", port: 8787 },
  test: {
    include: ["tests/**/*.test.ts"],
    globalSetup: ["tests/setup/worker.ts"],
    fileParallelism: false,
    testTimeout: 15_000,
    hookTimeout: 15_000,
    restoreMocks: true
  },
  fmt: { printWidth: 200, trailingComma: "none" },
  lint: { options: { typeAware: true, typeCheck: true } },
  staged: { "*": "vp check --fix" }
});
