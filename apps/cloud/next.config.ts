import path from "node:path";
import { fileURLToPath } from "node:url";
import type { NextConfig } from "next";

// MEMBRAL_STANDALONE=1 is set only by apps/cloud/Dockerfile (W7 7.1). The
// hosted (Vercel) build never sets it, so its output is unchanged. Standalone in
// a monorepo traces files from the repo root so @membral/core and the hoisted
// node_modules land in the bundle.
const standalone = process.env.MEMBRAL_STANDALONE === "1";

const nextConfig: NextConfig = {
  transpilePackages: ["@membral/core"],
  serverExternalPackages: [],
  experimental: {
    serverActions: {
      bodySizeLimit: "50mb",
    },
  },
  ...(standalone
    ? {
        output: "standalone" as const,
        outputFileTracingRoot: path.join(path.dirname(fileURLToPath(import.meta.url)), "../.."),
      }
    : {}),
};

export default nextConfig;
