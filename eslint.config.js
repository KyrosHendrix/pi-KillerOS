import tseslint from "typescript-eslint";

export default [
  { ignores: ["eslint.config.js"] },
  ...tseslint.configs.recommendedTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      // Pi's extension API requires async handlers even when a body never awaits.
      "@typescript-eslint/require-await": "off",
      // Hook timers are read in closures declared textually before their single assignment.
      "prefer-const": ["error", { ignoreReadBeforeAssign: true }],
      // Rest-omission destructuring intentionally names dropped keys with a _ prefix.
      "@typescript-eslint/no-unused-vars": ["error", { varsIgnorePattern: "^_", argsIgnorePattern: "^_" }],
    },
  },
  {
    files: ["test/**/*.ts"],
    rules: {
      // node:test registration returns the runner-owned promise for every test block.
      "@typescript-eslint/no-floating-promises": "off",
    },
  },
];
