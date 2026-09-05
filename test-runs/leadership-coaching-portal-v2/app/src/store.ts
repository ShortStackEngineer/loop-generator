import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import path from "node:path";

export type Role = "coach" | "client";

export interface UserRecord {
  id: string;
  email: string;
  emailNormalized: string;
  name: string;
  role: Role;
  passwordHash: string;
  createdAt: string;
  /** Set when role is "client" — binds login to a coaching client record. */
  clientId?: string;
}

export function dataDir(): string {
  return process.env.LCP_DATA_DIR ?? "./data";
}

function ensureDir(dir: string): void {
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
}

function usersPath(): string {
  return path.join(dataDir(), "users.json");
}

export function loadUsers(): UserRecord[] {
  const file = usersPath();
  ensureDir(dataDir());
  if (!existsSync(file)) {
    return [];
  }
  const raw = readFileSync(file, "utf8");
  if (!raw.trim()) return [];
  return JSON.parse(raw) as UserRecord[];
}

export function saveUsers(users: UserRecord[]): void {
  ensureDir(dataDir());
  writeFileSync(usersPath(), JSON.stringify(users, null, 2), "utf8");
}

export function findUserByEmail(email: string): UserRecord | undefined {
  const normalized = email.trim().toLowerCase();
  return loadUsers().find((u) => u.emailNormalized === normalized);
}

export function findUserById(id: string): UserRecord | undefined {
  return loadUsers().find((u) => u.id === id);
}

export function insertUser(user: UserRecord): void {
  const users = loadUsers();
  users.push(user);
  saveUsers(users);
}

export function toPublicUser(user: UserRecord) {
  return {
    id: user.id,
    email: user.email,
    name: user.name,
    role: user.role,
  };
}

// --- Coaching clients (roster owned by a coach) ---

export interface ClientRecord {
  id: string;
  coachId: string;
  name: string;
  email: string;
  createdAt: string;
}

function clientsPath(): string {
  return path.join(dataDir(), "clients.json");
}

export function loadClients(): ClientRecord[] {
  const file = clientsPath();
  ensureDir(dataDir());
  if (!existsSync(file)) {
    return [];
  }
  const raw = readFileSync(file, "utf8");
  if (!raw.trim()) return [];
  return JSON.parse(raw) as ClientRecord[];
}

export function saveClients(clients: ClientRecord[]): void {
  ensureDir(dataDir());
  writeFileSync(clientsPath(), JSON.stringify(clients, null, 2), "utf8");
}

export function findClientById(id: string): ClientRecord | undefined {
  return loadClients().find((c) => c.id === id);
}

export function listClientsByCoach(coachId: string): ClientRecord[] {
  return loadClients().filter((c) => c.coachId === coachId);
}

export function insertClient(client: ClientRecord): void {
  const clients = loadClients();
  clients.push(client);
  saveClients(clients);
}

export function toPublicClient(client: ClientRecord) {
  return {
    id: client.id,
    name: client.name,
    email: client.email,
  };
}

// --- Proprietary 360 survey results (one per client, coach-owned) ---

export interface Survey360Dimension {
  name: string;
  score: number;
  notes: string;
}

export interface Survey360Record {
  clientId: string;
  coachId: string;
  summary: string;
  dimensions: Survey360Dimension[];
  completedAt: string;
  updatedAt: string;
}

function survey360Path(): string {
  return path.join(dataDir(), "survey-360.json");
}

export function loadSurvey360(): Survey360Record[] {
  const file = survey360Path();
  ensureDir(dataDir());
  if (!existsSync(file)) {
    return [];
  }
  const raw = readFileSync(file, "utf8");
  if (!raw.trim()) return [];
  return JSON.parse(raw) as Survey360Record[];
}

export function saveSurvey360(records: Survey360Record[]): void {
  ensureDir(dataDir());
  writeFileSync(survey360Path(), JSON.stringify(records, null, 2), "utf8");
}

export function findSurvey360ByClientId(
  clientId: string,
): Survey360Record | undefined {
  return loadSurvey360().find((r) => r.clientId === clientId);
}

/** Upsert 360 results for a client. */
export function upsertSurvey360(record: Survey360Record): Survey360Record {
  const records = loadSurvey360();
  const idx = records.findIndex((r) => r.clientId === record.clientId);
  if (idx >= 0) {
    records[idx] = record;
  } else {
    records.push(record);
  }
  saveSurvey360(records);
  return record;
}

export function toPublicSurvey360(record: Survey360Record) {
  return {
    summary: record.summary,
    dimensions: record.dimensions,
    completedAt: record.completedAt,
  };
}

// --- Focus areas (ordered list per client, coach-owned, outcome-only) ---

export interface FocusAreaItem {
  title: string;
  priority: number;
}

export interface FocusAreasRecord {
  clientId: string;
  coachId: string;
  areas: FocusAreaItem[];
  updatedAt: string;
}

function focusAreasPath(): string {
  return path.join(dataDir(), "focus-areas.json");
}

export function loadFocusAreas(): FocusAreasRecord[] {
  const file = focusAreasPath();
  ensureDir(dataDir());
  if (!existsSync(file)) {
    return [];
  }
  const raw = readFileSync(file, "utf8");
  if (!raw.trim()) return [];
  return JSON.parse(raw) as FocusAreasRecord[];
}

export function saveFocusAreas(records: FocusAreasRecord[]): void {
  ensureDir(dataDir());
  writeFileSync(focusAreasPath(), JSON.stringify(records, null, 2), "utf8");
}

export function findFocusAreasByClientId(
  clientId: string,
): FocusAreasRecord | undefined {
  return loadFocusAreas().find((r) => r.clientId === clientId);
}

/** Upsert focus areas for a client. */
export function upsertFocusAreas(record: FocusAreasRecord): FocusAreasRecord {
  const records = loadFocusAreas();
  const idx = records.findIndex((r) => r.clientId === record.clientId);
  if (idx >= 0) {
    records[idx] = record;
  } else {
    records.push(record);
  }
  saveFocusAreas(records);
  return record;
}

export function toPublicFocusAreas(record: FocusAreasRecord) {
  return {
    areas: record.areas,
  };
}

// --- Call notes (per client, coach-owned, private by default, opt-in share) ---

export interface CallNoteRecord {
  id: string;
  clientId: string;
  coachId: string;
  body: string;
  callDate: string;
  sharedWithClient: boolean;
  createdAt: string;
  updatedAt: string;
}

function notesPath(): string {
  return path.join(dataDir(), "call-notes.json");
}

export function loadCallNotes(): CallNoteRecord[] {
  const file = notesPath();
  ensureDir(dataDir());
  if (!existsSync(file)) {
    return [];
  }
  const raw = readFileSync(file, "utf8");
  if (!raw.trim()) return [];
  return JSON.parse(raw) as CallNoteRecord[];
}

export function saveCallNotes(notes: CallNoteRecord[]): void {
  ensureDir(dataDir());
  writeFileSync(notesPath(), JSON.stringify(notes, null, 2), "utf8");
}

export function findCallNoteById(id: string): CallNoteRecord | undefined {
  return loadCallNotes().find((n) => n.id === id);
}

export function listCallNotesByClientId(clientId: string): CallNoteRecord[] {
  return loadCallNotes().filter((n) => n.clientId === clientId);
}

export function insertCallNote(note: CallNoteRecord): CallNoteRecord {
  const notes = loadCallNotes();
  notes.push(note);
  saveCallNotes(notes);
  return note;
}

export function updateCallNote(note: CallNoteRecord): CallNoteRecord {
  const notes = loadCallNotes();
  const idx = notes.findIndex((n) => n.id === note.id);
  if (idx < 0) {
    throw new Error(`Call note not found: ${note.id}`);
  }
  notes[idx] = note;
  saveCallNotes(notes);
  return note;
}

export function toPublicCallNote(note: CallNoteRecord) {
  return {
    id: note.id,
    body: note.body,
    callDate: note.callDate,
    sharedWithClient: note.sharedWithClient,
  };
}

// --- Feedback entries (per client, coach-owned, private by default, opt-in share) ---

export interface FeedbackRecord {
  id: string;
  clientId: string;
  coachId: string;
  body: string;
  source?: string;
  sharedWithClient: boolean;
  createdAt: string;
  updatedAt: string;
}

function feedbackPath(): string {
  return path.join(dataDir(), "feedback.json");
}

export function loadFeedback(): FeedbackRecord[] {
  const file = feedbackPath();
  ensureDir(dataDir());
  if (!existsSync(file)) {
    return [];
  }
  const raw = readFileSync(file, "utf8");
  if (!raw.trim()) return [];
  return JSON.parse(raw) as FeedbackRecord[];
}

export function saveFeedback(entries: FeedbackRecord[]): void {
  ensureDir(dataDir());
  writeFileSync(feedbackPath(), JSON.stringify(entries, null, 2), "utf8");
}

export function findFeedbackById(id: string): FeedbackRecord | undefined {
  return loadFeedback().find((f) => f.id === id);
}

export function listFeedbackByClientId(clientId: string): FeedbackRecord[] {
  return loadFeedback().filter((f) => f.clientId === clientId);
}

export function insertFeedback(entry: FeedbackRecord): FeedbackRecord {
  const entries = loadFeedback();
  entries.push(entry);
  saveFeedback(entries);
  return entry;
}

export function updateFeedback(entry: FeedbackRecord): FeedbackRecord {
  const entries = loadFeedback();
  const idx = entries.findIndex((f) => f.id === entry.id);
  if (idx < 0) {
    throw new Error(`Feedback not found: ${entry.id}`);
  }
  entries[idx] = entry;
  saveFeedback(entries);
  return entry;
}

export function toPublicFeedback(entry: FeedbackRecord) {
  return {
    id: entry.id,
    body: entry.body,
    source: entry.source,
    sharedWithClient: entry.sharedWithClient,
  };
}

// --- Coaching plan (goals + actions per client, coach-owned, outcome-only) ---

export interface PlanGoal {
  title: string;
  status: string;
}

export interface PlanAction {
  title: string;
  dueDate?: string;
}

export interface CoachingPlanRecord {
  clientId: string;
  coachId: string;
  goals: PlanGoal[];
  actions: PlanAction[];
  updatedAt: string;
}

function coachingPlanPath(): string {
  return path.join(dataDir(), "coaching-plans.json");
}

export function loadCoachingPlans(): CoachingPlanRecord[] {
  const file = coachingPlanPath();
  ensureDir(dataDir());
  if (!existsSync(file)) {
    return [];
  }
  const raw = readFileSync(file, "utf8");
  if (!raw.trim()) return [];
  return JSON.parse(raw) as CoachingPlanRecord[];
}

export function saveCoachingPlans(records: CoachingPlanRecord[]): void {
  ensureDir(dataDir());
  writeFileSync(coachingPlanPath(), JSON.stringify(records, null, 2), "utf8");
}

export function findCoachingPlanByClientId(
  clientId: string,
): CoachingPlanRecord | undefined {
  return loadCoachingPlans().find((r) => r.clientId === clientId);
}

/** Upsert coaching plan for a client. */
export function upsertCoachingPlan(
  record: CoachingPlanRecord,
): CoachingPlanRecord {
  const records = loadCoachingPlans();
  const idx = records.findIndex((r) => r.clientId === record.clientId);
  if (idx >= 0) {
    records[idx] = record;
  } else {
    records.push(record);
  }
  saveCoachingPlans(records);
  return record;
}

export function toPublicCoachingPlan(record: CoachingPlanRecord) {
  return {
    goals: record.goals,
    actions: record.actions,
  };
}

// --- Resource recommendations (books/podcasts/other, coach-owned, outcome-only) ---

export type RecommendationType = "book" | "podcast" | "other";

export const RECOMMENDATION_TYPES: readonly RecommendationType[] = [
  "book",
  "podcast",
  "other",
] as const;

export interface RecommendationRecord {
  id: string;
  clientId: string;
  coachId: string;
  title: string;
  type: RecommendationType;
  url?: string;
  notes?: string;
  createdAt: string;
}

function recommendationsPath(): string {
  return path.join(dataDir(), "recommendations.json");
}

export function loadRecommendations(): RecommendationRecord[] {
  const file = recommendationsPath();
  ensureDir(dataDir());
  if (!existsSync(file)) {
    return [];
  }
  const raw = readFileSync(file, "utf8");
  if (!raw.trim()) return [];
  return JSON.parse(raw) as RecommendationRecord[];
}

export function saveRecommendations(records: RecommendationRecord[]): void {
  ensureDir(dataDir());
  writeFileSync(recommendationsPath(), JSON.stringify(records, null, 2), "utf8");
}

export function listRecommendationsByClientId(
  clientId: string,
): RecommendationRecord[] {
  return loadRecommendations().filter((r) => r.clientId === clientId);
}

export function insertRecommendation(
  record: RecommendationRecord,
): RecommendationRecord {
  const records = loadRecommendations();
  records.push(record);
  saveRecommendations(records);
  return record;
}

export function toPublicRecommendation(record: RecommendationRecord) {
  return {
    id: record.id,
    title: record.title,
    type: record.type,
    ...(record.url !== undefined ? { url: record.url } : {}),
    ...(record.notes !== undefined ? { notes: record.notes } : {}),
  };
}
