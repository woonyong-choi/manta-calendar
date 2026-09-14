import eslint from "@eslint/js";
import obsidianmd from "eslint-plugin-obsidianmd";
import tseslint from "typescript-eslint";

export default tseslint.config(
  eslint.configs.recommended,
  ...obsidianmd.configs.recommended,
  ...tseslint.configs.strictTypeChecked,
  {
    languageOptions: {
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
    },
    rules: {
      "@typescript-eslint/no-confusing-void-expression": "off",
      "@typescript-eslint/no-deprecated": "off",
      "@typescript-eslint/no-misused-promises": ["error", { "checksVoidReturn": false }],
      "@typescript-eslint/require-await": "off",
      "obsidianmd/ui/sentence-case": [
        "warn",
        { brands: ["Link Calendar", "Markdown", "Obsidian"] },
      ],
    },
  },
  {
    files: ["tests/**/*.ts"],
    rules: {
      "obsidianmd/no-global-this": "off",
      "obsidianmd/prefer-create-el": "off",
    },
  },
  {
    files: ["tests/google-auth.test.ts", "tests/google-desktop.test.ts"],
    // These socket tests run in Node, where browser fetch and timers simulate the external browser.
    rules: { "no-restricted-globals": "off", "obsidianmd/prefer-window-timers": "off" },
  },
  { ignores: ["main.js", "node_modules", "coverage"] },
);
