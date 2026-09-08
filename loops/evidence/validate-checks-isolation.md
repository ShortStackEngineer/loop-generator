# Isolated check-validation build

Prepared on `codex/validate-checks` from master `3b944d60556fe46194e21c56e0519a96ae5de0c7`.
The initial implementation and follow-up repair runs succeeded. Reviewed source
was transferred only after fresh offline verification.

## Boundaries

- Disposable Git repository built from master's tracked source plus the explicit
  task contract. No shared Git objects, original working-tree changes, or
  `.octo-continue.md`. The original checkout is not mounted in any container.
- Frozen master supervisor with 35 independently installed locked production
  dependencies; no dependency symlink back to the original checkout.
- Linux toolchain image pinned to `sha256:562073c1173cbb641b93136613dd299f98c60064be56a0083192d7eae8833f5f`.
  Grok 1.0.13; Node 20; dependencies installed from the existing lockfile.
- Agent container: writable disposable source and separate Grok state only;
  read-only root filesystem, dependencies, Git metadata and 107 authoritative
  source/test/config files. No Docker socket, supervisor, audit-report directory,
  or original host checkout mount. All capabilities dropped, no-new-privileges,
  four CPUs, 4 GiB memory and a 256-process cap.
- Grok network access remains enabled for its provider; it is not restricted to
  an xAI-only domain allowlist. Only Grok's provider credential was copied to
  private temporary state after approval and removed after execution; no global plugins or other app state.
- The agent's process tree has an internal 12-minute timeout with forced cleanup.
  The outer loop retains four iterations, 45 agent turns per iteration, a
  15-minute iteration timeout and an $8 driver-reported cost ceiling. This is
  not a strict billing cap.
- Every evaluator exports a fresh source-only snapshot, rejects out-of-scope
  edits/symlinks, overlays authoritative tests/configs and mounts those files
  read-only. It executes with no network, no credentials, protected dependencies,
  bounded resources and a fresh temporary directory. Source hashes must remain
  unchanged across evaluation. Reports/logs live outside the agent container.
- A successful loop triggers a new snapshot build, acceptance, regression and
  typecheck. Transfer to the original checkout was a separate reviewed step.

## Verified before launch

- Container isolation probe: all 13 assertions passed, including child-process
  write denial and absence of the original checkout/Docker socket.
- Offline regression: 44 files, 1,005 tests passed.
- Offline typecheck and build passed.
- All 16 new acceptance tests fail because master lacks the new CLI command.
- Isolated spec lint: zero errors/warnings. One informational artifact warning
  is a limitation of static lint seeing a wrapper command; that evaluator
  explicitly checks the documentation and example manifests in the snapshot.

Harness adjustments: Vitest needs temporary fixture execution in `/tmp`, a
worker cap matching the container budget, and `--no-cache` because dependencies
are immutable. The checked-in tests and assertions were not weakened.

## Local run material

- Prepared environment: `/private/tmp/loopgen-isolated-t6r9w3bs` (disposable; may be cleared by OS cleanup).
- Durable local copy of scripts, spec, hashes and baseline summaries:
  `.loopgen/validate-checks/isolation-bundle/` (gitignored; no credentials).
- Original root pointer: `.loopgen/validate-checks/isolation-path.txt`.
- Launcher: `trusted/launch.py` inside the prepared environment. It requires
  explicit code-transfer approval and validates frozen control hashes first.

Automatic approval review previously rejected the unisolated Grok launch for
possible private-code disclosure. The user explicitly approved the isolated source transfer to xAI before launch.
Both the initial implementation and review repairs use that isolated workflow.
