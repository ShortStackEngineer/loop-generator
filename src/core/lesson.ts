import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { declaredEvaluatorPaths, resolveGuardedFiles } from "./evaluator-guard";
import type { LoopReport } from "./engine";
import type { LoopSpec, SpecEvaluator } from "./spec";
import { challengePacketPath } from "./challenge";

/**
 * Sibling of the challenge packet. Lessons append across runs so a later
 * `loopgen lint` can still cite a failure after the packet has been overwritten.
 * The object stored here is the same object written onto that run's packet.
 */
export const LESSONS_RELATIVE = ".loopgen/lessons.json";

export const LESSON_FAILURE_CLASSES = [
  "baseline-vacuous",
  "spec-tampered",
  "evaluator-tampered",
  "vacuous-success",
] as const;

export type LessonFailureClass = (typeof LESSON_FAILURE_CLASSES)[number];

const lessonSubjectSchema = z.object({
  /** `check` for an evaluator, `file` for a spec or guarded test path. */
  kind: z.enum(["check", "file"]),
  /** Evaluator alias, or the path as the lesson recorded it. */
  name: z.string().min(1),
  /**
   * Stable identity a later spec is compared against.
   * Checks: evaluator type plus canonical options. Files: workspace-relative
   * path when the file lives in the workspace, otherwise a normalized absolute path.
   */
  shape: z.string().min(1),
});

const lessonSchema = z.object({
  failureClass: z.enum(LESSON_FAILURE_CLASSES),
  subjects: z.array(lessonSubjectSchema).min(1),
  runId: z.string().min(1),
  /** Short lesson text. Lint reprints this; it does not invent a new one. */
  text: z.string().min(1),
});

const lessonsFileSchema = z.object({
  kind: z.literal("loopgen.lessons"),
  version: z.literal(1),
  lessons: z.array(lessonSchema),
});

export type ChallengeLessonSubject = z.infer<typeof lessonSubjectSchema>;
export type ChallengeLesson = z.infer<typeof lessonSchema>;
export type LessonsFile = z.infer<typeof lessonsFileSchema>;

/** The lessons log could not be written. */
export class LessonWriteError extends Error {
  readonly lessonsPath: string;

  constructor(lessonsPath: string, cause: unknown) {
    const detail = cause instanceof Error ? cause.message : String(cause);
    super(`Could not write lessons "${lessonsPath}": ${detail}`);
    this.name = "LessonWriteError";
    this.lessonsPath = lessonsPath;
  }
}

/** The lessons log is present but unreadable. */
export class LessonReadError extends Error {
  readonly lessonsPath: string;

  constructor(lessonsPath: string, cause: unknown) {
    const detail = cause instanceof Error ? cause.message : String(cause);
    super(`Could not read lessons "${lessonsPath}": ${detail}`);
    this.name = "LessonReadError";
    this.lessonsPath = lessonsPath;
  }
}

/** Absolute path of the lessons log for a resolved workspace. */
export function lessonsPath(workdir: string): string {
  return path.join(workdir, LESSONS_RELATIVE);
}

/**
 * Workspace-relative spec path when `specFile` lives inside `workdir`.
 * Same inclusion rule the spec-integrity guard uses.
 */
export function workspaceSpecRel(workdir: string, specFile: string | undefined): string | undefined {
  if (!specFile) return undefined;
  const rel = path.relative(path.resolve(workdir), path.resolve(specFile));
  if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) return undefined;
  return rel.split(path.sep).join("/");
}

/**
 * Identity of a check for "does a later spec repeat this shape?".
 * The alias (`as`) is not part of it — the same command under another name
 * is the same check. `guard` is not part of it — that is a file shape.
 */
export function evaluatorShape(ev: Pick<SpecEvaluator, "uses" | "options">): string {
  return `${ev.uses}\0${stableJson(ev.options ?? {})}`;
}

/** Workspace-relative path when `raw` is inside `workdir`, else a normalized absolute path. */
export function lessonFileShape(workdir: string, raw: string): string {
  const abs = path.isAbsolute(raw) ? path.resolve(raw) : path.resolve(workdir, raw);
  const rel = path.relative(path.resolve(workdir), abs);
  if (rel && !rel.startsWith("..") && !path.isAbsolute(rel)) {
    const norm = rel.split(path.sep).join("/").replace(/^\.\//, "");
    if (norm && !norm.split("/").includes("..")) return norm;
  }
  return abs;
}

export interface LessonDeriveContext {
  workdir: string;
  /** In-workspace spec path, when the run was given a spec file that lives there. */
  specRel?: string;
  /** Files the evaluator guard or check-validation inventory reported as changed. */
  files?: readonly string[];
}

/**
 * Build the lesson for a finished report, or `undefined` when this outcome
 * is not one of the four that must be remembered. The text is fixed here so
 * a later lint reprints it instead of composing a new warning.
 */
export function deriveChallengeLesson(
  report: LoopReport,
  spec: LoopSpec,
  ctx: LessonDeriveContext,
): ChallengeLesson | undefined {
  if (report.outcome === "baseline-vacuous") {
    const subjects = checkSubjects(spec, report.baseline?.evaluations ?? []);
    return subjects.length ? lesson("baseline-vacuous", subjects, report.runId) : undefined;
  }
  if (report.outcome === "spec-tampered") {
    if (!ctx.specRel) return undefined;
    return lesson(
      "spec-tampered",
      [{ kind: "file", name: ctx.specRel, shape: ctx.specRel }],
      report.runId,
    );
  }
  if (report.outcome === "evaluator-tampered") {
    const subjects = fileSubjects(ctx.workdir, ctx.files ?? []);
    return subjects.length ? lesson("evaluator-tampered", subjects, report.runId) : undefined;
  }
  if (report.outcome === "success") {
    const vacuous = [...report.iterations].reverse().find((it) => it.satisfied && it.changed === false);
    if (!vacuous) return undefined;
    const subjects = checkSubjects(spec, vacuous.evaluations);
    return subjects.length ? lesson("vacuous-success", subjects, report.runId) : undefined;
  }
  return undefined;
}

function lesson(
  failureClass: LessonFailureClass,
  subjects: ChallengeLessonSubject[],
  runId: string,
): ChallengeLesson {
  return {
    failureClass,
    subjects,
    runId,
    text: lessonText(failureClass, subjects),
  };
}

function lessonText(failureClass: LessonFailureClass, subjects: readonly ChallengeLessonSubject[]): string {
  const names = subjects.map((s) => s.name).join(", ");
  switch (failureClass) {
    case "baseline-vacuous":
      return `Checks already passed before any agent work: ${names}.`;
    case "spec-tampered":
      return `Spec file was modified during the run: ${names}.`;
    case "evaluator-tampered":
      return `Evaluator file was modified during the run: ${names}.`;
    case "vacuous-success":
      return `Checks passed and no files changed: ${names}.`;
  }
}

function checkSubjects(
  spec: LoopSpec,
  evaluations: readonly { name: string; passed: boolean }[],
): ChallengeLessonSubject[] {
  const passed = evaluations.filter((ev) => ev.passed);
  const source = passed.length > 0 ? passed : evaluations;
  const out: ChallengeLessonSubject[] = [];
  const seen = new Set<string>();
  for (const ev of source) {
    const specEv = spec.evaluators.find((e) => (e.as ?? e.uses) === ev.name);
    const shape = specEv ? evaluatorShape(specEv) : `name:${ev.name}`;
    if (seen.has(shape)) continue;
    seen.add(shape);
    out.push({ kind: "check", name: ev.name, shape });
  }
  return out;
}

function fileSubjects(workdir: string, files: readonly string[]): ChallengeLessonSubject[] {
  const out: ChallengeLessonSubject[] = [];
  const seen = new Set<string>();
  for (const raw of files) {
    const shape = lessonFileShape(workdir, raw);
    if (!shape || seen.has(shape)) continue;
    seen.add(shape);
    out.push({ kind: "file", name: shape, shape });
  }
  return out;
}

function lessonIdentity(lesson: ChallengeLesson): string {
  const shapes = lesson.subjects.map((s) => `${s.kind}:${s.shape}`).join("\0");
  return `${lesson.runId}\0${lesson.failureClass}\0${shapes}`;
}

function parseLessons(file: string, raw: string): LessonsFile {
  let json: unknown;
  try {
    json = JSON.parse(raw) as unknown;
  } catch (err) {
    throw new LessonReadError(file, err);
  }
  const parsed = lessonsFileSchema.safeParse(json);
  if (!parsed.success) throw new LessonReadError(file, parsed.error.message);
  return parsed.data;
}

function loadExisting(file: string): ChallengeLesson[] {
  if (!existsSync(file)) return [];
  try {
    return parseLessons(file, readFileSync(file, "utf8")).lessons;
  } catch (err) {
    throw new LessonWriteError(file, err);
  }
}

/**
 * Append `lesson` to the workspace lessons log. The same run id and shape are
 * not repeated. Returns the absolute path. Throws {@link LessonWriteError}
 * when the file cannot be written or the existing log cannot be parsed.
 */
export function recordLesson(workdir: string, lesson: ChallengeLesson): string {
  const file = lessonsPath(workdir);
  const tmp = `${file}.${process.pid}.tmp`;
  try {
    const checked = lessonSchema.safeParse(lesson);
    if (!checked.success) throw new LessonWriteError(file, checked.error.message);
    const existing = loadExisting(file);
    const seen = new Set(existing.map(lessonIdentity));
    const lessons = [...existing];
    const key = lessonIdentity(checked.data);
    if (!seen.has(key)) lessons.push(checked.data);
    const body: LessonsFile = { kind: "loopgen.lessons", version: 1, lessons };
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(tmp, `${JSON.stringify(body, null, 2)}\n`);
    renameSync(tmp, file);
  } catch (err) {
    try {
      unlinkSync(tmp);
    } catch {
      /* the temp file may not exist; the original error is the one that matters */
    }
    if (err instanceof LessonWriteError) throw err;
    throw new LessonWriteError(file, err);
  }
  return file;
}

/** Read the lessons log, or null when this workspace has never recorded one. */
export function readLessons(workdir: string): LessonsFile | null {
  const file = lessonsPath(workdir);
  if (!existsSync(file)) return null;
  let raw: string;
  try {
    raw = readFileSync(file, "utf8");
  } catch (err) {
    throw new LessonReadError(file, err);
  }
  return parseLessons(file, raw);
}

function readPacketLesson(workdir: string): ChallengeLesson | undefined {
  const file = challengePacketPath(workdir);
  if (!existsSync(file)) return undefined;
  let json: unknown;
  try {
    json = JSON.parse(readFileSync(file, "utf8")) as unknown;
  } catch {
    return undefined;
  }
  if (!json || typeof json !== "object" || !("lesson" in json)) return undefined;
  const parsed = lessonSchema.safeParse((json as { lesson: unknown }).lesson);
  return parsed.success ? parsed.data : undefined;
}

/**
 * Lessons a later spec can see: the append-only log, plus the current
 * packet's lesson when the log does not already contain it. The packet is
 * the artifact the run just wrote; the log keeps it after that packet is
 * overwritten. Throws {@link LessonReadError} when the log is unreadable.
 */
export function loadWorkspaceLessons(workdir: string): ChallengeLesson[] {
  const logged = readLessons(workdir);
  const lessons = logged ? [...logged.lessons] : [];
  const fromPacket = readPacketLesson(workdir);
  if (fromPacket && !lessons.some((existing) => lessonIdentity(existing) === lessonIdentity(fromPacket))) {
    lessons.push(fromPacket);
  }
  return lessons;
}

/**
 * Lessons whose shape this spec repeats. Each stored lesson is returned as
 * recorded — text and run id are not rewritten.
 */
export function matchPriorLessons(
  spec: LoopSpec,
  workdir: string,
  file: string | undefined,
  lessons: readonly ChallengeLesson[],
): ChallengeLesson[] {
  return lessons.filter((lesson) => repeatsShape(spec, workdir, file, lesson));
}

function repeatsShape(
  spec: LoopSpec,
  workdir: string,
  file: string | undefined,
  lesson: ChallengeLesson,
): boolean {
  if (lesson.failureClass === "baseline-vacuous" || lesson.failureClass === "vacuous-success") {
    const shapes = new Set(spec.evaluators.map((ev) => evaluatorShape(ev)));
    const needed = lesson.subjects.filter((s) => s.kind === "check").map((s) => s.shape);
    return needed.length > 0 && needed.every((shape) => shapes.has(shape));
  }
  if (lesson.failureClass === "spec-tampered") {
    const rel = workspaceSpecRel(workdir, file);
    if (!rel) return false;
    return lesson.subjects.some((s) => s.kind === "file" && s.shape === rel);
  }
  if (lesson.failureClass === "evaluator-tampered") {
    const involved = involvedFileShapes(spec, workdir, file);
    return lesson.subjects.some((s) => s.kind === "file" && fileRepeats(involved, s.shape));
  }
  return false;
}

function involvedFileShapes(spec: LoopSpec, workdir: string, specFile: string | undefined): Set<string> {
  const out = new Set<string>();
  const add = (raw: string): void => {
    const shape = lessonFileShape(workdir, raw);
    if (shape) out.add(shape);
  };
  for (const rel of declaredEvaluatorPaths(spec)) add(rel);
  for (const rel of resolveGuardedFiles(spec, workdir)) add(rel);
  if (spec.checkValidation?.manifest) {
    const bases = new Set<string>([path.resolve(workdir)]);
    if (specFile) bases.add(path.dirname(path.resolve(specFile)));
    for (const base of bases) add(path.resolve(base, spec.checkValidation.manifest));
  }
  return out;
}

function fileRepeats(involved: ReadonlySet<string>, lessonShape: string): boolean {
  for (const candidate of involved) {
    if (candidate === lessonShape) return true;
    if (lessonShape.startsWith(`${candidate}/`)) return true;
    if (candidate.startsWith(`${lessonShape}/`)) return true;
  }
  return false;
}

function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map((item) => stableJson(item)).join(",")}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj)
    .filter((key) => obj[key] !== undefined)
    .sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${stableJson(obj[key])}`).join(",")}}`;
}
