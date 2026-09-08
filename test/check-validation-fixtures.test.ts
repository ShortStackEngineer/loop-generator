import { beforeEach, expect, it, vi } from "vitest";
import { lstatSync, readdirSync, type Stats } from "node:fs";
import { cp, mkdtemp, rm } from "node:fs/promises";
import { FixtureError, inspectFixture, withIsolatedFixture } from "../src/check-validation/fixtures";

vi.mock("node:fs", () => ({ lstatSync: vi.fn(), readdirSync: vi.fn() }));
vi.mock("node:fs/promises", () => ({ cp: vi.fn(), mkdtemp: vi.fn(), rm: vi.fn() }));
const stat = (kind: string) => Object.fromEntries([
  "File", "Directory", "SymbolicLink", "FIFO", "Socket", "BlockDevice", "CharacterDevice",
].map(name => [`is${name}`, () => kind === name])) as unknown as Stats;
beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(lstatSync).mockReturnValue(stat("Directory"));
  vi.mocked(readdirSync).mockReturnValue([]);
  vi.mocked(mkdtemp).mockResolvedValue("/scratch/loopgen-checks-unique");
  vi.mocked(cp).mockResolvedValue();
  vi.mocked(rm).mockResolvedValue();
});

it.each([["ENOENT", 'missing fixture directory "/source"'], ["EACCES", 'cannot access fixture directory "/source": denied']])(
  "explains root access error %s", (code, detail) => {
    vi.mocked(lstatSync).mockImplementation(() => { throw Object.assign(new Error("denied"), { code }); });
    expect(inspectFixture("/source", "control")).toBe(`control: ${detail}`);
  },
);
it.each([
  ["File", "file"], ["FIFO", "fifo"], ["Socket", "socket"], ["BlockDevice", "block device"],
  ["CharacterDevice", "character device"], ["Unknown", "special file"],
])("identifies unsafe %s roots and nested entries", (kind, description) => {
  vi.mocked(lstatSync).mockReturnValue(stat(kind));
  expect(inspectFixture("/source", "control")).toBe(`control: fixture path is not a directory (${description}): "/source"`);
  if (kind === "File") return;
  vi.mocked(lstatSync).mockReturnValueOnce(stat("Directory"));
  vi.mocked(readdirSync).mockReturnValue(["unsafe"] as never);
  expect(inspectFixture("/source", "fault")).toBe(`fault: ${description} not allowed: "/source/unsafe"`);
});

it("identifies root and deeply nested symlinks without following them", () => {
  vi.mocked(lstatSync).mockReturnValueOnce(stat("SymbolicLink"));
  expect(inspectFixture("/source", "control")).toBe('control: fixture directory is a symlink: "/source"');
  vi.mocked(lstatSync).mockReturnValueOnce(stat("Directory")).mockReturnValueOnce(stat("Directory")).mockReturnValueOnce(stat("SymbolicLink"));
  vi.mocked(readdirSync).mockReturnValueOnce(["nested"] as never).mockReturnValueOnce(["link"] as never);
  expect(inspectFixture("/source", "fault")).toBe('fault: symlink not allowed: "/source/nested/link"');
});

it("reports traversal errors with the exact failing path", () => {
  vi.mocked(readdirSync).mockImplementationOnce(() => { throw new Error("unreadable"); });
  expect(inspectFixture("/source", "control")).toBe('control: cannot read fixture directory "/source": unreadable');
  vi.mocked(readdirSync).mockReturnValue(["lost"] as never);
  vi.mocked(lstatSync).mockReturnValueOnce(stat("Directory")).mockImplementationOnce(() => { throw new Error("vanished"); });
  expect(inspectFixture("/source", "control")).toBe('control: cannot stat "/source/lost": vanished');
});

it("returns the callback value and removes the entire temporary parent", async () => {
  const fn = vi.fn(async () => "evidence");
  expect(await withIsolatedFixture("/source", "control", fn)).toBe("evidence");
  expect(fn).toHaveBeenCalledWith("/scratch/loopgen-checks-unique/fixture");
  expect(cp).toHaveBeenCalledWith("/source", "/scratch/loopgen-checks-unique/fixture", { recursive: true, dereference: false, filter: expect.any(Function) });
  expect(mkdtemp).toHaveBeenCalledWith(expect.stringMatching(/\/loopgen-checks-$/));
  expect(rm).toHaveBeenCalledWith("/scratch/loopgen-checks-unique", { recursive: true, force: true });
});

it.each(["copy", "callback", "post-copy inspection"])("cleans up after %s failure", async (stage) => {
  const fn = vi.fn(async () => { if (stage === "callback") throw new Error("callback failed"); });
  if (stage === "copy") vi.mocked(cp).mockRejectedValue(new Error("copy failed"));
  if (stage === "post-copy inspection") vi.mocked(lstatSync).mockReturnValueOnce(stat("Directory")).mockReturnValue(stat("SymbolicLink"));
  await expect(withIsolatedFixture("/source", "control", fn)).rejects.toThrow(stage === "post-copy inspection" ? 'control: fixture directory is a symlink: "/scratch/loopgen-checks-unique/fixture"' : `${stage} failed`);
  expect(rm).toHaveBeenCalledWith("/scratch/loopgen-checks-unique", { recursive: true, force: true });
  if (stage !== "callback") expect(fn).not.toHaveBeenCalled();
});

it.each(["SymbolicLink", "FIFO"])("rejects a %s introduced during copying", async (kind) => {
  vi.mocked(cp).mockImplementation(async (_src, _dest, options) => {
    vi.mocked(lstatSync).mockReturnValue(stat(kind));
    await options!.filter!("/source/raced", "/dest/raced");
  });
  const fn = vi.fn();
  await expect(withIsolatedFixture("/source", "control", fn)).rejects.toThrow(new FixtureError(`${kind === "FIFO" ? "fifo" : "symlink"} not allowed: "/source/raced"`));
  expect(fn).not.toHaveBeenCalled();
  expect(rm).toHaveBeenCalled();
});

it("copies both regular files and directories through the filter", async () => {
  vi.mocked(cp).mockImplementation(async (_src, _dest, options) => {
    for (const kind of ["File", "Directory"]) {
      vi.mocked(lstatSync).mockReturnValueOnce(stat(kind));
      expect(await options!.filter!("/source/entry", "/dest/entry")).toBe(true);
    }
  });
  await withIsolatedFixture("/source", "control", async () => undefined);
});
