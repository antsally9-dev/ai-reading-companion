import js from "@eslint/js";
import globals from "globals";
import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["node_modules", "out"] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["src/main/**/*.ts", "src/preload/**/*.ts", "electron.vite.config.ts", "test/**/*.ts", "scripts/**/*.mjs"],
    languageOptions: { globals: { ...globals.node, ...globals.browser } },
  },
  {
    files: ["src/renderer/src/**/*.{ts,tsx}"],
    languageOptions: { globals: { ...globals.browser } },
  },
);
