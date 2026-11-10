import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.jsonc" },
      miniflare: {
        bindings: {
          API_TOKEN: "test-api-token",
          // Access stays unconfigured here: the admin plane must fail closed,
          // and that is one of the things under test.
          ACCESS_AUD: "",
          ACCESS_TEAM_DOMAIN: "",
          ALLOW_INSECURE_ADMIN: "0",
        },
      },
    }),
  ],
});
