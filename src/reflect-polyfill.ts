/**
 * Installs the `reflect-metadata` polyfill before anything that can reach tsyringe (mt#3680).
 *
 * This file exists to be a MODULE, and that is its entire job. `src/cli.ts` used to carry
 * `import "reflect-metadata"` as its own first import, which is correct ESM but does not survive
 * bundling: `reflect-metadata` is CommonJS, so `bun build` lowers the import to a
 * `var … = __toESM(require_Reflect(), 1)` DECLARATION and emits it after every ESM `init_*()`
 * STATEMENT in the same block — inverting source order. Measured on Bun 1.3.14, the entry block
 * came out as:
 *
 *     init_cold_start_profile2();   // source import #2
 *     init_config_setup();          // source import #3  ← reaches tsyringe, throws here
 *     init_loader();
 *     init_esm();
 *     init_logger();
 *     var import_reflect_metadata = __toESM(require_Reflect(), 1);   // source import #1, emitted LAST
 *
 * `init_config_setup()` pulls in `packages/domain/src/configuration/index.ts` →
 * `schemas/index.ts` → `schemas/backend.ts` → `backend-detection.ts` → tsyringe, whose module body
 * ends in a `typeof Reflect === "undefined" || !Reflect.getMetadata` guard. That guard throws
 * before `require_Reflect()` is ever reached, so the bundle dies at startup with "tsyringe requires
 * a reflect polyfill".
 *
 * Routing the import through a separate module fixes the order because a module's own
 * initialization is a STATEMENT in the importer's block, and statements keep source order. The
 * bundler emits this file's body immediately before `src/cli.ts`'s first `init_*()` call, so the
 * polyfill is installed before anything can look for it. That holds whether or not this module ends
 * up wrapped in `__esm`: unwrapped it is inlined ahead of the block, wrapped it becomes the block's
 * first `init_*()` call. Both are ahead of `init_config_setup()`.
 *
 * Keep this module dependency-free and side-effect-only. Anything else imported here would be
 * pulled into the same eager position, ahead of the config setup that is deliberately first.
 *
 * Prior art, both of which route AROUND this defect rather than fixing it, and neither of which
 * covers a bare `bun dist/minsky.js`: `Dockerfile`'s CMD and the cold-start smokes pass
 * `--preload reflect-metadata` (mt#3561); `scripts/cli-entry.ts` statically imports the polyfill
 * before `await import(bundlePath)` (mt#3735).
 */

import "reflect-metadata";
