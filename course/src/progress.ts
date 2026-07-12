/** Tiny localStorage-backed progress store (per-module quiz completion). */

const KEY = "loopgen-course-progress-v1";

export interface Progress {
  /** moduleId -> best quiz score as a fraction 0..1 (1 = completed). */
  quizzes: Record<string, number>;
  /** moduleIds the learner marked as read/visited. */
  visited: string[];
}

function load(): Progress {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) return JSON.parse(raw) as Progress;
  } catch {
    /* ignore */
  }
  return { quizzes: {}, visited: [] };
}

let state = load();
const listeners = new Set<() => void>();

function save() {
  try {
    localStorage.setItem(KEY, JSON.stringify(state));
  } catch {
    /* ignore */
  }
  listeners.forEach((l) => l());
}

export function getProgress(): Progress {
  return state;
}

export function recordQuiz(moduleId: string, score: number) {
  const prev = state.quizzes[moduleId] ?? 0;
  state = { ...state, quizzes: { ...state.quizzes, [moduleId]: Math.max(prev, score) } };
  save();
}

export function recordVisit(moduleId: string) {
  if (state.visited.includes(moduleId)) return;
  state = { ...state, visited: [...state.visited, moduleId] };
  save();
}

export function isModuleDone(moduleId: string): boolean {
  return (state.quizzes[moduleId] ?? 0) >= 0.7;
}

export function resetProgress() {
  state = { quizzes: {}, visited: [] };
  save();
}

export function subscribe(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
