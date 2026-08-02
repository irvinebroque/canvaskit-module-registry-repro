import { cloudflare } from "@cloudflare/vite-plugin";
import { defineConfig } from "vite";

export default defineConfig({
  build: { outDir: "dist-validation-vite" },
  plugins: [
    cloudflare({
      configPath: "./wrangler.validation.jsonc",
      inspectorPort: false,
      persistState: false,
    }),
  ],
});
