# ADR 0005 — Toolchain

- Status: accepted
- Date: 2026-10-12

- **Node 24 LTS** (`.nvmrc`, `engines`).
- **pnpm 12 via corepack.** The version is pinned in `packageManager`. Dependency build scripts are opt-in through `allowBuilds` in `pnpm-workspace.yaml`. `msgpackr-extract` is denied: it's an optional native speedup that otherwise tries to compile with node-gyp, and msgpackr works without it.
- **TypeScript 6.0, not 7.x**, because `typescript-eslint` 8.x supports `<6.1`. Move to TS 7 when typescript-eslint does.
- **ESLint 10 flat config + typescript-eslint, Prettier, Vitest 5.**
- **Workspace packages resolve to source in dev and tests.** Each package exports a custom `@communal/source` condition that points at `src/index.ts`. `tsconfig.base.json` (`customConditions`), Vitest (`resolve.conditions`) and `tsx --conditions=@communal/source` all use it, so tests and dev runs need no build step. Production builds and the Docker images use the compiled `dist/` through the `default` condition.
- **Crypto libraries:** `@noble/curves`, `@noble/hashes`, `@noble/ciphers`, `@scure/bip39`, `@scure/base`. They are audited and pure JS, so there are no native builds in the crypto path. Fast bulk file hashing (`hash-wasm` or native `blake3`) is decided in M2.
- **Docker images** are based on `node:24-bookworm-slim`, because glibc is needed for the udx-native and sharp prebuilds. They use multi-stage builds with `pnpm deploy --prod`.
