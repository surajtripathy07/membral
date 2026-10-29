import path from "node:path";
import { fileURLToPath } from "node:url";
import type { NextConfig } from "next";

// MEMBRAL_STANDALONE=1 is set only by apps/cloud/Dockerfile (W7 7.1). The
// hosted (Vercel) build never sets it, so its output is unchanged. Standalone in
// a monorepo traces files from the repo root so @membral/core and the hoisted
// node_modules land in the bundle.
const standalone = process.env.MEMBRAL_STANDALONE === "1";

// The bundled ONNX embedder (local stack only) and its native binaries (onnxruntime-node, onnxruntime-web, sharp's
// @img packages, ~400 MB) must not ride along in hosted function bundles: Next's file tracing follows the literal
// dynamic import in lib/llm/bundled-embedder.ts. Only the standalone (Docker/local) build keeps them.
const BUNDLED_EMBEDDER_PACKAGES = [
  "../../node_modules/@huggingface/**",
  "../../node_modules/onnxruntime-node/**",
  "../../node_modules/onnxruntime-web/**",
  "../../node_modules/onnxruntime-common/**",
  "../../node_modules/sharp/**",
  "../../node_modules/@img/**",
  "node_modules/@huggingface/**",
  "node_modules/onnxruntime-*/**",
  "node_modules/sharp/**",
  "node_modules/@img/**",
];

// Standalone only: Next's trace follows the literal import of @huggingface/transformers but not the dynamic require of
// onnxruntime-node inside it, so the native package never reached the runtime image. Name it (JS, package.json and the
// linux binaries; darwin/win32 would add ~220 MB) so the trace copies it into .next/standalone.
const STANDALONE_EMBEDDER_INCLUDES = [
  "../../node_modules/onnxruntime-node/package.json",
  "../../node_modules/onnxruntime-node/dist/**",
  "../../node_modules/onnxruntime-node/lib/**",
  "../../node_modules/onnxruntime-node/bin/napi-v6/linux/**",
  "../../node_modules/onnxruntime-common/**",
];

// Hosted build: instrumentation.ts reaches the embedded store through a local-mode-only dynamic import, and Next's trace
// follows it into instrumentation.js.nft.json (19 files, the pglite wasm and extension tarballs). Hosted never opens one.
const PGLITE_PACKAGES = [
  "../../node_modules/@electric-sql/pglite/**",
  "../../node_modules/@electric-sql/pglite-pgvector/**",
  "node_modules/@electric-sql/pglite/**",
  "node_modules/@electric-sql/pglite-pgvector/**",
];

// Standalone only: PGlite (the embedded store) reads its wasm, data bundle and extension tarballs by relative file URL at
// runtime, which Next's static trace cannot see. Name the packages so the whole dist ships with the standalone output.
const STANDALONE_PGLITE_INCLUDES = [
  "../../node_modules/@electric-sql/pglite/package.json",
  "../../node_modules/@electric-sql/pglite/dist/**",
  "../../node_modules/@electric-sql/pglite-pgvector/package.json",
  "../../node_modules/@electric-sql/pglite-pgvector/dist/**",
];

// The embedder includes above name the linux binaries only (the Docker image). A host-native build
// (MEMBRAL_STANDALONE_NATIVE=1, set by scripts/local/build-server.mjs) adds the build machine's own platform.
const STANDALONE_NATIVE_INCLUDES =
  process.env.MEMBRAL_STANDALONE_NATIVE === "1"
    ? [`../../node_modules/onnxruntime-node/bin/napi-v6/${process.platform}/${process.arch}/**`]
    : [];

const nextConfig: NextConfig = {
  transpilePackages: ["@membral/core"],
  // The bundled embedding model (lib/llm/bundled-embedder.ts) loads native onnxruntime-node binaries: keep them external
  // so standalone tracing copies the real packages instead of bundling them.
  serverExternalPackages: ["@huggingface/transformers", "onnxruntime-node", "@electric-sql/pglite", "@electric-sql/pglite-pgvector"],
  experimental: {
    serverActions: {
      bodySizeLimit: "50mb",
    },
  },
  ...(standalone ? {} : { outputFileTracingExcludes: { "*": [...BUNDLED_EMBEDDER_PACKAGES, ...PGLITE_PACKAGES] } }),
  ...(standalone
    ? {
        output: "standalone" as const,
        outputFileTracingIncludes: {
          "*": [...STANDALONE_EMBEDDER_INCLUDES, ...STANDALONE_PGLITE_INCLUDES, ...STANDALONE_NATIVE_INCLUDES],
        },
        outputFileTracingRoot: path.join(path.dirname(fileURLToPath(import.meta.url)), "../.."),
      }
    : {}),
};

export default nextConfig;
