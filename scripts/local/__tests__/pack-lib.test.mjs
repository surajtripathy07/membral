import assert from "node:assert/strict";
import { test } from "node:test";
import { buildServerPackageJson, detectLibc, isNativeFile, stripInstallScripts } from "../pack-lib.mjs";

const cliPkg = { version: "1.2.3", engines: { node: ">=22.5.0" } };

test("package.json shape: name, cli version, bundled deps, engines", () => {
  const pj = buildServerPackageJson({ cliPkg, deps: { a: "1.0.0", "@s/b": "2.0.0" }, native: [], platform: "darwin", arch: "arm64" });
  assert.equal(pj.name, "@membral/server");
  assert.equal(pj.version, "1.2.3");
  assert.deepEqual(pj.bundleDependencies, ["a", "@s/b"]);
  assert.deepEqual(pj.engines, { node: ">=22.5.0" });
  assert.equal(pj.os, undefined);
});

test("native files pin os and cpu; linux also pins libc", () => {
  const base = { cliPkg, deps: {}, native: ["x.node"], arch: "x64" };
  const mac = buildServerPackageJson({ ...base, platform: "darwin" });
  assert.deepEqual([mac.os, mac.cpu, mac.libc], [["darwin"], ["x64"], undefined]);
  const musl = buildServerPackageJson({ ...base, platform: "linux", libc: "musl" });
  assert.deepEqual([musl.os, musl.cpu, musl.libc], [["linux"], ["x64"], ["musl"]]);
});

test("detectLibc reads glibcVersionRuntime on linux only", () => {
  assert.equal(detectLibc("linux", { header: { glibcVersionRuntime: "2.39" } }), "glibc");
  assert.equal(detectLibc("linux", { header: {} }), "musl");
  assert.equal(detectLibc("linux", undefined), undefined);
  assert.equal(detectLibc("linux", {}), undefined);
  assert.equal(detectLibc("darwin", { header: { glibcVersionRuntime: "2.39" } }), undefined);
});

test("stripInstallScripts removes lifecycle scripts and keeps the rest", () => {
  const pj = { scripts: { install: "node x", postinstall: "y", test: "z" } };
  assert.deepEqual(stripInstallScripts(pj), ["install", "postinstall"]);
  assert.deepEqual(pj.scripts, { test: "z" });
  assert.deepEqual(stripInstallScripts({}), []);
});

test("isNativeFile matches .node, .dylib and versioned .so only", () => {
  for (const f of ["a/b.node", "libvips.dylib", "libvips.so", "libvips.so.42", "libvips.so.42.1"]) assert.ok(isNativeFile(f), f);
  for (const f of ["a.js", "a.node.js", "libso", "a.sox"]) assert.ok(!isNativeFile(f), f);
});
