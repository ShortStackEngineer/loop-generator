import { beforeEach, expect, it, vi } from "vitest";
import { lstatSync, readdirSync, readFileSync, type Stats } from "node:fs";
import {
  captureCheckValidationInputs,
  readBoundedFile,
  verifyCheckValidationInputs,
  DEFAULT_INVENTORY_LIMITS,
  type CheckValidationInventory,
} from "../src/check-validation/inventory";
import { parseChecksManifest } from "../src/check-validation/manifest";

vi.mock("node:fs", async (original) => {
  const fs = await original<typeof import("node:fs")>();
  return {
    ...fs,
    lstatSync: vi.fn(fs.lstatSync),
    readdirSync: vi.fn(fs.readdirSync),
    readFileSync: vi.fn(fs.readFileSync),
  };
});

const stat = (kind: string, size = 4): Stats =>
  Object.assign(
    Object.fromEntries(
      ["File", "Directory", "SymbolicLink", "FIFO", "Socket", "BlockDevice", "CharacterDevice"].map((name) => [
        `is${name}`,
        () => kind === name,
      ]),
    ),
    { size },
  ) as unknown as Stats;

const manifest = parseChecksManifest({
  version: 1,
  name: "n",
  goal: "g",
  claims: [{ id: "claim", description: "d", checks: ["c"] }],
  checks: [{ id: "c", command: "true", timeoutMs: 1000, rejectExitCodes: [1] }],
  control: { dir: "good" },
  counterexamples: [{ id: "fault", claim: "claim", dir: "bad" }],
});

beforeEach(() => {
  vi.mocked(lstatSync).mockReset();
  vi.mocked(readdirSync).mockReset();
  vi.mocked(readFileSync).mockReset();
});

it.each([
  ["FIFO", "fifo"],
  ["Socket", "socket"],
  ["BlockDevice", "block device"],
  ["CharacterDevice", "character device"],
  ["Unknown", "special file"],
])("readBoundedFile rejects a %s", (kind, label) => {
  vi.mocked(lstatSync).mockReturnValue(stat(kind));
  expect(readBoundedFile("/x")).toEqual({ ok: false, reason: `${label} not allowed: "/x"` });
});

it("readBoundedFile reports a non-ENOENT lstat failure", () => {
  vi.mocked(lstatSync).mockImplementation(() => {
    throw Object.assign(new Error("denied"), { code: "EACCES" });
  });
  expect(readBoundedFile("/x")).toEqual({ ok: false, reason: 'cannot access "/x": denied' });
});

it("readBoundedFile reports a read failure after a successful lstat", () => {
  vi.mocked(lstatSync).mockReturnValue(stat("File", 4));
  vi.mocked(readFileSync).mockImplementation(() => {
    throw new Error("disk");
  });
  expect(readBoundedFile("/x")).toEqual({ ok: false, reason: 'cannot read "/x": disk' });
});

it("enforces real byte length when a file grows between lstat and read", () => {
  vi.mocked(lstatSync).mockReturnValue(stat("File", 2));
  vi.mocked(readFileSync).mockReturnValue(Buffer.alloc(20));
  expect(readBoundedFile("/x", { ...DEFAULT_INVENTORY_LIMITS, maxFileBytes: 8 })).toEqual({
    ok: false,
    reason: 'file exceeds 8 byte limit: "/x"',
  });
  expect(readBoundedFile("/x", { ...DEFAULT_INVENTORY_LIMITS, maxBytes: 8 }, 0)).toEqual({
    ok: false,
    reason: 'input inventory exceeds 8 byte limit at "/x"',
  });
});

it.each([
  ["FIFO", "fifo"],
  ["Socket", "socket"],
  ["BlockDevice", "block device"],
  ["CharacterDevice", "character device"],
  ["Unknown", "special file"],
])("capture rejects a nested %s", (kind, label) => {
  vi.mocked(lstatSync).mockImplementation((p) => {
    const s = String(p);
    if (s.endsWith("checks.json")) return stat("File", 4);
    if (s.endsWith("good") || s.endsWith("bad")) return stat("Directory");
    return stat(kind);
  });
  vi.mocked(readFileSync).mockReturnValue(Buffer.from("data"));
  vi.mocked(readdirSync).mockReturnValue(["special"] as never);
  const captured = captureCheckValidationInputs("/tmp/checks.json", manifest, "/tmp");
  expect(captured.ok).toBe(false);
  if (!captured.ok) expect(captured.reason).toMatch(`${label} not allowed`);
});

it("capture reports a non-missing fixture-root access error", () => {
  vi.mocked(lstatSync).mockImplementation((p) => {
    const s = String(p);
    if (s.endsWith("checks.json")) return stat("File", 4);
    throw Object.assign(new Error("denied"), { code: "EACCES" });
  });
  vi.mocked(readFileSync).mockReturnValue(Buffer.from("data"));
  const captured = captureCheckValidationInputs("/tmp/checks.json", manifest, "/tmp");
  expect(captured.ok).toBe(false);
  if (!captured.ok) expect(captured.reason).toMatch(/cannot access/);
});

it("capture reports a vanished nested entry and an unreadable directory", () => {
  vi.mocked(lstatSync).mockImplementation((p) => {
    const s = String(p);
    if (s.endsWith("lost")) throw Object.assign(new Error("vanished"), { code: "ENOENT" });
    if (s.endsWith("checks.json")) return stat("File", 4);
    return stat("Directory");
  });
  vi.mocked(readFileSync).mockReturnValue(Buffer.from("data"));
  vi.mocked(readdirSync).mockReturnValue(["lost"] as never);
  const missing = captureCheckValidationInputs("/tmp/checks.json", manifest, "/tmp");
  expect(missing.ok).toBe(false);
  if (!missing.ok) expect(missing.reason).toMatch(/missing /);

  vi.mocked(lstatSync).mockImplementation((p) => {
    const s = String(p);
    if (s.endsWith("checks.json")) return stat("File", 4);
    return stat("Directory");
  });
  vi.mocked(readdirSync).mockImplementation(() => {
    throw new Error("unreadable");
  });
  const unread = captureCheckValidationInputs("/tmp/checks.json", manifest, "/tmp");
  expect(unread.ok).toBe(false);
  if (!unread.ok) expect(unread.reason).toMatch(/cannot read directory/);
});

it("capture fails when the entry cap is hit on a directory and on a file", () => {
  vi.mocked(lstatSync).mockImplementation((p) => {
    const s = String(p);
    if (s.endsWith("checks.json") || s.endsWith("a.txt")) return stat("File", 4);
    return stat("Directory");
  });
  vi.mocked(readFileSync).mockReturnValue(Buffer.from("data"));
  vi.mocked(readdirSync).mockReturnValue(["a.txt"] as never);
  const dirCap = captureCheckValidationInputs("/tmp/checks.json", manifest, "/tmp", {
    ...DEFAULT_INVENTORY_LIMITS,
    maxEntries: 1,
  });
  expect(dirCap.ok).toBe(false);
  if (!dirCap.ok) expect(dirCap.reason).toMatch(/entry limit/);

  const fileCap = captureCheckValidationInputs("/tmp/checks.json", manifest, "/tmp", {
    ...DEFAULT_INVENTORY_LIMITS,
    maxEntries: 2,
  });
  expect(fileCap.ok).toBe(false);
  if (!fileCap.ok) expect(fileCap.reason).toMatch(/entry limit/);
});

function inventory(over: Partial<CheckValidationInventory> = {}): CheckValidationInventory {
  return {
    manifest: "/tmp/checks.json",
    hashes: { "/tmp/checks.json": "abc", "/tmp/good/a.txt": "def" },
    directories: ["/tmp/good"],
    roots: ["/tmp/good", "/tmp/bad"],
    missingRoots: ["/tmp/bad"],
    ...over,
  };
}

it("verify notes a non-missing root access error and an oversized rematerialized manifest", () => {
  vi.mocked(lstatSync).mockImplementation((p) => {
    const s = String(p);
    if (s.endsWith("checks.json")) return stat("File", 4);
    if (s.endsWith("bad")) throw Object.assign(new Error("denied"), { code: "EACCES" });
    if (s.endsWith("good")) return stat("Directory");
    return stat("File", 4);
  });
  vi.mocked(readFileSync).mockReturnValue(Buffer.from("data"));
  vi.mocked(readdirSync).mockReturnValue([] as never);
  const access = verifyCheckValidationInputs(inventory());
  expect(access.ok).toBe(false);
  if (!access.ok) expect(access.reason).toMatch(/cannot access/);

  vi.mocked(lstatSync).mockReturnValue(stat("File", 4));
  vi.mocked(readFileSync).mockReturnValue(Buffer.alloc(50));
  const oversized = verifyCheckValidationInputs(inventory({ roots: [], missingRoots: [], directories: [] }), {
    ...DEFAULT_INVENTORY_LIMITS,
    maxFileBytes: 8,
  });
  expect(oversized.ok).toBe(false);
  if (!oversized.ok) expect(oversized.reason).toMatch(/byte limit|modified/);
});
