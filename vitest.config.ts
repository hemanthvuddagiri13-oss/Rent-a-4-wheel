import { defineConfig } from "vitest/config";
import { loadEnv } from "vite";
import tsconfigPaths from "vite-tsconfig-paths";

export default defineConfig({
  plugins: [tsconfigPaths({ projects: ["./tsconfig.json"] })],
  test: {
    environment: "node",
    // Some suites share the singleton LegalDocument configuration. Individual
    // financial tests explicitly overlap independent PostgreSQL connections.
    fileParallelism: false,
    include: ["tests/**/*.test.ts"],
    testTimeout: 20000,
    // Load DATABASE_URL (and any other .env values) into process.env for the
    // Prisma-backed integration tests — Vitest does not do this by default.
    env: loadEnv("", process.cwd(), ""),
  },
});
