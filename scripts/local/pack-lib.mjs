// Pure parts of build-server.mjs --pack, kept apart so scripts/local/__tests__ can run them without a build.

export const INSTALL_SCRIPTS = ["preinstall", "install", "postinstall", "prepare"];

/** Platform-native files decide whether os/cpu (and libc) are pinned. */
export function isNativeFile(path) {
  return /\.(node|dylib)$|\.so(\.\d+)*$/.test(path);
}

/** "glibc" or "musl" on Linux, undefined elsewhere or when the report header is unavailable (no pin). `report` is process.report.getReport(). */
export function detectLibc(platform, report) {
  if (platform !== "linux") return undefined;
  const header = report?.header;
  if (!header) return undefined;
  return header.glibcVersionRuntime ? "glibc" : "musl";
}

/** Drop install lifecycle scripts from a parsed package.json; returns the removed names (the object is mutated). */
export function stripInstallScripts(pj) {
  const hit = INSTALL_SCRIPTS.filter((k) => pj.scripts?.[k]);
  for (const k of hit) delete pj.scripts[k];
  return hit;
}

/** The package.json written into the packed server. `native` is the list of native files found in the output. */
export function buildServerPackageJson({ cliPkg, deps, native, platform, arch, libc }) {
  return {
    name: "@membral/server",
    version: cliPkg.version,
    description: "The standalone Membral server that `membral up` runs without Docker (embedded store).",
    license: "MIT",
    private: true,
    engines: { node: cliPkg.engines?.node ?? ">=22.5.0" },
    ...(native.length ? { os: [platform], cpu: [arch], ...(libc ? { libc: [libc] } : {}) } : {}),
    dependencies: deps,
    bundleDependencies: Object.keys(deps),
  };
}
