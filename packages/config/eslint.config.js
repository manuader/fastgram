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
      // Next 15 lo regenera en cada `build`/`dev` con un triple-slash reference.
      // No es código nuestro y no se puede arreglar: `typedRoutes: false`
      // tampoco lo suprime (verificado).
      "**/next-env.d.ts",
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
    // Scripts de Node sueltos (`scripts/*.mjs`). No pasan por TypeScript, así
    // que `no-undef` sí sirve acá — pero necesita conocer los globals.
    files: ["**/*.mjs"],
    languageOptions: {
      globals: {
        console: "readonly",
        process: "readonly",
        URL: "readonly",
        Buffer: "readonly",
        __dirname: "readonly",
        fetch: "readonly",
        // Van con `fetch`: un `fetch` sin timeout en un script de CI cuelga el
        // job hasta que GitHub lo mata a los 360 minutos.
        AbortSignal: "readonly",
        AbortController: "readonly",
      },
    },
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
