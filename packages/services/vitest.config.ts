import { defineProject } from "vitest/config";

export default defineProject({ test: { name: "services", include: ["src/**/*.test.ts"] } });
