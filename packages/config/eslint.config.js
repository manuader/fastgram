import js from "@eslint/js";
import tseslint from "typescript-eslint";
import prettier from "eslint-config-prettier";

/** Config base compartida del monorepo. */
export default tseslint.config(
  {
    ignores: [
      "**/dist/**",
      "**/.next/**",
      "**/.turbo/**",
      "**/node_modules/**",
      "**/coverage/**",
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  prettier,
  {
    // TypeScript ya detecta identificadores no definidos, y con mejor
    // información que el linter. Dejar `no-undef` activo en .ts sólo produce
    // falsos positivos con los globals de Node.
    files: ["**/*.ts", "**/*.tsx"],
    rules: { "no-undef": "off" },
  },
  {
    files: ["**/*.cjs"],
    languageOptions: {
      sourceType: "commonjs",
      globals: {
        module: "writable",
        require: "readonly",
        __dirname: "readonly",
        process: "readonly",
      },
    },
  },
  {
    rules: {
      // `any` prohibido salvo con comentario que explique por qué (IMPL §4).
      "@typescript-eslint/no-explicit-any": "error",
      "@typescript-eslint/consistent-type-imports": [
        "error",
        { prefer: "type-imports", fixStyle: "inline-type-imports" },
      ],
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
      "no-restricted-syntax": [
        "error",
        {
          selector: "TSNonNullExpression",
          message:
            "El `!` esconde un caso que el tipo dice que puede pasar. Manejalo, o explicá por qué no puede con un comentario y un assert.",
        },
      ],
      eqeqeq: ["error", "always", { null: "ignore" }],
    },
  },
);
