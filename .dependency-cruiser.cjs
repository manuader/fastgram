/**
 * Reglas de frontera — P0-REPO-006 · IMPLEMENTATION-PLAN §2.1
 *
 * Esto no es estilo: es la regla de dependencia de la arquitectura hexagonal.
 * Se enforcea acá, en CI, porque con varios agentes trabajando en paralelo
 * "acordarse" no es un mecanismo. Si una de estas reglas dispara, el build
 * falla y el PR no entra.
 *
 *   apps/*  ──→  packages/core  ──→  packages/ports
 *      │                                  ↑
 *      └──────→  packages/adapters  ───────┘
 */
module.exports = {
  forbidden: [
    {
      name: "core-no-adapters",
      severity: "error",
      comment:
        "packages/core no puede importar packages/adapters. El dominio no sabe " +
        "quién implementa sus puertos; si lo supiera, cambiar de proveedor " +
        "obligaría a tocar el dominio y los puertos no servirían de nada.",
      from: { path: "^packages/core" },
      to: { path: "^packages/adapters" },
    },
    {
      name: "core-no-npm",
      severity: "error",
      comment:
        "packages/core es TypeScript puro: sólo puede importar @fastgram/ports. " +
        "Ni SDKs de proveedor, ni frameworks, ni utilidades de npm. Es lo que " +
        "mantiene los tests de dominio rápidos y sin IO, y lo que impide que un " +
        "detalle de infraestructura se filtre a una invariante de negocio.",
      from: { path: "^packages/core/src" },
      to: {
        dependencyTypes: ["npm", "npm-dev", "npm-optional", "npm-peer", "npm-bundled"],
        pathNot: ["node_modules/@fastgram/ports"],
      },
    },
    {
      name: "core-no-apps",
      severity: "error",
      comment: "El dominio no conoce a quien lo invoca.",
      from: { path: "^packages/core" },
      to: { path: "^(apps|services)/" },
    },
    {
      name: "ports-are-pure",
      severity: "error",
      comment:
        "packages/ports son interfaces. Un puerto que importa el SDK que " +
        "pretende abstraer deja de ser una abstracción.",
      from: { path: "^packages/ports/src" },
      to: {
        dependencyTypes: ["npm", "npm-dev", "npm-optional", "npm-peer", "npm-bundled"],
      },
    },
    {
      name: "ports-no-adapters",
      severity: "error",
      from: { path: "^packages/ports" },
      to: { path: "^packages/(adapters|core|db)" },
    },
    {
      name: "adapters-no-apps",
      severity: "error",
      comment: "Un adaptador no conoce la app que lo monta.",
      from: { path: "^packages/adapters" },
      to: { path: "^apps/" },
    },
    {
      name: "web-no-db",
      severity: "error",
      comment:
        "apps/web no habla con la base. Va contra apps/api. Si el front " +
        "consulta la base directo, la autorización por companyId deja de tener " +
        "un solo lugar donde vivir.",
      from: { path: "^apps/web" },
      to: { path: "^packages/(db|adapters)" },
    },
    {
      name: "contracts-are-standalone",
      severity: "error",
      comment:
        "packages/contracts define el contrato público de la API v1. Si " +
        "dependiera de core o db, publicar el SDK arrastraría el dominio entero.",
      from: { path: "^packages/contracts" },
      to: { path: "^packages/(core|db|adapters|ports)" },
    },
    {
      name: "no-circular",
      severity: "error",
      comment: "Ciclo de dependencias.",
      from: {},
      to: { circular: true },
    },
    {
      name: "no-orphans",
      severity: "warn",
      comment:
        "Un archivo que nadie importa. Suele ser código muerto tras un " +
        "refactor. Los puntos de entrada NO cuentan: los arranca Node o el " +
        "framework, no un import. Se excluyen abajo a propósito, porque una " +
        "lista de warnings que siempre trae los mismos siete archivos " +
        "legítimos enseña a ignorar la lista entera.",
      from: {
        orphan: true,
        pathNot: [
          "(^|/)\\.[^/]+\\.(js|cjs|mjs|ts|json)$",
          "\\.d\\.ts$",
          "(^|/)tsconfig\\.json$",
          "(^|/)(package|vitest\\.config|drizzle\\.config)\\.(json|js|ts)$",
          // Puntos de entrada de proceso: los arranca Node.
          "^(apps|services)/[^/]+/src/main\\.ts$",
          // Configuración de framework: la lee el framework.
          "^apps/[^/]+/(next\\.config|postcss\\.config|tailwind\\.config)\\.(ts|mjs|js)$",
          // Rutas y layouts del App Router: los descubre Next por convención.
          "^apps/web/src/app/.*\\.(tsx|ts)$",
        ],
      },
      to: {},
    },
  ],
  options: {
    doNotFollow: { path: "node_modules" },
    exclude: { path: "(\\.test\\.ts$|\\.spec\\.ts$|/__tests__/|/dist/|\\.next/)" },
    tsPreCompilationDeps: true,
    tsConfig: { fileName: "tsconfig.base.json" },
    enhancedResolveOptions: {
      exportsFields: ["exports"],
      conditionNames: ["import", "require", "node", "default", "types"],
      extensions: [".js", ".jsx", ".ts", ".tsx"],
    },
    reporterOptions: {
      text: { highlightFocused: true },
    },
  },
};
