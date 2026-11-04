import js from "@eslint/js";
import tseslint from "typescript-eslint";
import pluginVue from "eslint-plugin-vue";
import globals from "globals";

// Source-level guardrails mirroring scripts/security-audit.mjs. The audit runs
// against dist/ bundles after every build; these rules catch the same classes of
// privilege drift in source, before the code ever reaches a release gate.
//
// Storage ban scope is FAIL-CLOSED: every src TS file is banned from
// localStorage/sessionStorage/importScripts unless it matches an explicit
// UI-surface exemption (below). A new top-level src/ directory therefore fails
// the gate until it is consciously classified, instead of silently escaping the
// ban while still being bundled into a trusted release script. src/passkey/** and
// the shared i18n runtime/locale modules are pulled into
// background.js/content.js/main-world.js via value imports, so the exemption list
// is deliberately narrow (src/i18n/index.ts persists the manager locale, not
// runtime.ts/locales.ts). The dist audit keeps verifying that exempt surfaces'
// tokens never leak into background.js/content.js/main-world.js.
const storageBanExemptions = ["**/*.test.ts", "src/cli/**", "src/i18n/index.ts", "src/lib/**"];

// Shared so the trusted-graph block and the content/passkey block cannot drift:
// with flat config the later definition of a rule wins per file, so the
// content/passkey block must restate the storage bans plus its own connectNative
// selectors. Both blocks build from the same arrays.
const storageBans = [
  { selector: "MemberExpression[property.name='localStorage']", message: "Trusted release bundles must not touch web storage (member access included); use chrome.storage or the vault runtime." },
  { selector: "MemberExpression[property.name='sessionStorage']", message: "Trusted release bundles must not touch web storage (member access included); use chrome.storage or the vault runtime." },
  { selector: "MemberExpression[computed=true][property.value='localStorage']", message: "Trusted release bundles must not touch web storage (computed access included); use chrome.storage or the vault runtime." },
  { selector: "MemberExpression[computed=true][property.value='sessionStorage']", message: "Trusted release bundles must not touch web storage (computed access included); use chrome.storage or the vault runtime." },
  { selector: "Property[computed=false][key.name='localStorage']", message: "Trusted release bundles must not alias web storage via destructuring; use chrome.storage or the vault runtime." },
  { selector: "Property[computed=false][key.name='sessionStorage']", message: "Trusted release bundles must not alias web storage via destructuring; use chrome.storage or the vault runtime." },
  { selector: "MemberExpression[property.name='importScripts']", message: "The release CSP bans importScripts in trusted bundles (member access included); use ES module workers." }
];
const connectNativeBans = [
  { selector: "MemberExpression[property.name='connectNative']", message: "Content and MAIN-world scripts must never use Native Messaging; only the background service worker may. scripts/security-audit.mjs rejects the token in dist content/main-world bundles." },
  { selector: "MemberExpression[computed=true][property.value='connectNative']", message: "Content and MAIN-world scripts must never use Native Messaging (computed access included); only the background service worker may." }
];
const underscoreIgnores = {
  argsIgnorePattern: "^_",
  varsIgnorePattern: "^_",
  destructuredArrayIgnorePattern: "^_",
  caughtErrorsIgnorePattern: "^_",
  // Deliberate strip-a-key idiom: const { secret, ...shareable } = item.
  ignoreRestSiblings: true
};

export default [
  {
    ignores: [
      "dist/**",
      "dist-firefox/**",
      "release/**",
      ".artifacts/**",
      ".tmp/**",
      ".codex-tmp/**",
      ".codex-tasks/**",
      "coverage/**",
      "playwright-report/**",
      "test-results/**",
      "brand/**",
      "store-assets/**",
      "public/**",
      "native/**",
      ".zcode/**"
    ]
  },
  {
    linterOptions: {
      reportUnusedDisableDirectives: "error"
    }
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  // Vue configs come before our own overrides so the overrides win.
  ...pluginVue.configs["flat/essential"],
  {
    files: ["**/*.ts"],
    languageOptions: {
      parser: tseslint.parser,
      globals: { ...globals.browser, ...globals.node, chrome: "readonly" }
    },
    rules: {
      // Intentionally-ignored bindings use the `_` prefix (e.g. handler factories
      // pass positional parameters that some handlers do not need).
      "@typescript-eslint/no-unused-vars": ["error", underscoreIgnores],
      // This is a password manager: control-character ranges in regex literals are
      // the deliberate mechanism for validating/sanitising untrusted input
      // (passwords, SSIDs, file names, API tokens). The rule's signal here is noise.
      "no-control-regex": "off"
    }
  },
  {
    // Type-aware rules for the src project only; tests/interop and root configs
    // live in separate tsconfigs and stay syntax-level.
    files: ["src/**/*.ts"],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname
      }
    },
    plugins: { "@typescript-eslint": tseslint.plugin },
    rules: {
      "@typescript-eslint/no-floating-promises": "error",
      "@typescript-eslint/no-misused-promises": "error"
    }
  },
  {
    files: ["**/*.vue"],
    languageOptions: {
      parserOptions: { parser: tseslint.parser, extraFileExtensions: [".vue"] },
      globals: { ...globals.browser, chrome: "readonly" }
    },
    plugins: { vue: pluginVue },
    rules: {
      // .vue files are parsed as TypeScript; no-undef is TS's job.
      "no-undef": "off",
      "vue/no-v-html": "error",
      // `slot="…"` targets m3e-* native web components (standard shadow DOM slotting,
      // not the removed Vue 2 slot syntax); switching to v-slot would alter how the
      // custom elements receive slotted content.
      "vue/no-deprecated-slot-attribute": "off"
    }
  },
  {
    // Test fixtures and interop recordings parse external app data whose shape is
    // not statically typed; explicit typing every fixture is not worth the churn.
    // Production source keeps the rule at "error".
    files: ["tests/**/*.ts", "src/**/*.test.ts"],
    rules: {
      "@typescript-eslint/no-explicit-any": "off"
    }
  },
  {
    // Playwright validates test callbacks at load time and requires the first
    // argument to be a destructuring pattern, so `async ({}, testInfo)` is the
    // framework-canonical signature when only testInfo is needed. no-empty-pattern
    // fights that contract in e2e specs.
    files: ["tests/**/*.ts"],
    rules: {
      "no-empty-pattern": "off"
    }
  },
  {
    files: ["scripts/**/*.mjs", "scripts/**/*.cjs", "*.mjs"],
    languageOptions: {
      // Probe/acceptance scripts drive real browsers via Playwright and evaluate
      // code inside extension pages, so they mix Node and browser globals.
      globals: { ...globals.node, ...globals.browser, chrome: "readonly" }
    },
    rules: {
      "@typescript-eslint/no-unused-vars": ["error", underscoreIgnores]
    }
  },
  {
    files: ["tests/**/*.ts"],
    languageOptions: {
      globals: { ...globals.browser, ...globals.node, chrome: "readonly" }
    }
  },
  {
    // FAIL-CLOSED trusted-graph storage ban: every src TS file is covered unless
    // explicitly exempted (see storageBanExemptions above).
    files: ["src/**/*.ts"],
    ignores: storageBanExemptions,
    rules: {
      "no-restricted-globals": ["error",
        { name: "localStorage", message: "Trusted release bundles must not touch web storage; use chrome.storage or the vault runtime. scripts/security-audit.mjs rejects the token in dist bundles." },
        { name: "sessionStorage", message: "Trusted release bundles must not touch web storage; use chrome.storage or the vault runtime. scripts/security-audit.mjs rejects the token in dist bundles." },
        { name: "importScripts", message: "The release CSP bans importScripts in trusted bundles; use ES module workers. scripts/security-audit.mjs rejects the token in dist bundles." }
      ],
      "no-restricted-syntax": ["error", ...storageBans]
    }
  },
  {
    // no-restricted-properties cannot match nested member objects (chrome.runtime
    // is itself a MemberExpression), so connectNative is banned via syntax selectors.
    // Restates the storage bans: with flat config the later definition of a rule
    // wins, so content/passkey files must carry the full selector set.
    files: ["src/content/**/*.ts", "src/passkey/**/*.ts"],
    ignores: ["**/*.test.ts"],
    rules: {
      "no-restricted-syntax": ["error", ...storageBans, ...connectNativeBans]
    }
  },
  {
    files: ["src/**/*.ts", "src/**/*.vue"],
    rules: {
      "no-eval": "error",
      "no-new-func": "error"
    }
  }
];
