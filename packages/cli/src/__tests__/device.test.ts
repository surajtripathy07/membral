// loadOrCreateDeviceIdentity (device.ts) — ~/.membral/device.json create/load
// for this machine's device identity, used by the login/setup device-auth
// flow. Uses a real temp dir (via the `path` override) rather than mocking
// fs, since this module's whole job is file I/O.
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadOrCreateDeviceIdentity, peekDeviceName } from "../device.js";

let dir: string;
let path: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "membral-device-"));
  path = join(dir, "nested", "device.json"); // also exercises mkdirSync(recursive) for a missing parent dir
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("loadOrCreateDeviceIdentity", () => {
  it("creates a new identity (with a random id) and writes it when no file exists", () => {
    const identity = loadOrCreateDeviceIdentity({ path });

    expect(identity.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(identity.name).toBeTruthy();
    expect(identity.platform).toBe(process.platform);
  });

  it("persists the created identity to disk", async () => {
    const identity = loadOrCreateDeviceIdentity({ path });
    const onDisk = JSON.parse(await readFile(path, "utf8"));
    expect(onDisk).toEqual(identity);
  });

  it("uses --device-name for a brand new identity", () => {
    const identity = loadOrCreateDeviceIdentity({ path, deviceName: "My Laptop" });
    expect(identity.name).toBe("My Laptop");
  });

  it("reloads the SAME id/name/platform on a second call with no override", () => {
    const first = loadOrCreateDeviceIdentity({ path });
    const second = loadOrCreateDeviceIdentity({ path });
    expect(second).toEqual(first);
  });

  it("overrides and persists a new name when deviceName is given on a later load, keeping id/platform stable", () => {
    const first = loadOrCreateDeviceIdentity({ path });
    const second = loadOrCreateDeviceIdentity({ path, deviceName: "Renamed" });

    expect(second.id).toBe(first.id);
    expect(second.platform).toBe(first.platform);
    expect(second.name).toBe("Renamed");

    const third = loadOrCreateDeviceIdentity({ path });
    expect(third.name).toBe("Renamed"); // the override was persisted, not just returned once
  });

  it("treats a corrupt device.json as absent and writes a fresh identity", async () => {
    const { mkdir, writeFile } = await import("node:fs/promises");
    await mkdir(join(dir, "nested"), { recursive: true });
    await writeFile(path, "not valid json {", "utf8");

    const identity = loadOrCreateDeviceIdentity({ path });
    expect(identity.id).toMatch(/^[0-9a-f-]{36}$/);

    const onDisk = JSON.parse(await readFile(path, "utf8"));
    expect(onDisk).toEqual(identity);
  });

  it("trims a blank --device-name override, falling back to the existing/default name instead", () => {
    loadOrCreateDeviceIdentity({ path, deviceName: "Real Name" });
    const second = loadOrCreateDeviceIdentity({ path, deviceName: "   " });
    expect(second.name).toBe("Real Name");
  });
});

// Issue #137: setup's machine-name prompt needs to show the RIGHT default
// (existing device.json name on a re-run/rename, hostname on a first run)
// without creating device.json before the user answers.
describe("peekDeviceName", () => {
  it("returns undefined without creating device.json when no file exists yet", () => {
    expect(peekDeviceName(path)).toBeUndefined();
  });

  it("returns the existing name when device.json already has one", () => {
    loadOrCreateDeviceIdentity({ path, deviceName: "login-e2e" });
    expect(peekDeviceName(path)).toBe("login-e2e");
  });

  it("returns undefined for a corrupt device.json (same as absent)", async () => {
    const { mkdir, writeFile } = await import("node:fs/promises");
    await mkdir(join(dir, "nested"), { recursive: true });
    await writeFile(path, "not valid json {", "utf8");
    expect(peekDeviceName(path)).toBeUndefined();
  });

  it("reflects a rename immediately (persisted by loadOrCreateDeviceIdentity's --device-name override)", () => {
    loadOrCreateDeviceIdentity({ path, deviceName: "old-name" });
    expect(peekDeviceName(path)).toBe("old-name");

    loadOrCreateDeviceIdentity({ path, deviceName: "new-name" });
    expect(peekDeviceName(path)).toBe("new-name");
  });
});
