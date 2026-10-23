import { defineConfig } from "vitest/config";

// Wrangler imports .sql and .html files as text; do the same under test.
export default defineConfig({
  plugins: [
    {
      name: "text-modules",
      transform(code, id) {
        if (id.endsWith(".sql") || id.endsWith(".html")) return { code: `export default ${JSON.stringify(code)};`, map: null };
      },
    },
  ],
});
