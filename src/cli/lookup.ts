import path from "node:path";
import type { Command } from "commander";
import { formatPathLookup, lookupRunByPath, PathIndexReadError, type PathLookup } from "../core/path-index";

interface LookupFlags {
  workspace?: string;
  json?: boolean;
}

export function registerLookup(program: Command): void {
  program
    .command("lookup <path>")
    .description(
      "Look up which run wrote a workspace-relative path, from .loopgen/path-index.json. Does not start an agent.",
    )
    .option("-w, --workspace <dir>", "workspace that holds .loopgen/path-index.json (default: cwd)")
    .option("--json", "print the lookup as JSON")
    .action((relPath: string, flags: LookupFlags) => {
      const workdir = path.resolve(flags.workspace ?? process.cwd());
      let found: PathLookup | null;
      try {
        found = lookupRunByPath(workdir, relPath);
      } catch (err) {
        if (err instanceof PathIndexReadError) {
          console.error(err.message);
          process.exit(2);
        }
        throw err;
      }
      if (flags.json) console.log(JSON.stringify(found, null, 2));
      else console.log(formatPathLookup(found, relPath));
      if (!found) process.exit(1);
    });
}
