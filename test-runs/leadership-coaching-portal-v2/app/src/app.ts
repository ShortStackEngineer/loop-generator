/**
 * Walking skeleton — N1–N10: auth, clients, survey-360, focus areas, call notes,
 * feedback, coaching plan, recommendations, portal access + hard role separation,
 * portal home (shared content + opt-in notes/feedback).
 * createApp() is the sole test entry point.
 */
import express, { type Request, type Response, type NextFunction } from "express";
import cookieSession from "cookie-session";
import { randomUUID } from "node:crypto";
import {
  findUserByEmail,
  findUserById,
  insertUser,
  toPublicUser,
  findClientById,
  listClientsByCoach,
  insertClient,
  toPublicClient,
  findSurvey360ByClientId,
  upsertSurvey360,
  toPublicSurvey360,
  findFocusAreasByClientId,
  upsertFocusAreas,
  toPublicFocusAreas,
  findCallNoteById,
  listCallNotesByClientId,
  insertCallNote,
  updateCallNote,
  toPublicCallNote,
  findFeedbackById,
  listFeedbackByClientId,
  insertFeedback,
  updateFeedback,
  toPublicFeedback,
  findCoachingPlanByClientId,
  upsertCoachingPlan,
  toPublicCoachingPlan,
  listRecommendationsByClientId,
  insertRecommendation,
  toPublicRecommendation,
  RECOMMENDATION_TYPES,
  type UserRecord,
  type ClientRecord,
  type Survey360Dimension,
  type Survey360Record,
  type FocusAreaItem,
  type FocusAreasRecord,
  type CallNoteRecord,
  type FeedbackRecord,
  type PlanGoal,
  type PlanAction,
  type CoachingPlanRecord,
  type RecommendationRecord,
  type RecommendationType,
} from "./store.js";
import { hashPassword, verifyPassword } from "./password.js";

type SessionData = {
  userId?: string;
};

/** Authenticated user attached by requireAuth / requireCoach. */
export type AuthedRequest = Request & { user?: UserRecord };

function getSession(req: Request): SessionData {
  return (req.session ?? {}) as SessionData;
}

function setSessionUserId(req: Request, userId: string): void {
  if (!req.session) {
    // cookie-session always attaches session when middleware is mounted
    (req as Request & { session: SessionData }).session = {};
  }
  (req.session as SessionData).userId = userId;
}

/** Resolve the session user; 401 if missing/invalid. */
function requireAuth(req: AuthedRequest, res: Response, next: NextFunction): void {
  const userId = getSession(req).userId;
  if (!userId) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  const user = findUserById(userId);
  if (!user) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  req.user = user;
  next();
}

/** Coach-only gate; 403 if authenticated but not a coach (e.g. portal client). */
function requireCoach(req: AuthedRequest, res: Response, next: NextFunction): void {
  if (!req.user) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  if (req.user.role !== "coach") {
    res.status(403).json({ error: "Forbidden" });
    return;
  }
  next();
}

/** Client-only gate; 403 if authenticated but not a portal client (e.g. coach). */
function requireClient(req: AuthedRequest, res: Response, next: NextFunction): void {
  if (!req.user) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  if (req.user.role !== "client" || !req.user.clientId) {
    res.status(403).json({ error: "Forbidden" });
    return;
  }
  next();
}

export function createApp() {
  const app = express();

  app.use(
    express.json({
      strict: true,
    }),
  );

  app.use(
    cookieSession({
      name: "lcp.sid",
      keys: [process.env.SESSION_SECRET ?? "lcp-dev-session-secret"],
      maxAge: 7 * 24 * 60 * 60 * 1000,
      httpOnly: true,
      sameSite: "lax",
    }),
  );

  app.post("/api/auth/register", async (req, res, next) => {
    try {
      const email = typeof req.body?.email === "string" ? req.body.email.trim() : "";
      const password =
        typeof req.body?.password === "string" ? req.body.password : "";
      const name = typeof req.body?.name === "string" ? req.body.name.trim() : "";

      if (!email || !password || !name) {
        res.status(400).json({ error: "email, password, and name are required" });
        return;
      }

      if (findUserByEmail(email)) {
        res.status(409).json({ error: "Email already registered" });
        return;
      }

      const user: UserRecord = {
        id: randomUUID(),
        email,
        emailNormalized: email.toLowerCase(),
        name,
        role: "coach",
        passwordHash: await hashPassword(password),
        createdAt: new Date().toISOString(),
      };

      insertUser(user);
      setSessionUserId(req, user.id);
      res.status(201).json(toPublicUser(user));
    } catch (err) {
      next(err);
    }
  });

  app.post("/api/auth/login", async (req, res, next) => {
    try {
      const email = typeof req.body?.email === "string" ? req.body.email.trim() : "";
      const password =
        typeof req.body?.password === "string" ? req.body.password : "";

      if (!email || !password) {
        res.status(400).json({ error: "email and password are required" });
        return;
      }

      const user = findUserByEmail(email);
      if (!user || !(await verifyPassword(password, user.passwordHash))) {
        res.status(401).json({ error: "Invalid credentials" });
        return;
      }

      setSessionUserId(req, user.id);
      res.status(200).json(toPublicUser(user));
    } catch (err) {
      next(err);
    }
  });

  app.get("/api/me", (req, res) => {
    const userId = getSession(req).userId;
    if (!userId) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }

    const user = findUserById(userId);
    if (!user) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }

    res.status(200).json(toPublicUser(user));
  });

  // --- N2: coach client roster (coach-only, tenant-isolated) ---

  app.post("/api/clients", requireAuth, requireCoach, (req: AuthedRequest, res) => {
    const name = typeof req.body?.name === "string" ? req.body.name.trim() : "";
    const email = typeof req.body?.email === "string" ? req.body.email.trim() : "";

    if (!name || !email) {
      res.status(400).json({ error: "name and email are required" });
      return;
    }

    const client: ClientRecord = {
      id: randomUUID(),
      coachId: req.user!.id,
      name,
      email,
      createdAt: new Date().toISOString(),
    };

    insertClient(client);
    res.status(201).json(toPublicClient(client));
  });

  app.get("/api/clients", requireAuth, requireCoach, (req: AuthedRequest, res) => {
    const clients = listClientsByCoach(req.user!.id);
    res.status(200).json(clients.map(toPublicClient));
  });

  app.get("/api/clients/:id", requireAuth, requireCoach, (req: AuthedRequest, res) => {
    const id = String(req.params.id ?? "");
    const client = findClientById(id);
    if (!client) {
      res.status(404).json({ error: "Client not found" });
      return;
    }
    if (client.coachId !== req.user!.id) {
      // Other coach's client — do not leak existence
      res.status(404).json({ error: "Client not found" });
      return;
    }
    res.status(200).json(toPublicClient(client));
  });

  // --- N3: proprietary 360 survey results (coach-only, tenant-isolated) ---

  function ownedClientOr404(
    req: AuthedRequest,
    res: Response,
    clientId: string,
  ): ClientRecord | null {
    const client = findClientById(clientId);
    if (!client || client.coachId !== req.user!.id) {
      res.status(404).json({ error: "Client not found" });
      return null;
    }
    return client;
  }

  function parseSurvey360Body(
    body: unknown,
  ): { ok: true; data: { summary: string; dimensions: Survey360Dimension[]; completedAt: string } } | { ok: false; error: string } {
    if (!body || typeof body !== "object") {
      return { ok: false, error: "Invalid body" };
    }
    const b = body as Record<string, unknown>;
    const summary = typeof b.summary === "string" ? b.summary : "";
    const completedAt =
      typeof b.completedAt === "string" ? b.completedAt.trim() : "";
    if (!summary.trim() || !completedAt) {
      return { ok: false, error: "summary and completedAt are required" };
    }
    if (!Array.isArray(b.dimensions)) {
      return { ok: false, error: "dimensions must be an array" };
    }
    const dimensions: Survey360Dimension[] = [];
    for (const d of b.dimensions) {
      if (!d || typeof d !== "object") {
        return { ok: false, error: "each dimension must be an object" };
      }
      const dim = d as Record<string, unknown>;
      const name = typeof dim.name === "string" ? dim.name : "";
      const notes = typeof dim.notes === "string" ? dim.notes : "";
      const score =
        typeof dim.score === "number" && Number.isFinite(dim.score)
          ? dim.score
          : NaN;
      if (!name || Number.isNaN(score)) {
        return {
          ok: false,
          error: "each dimension requires name and numeric score",
        };
      }
      dimensions.push({ name, score, notes });
    }
    return { ok: true, data: { summary, dimensions, completedAt } };
  }

  app.put(
    "/api/clients/:id/survey-360",
    requireAuth,
    requireCoach,
    (req: AuthedRequest, res) => {
      const id = String(req.params.id ?? "");
      const client = ownedClientOr404(req, res, id);
      if (!client) return;

      const parsed = parseSurvey360Body(req.body);
      if (!parsed.ok) {
        res.status(400).json({ error: parsed.error });
        return;
      }

      const record: Survey360Record = {
        clientId: client.id,
        coachId: client.coachId,
        summary: parsed.data.summary,
        dimensions: parsed.data.dimensions,
        completedAt: parsed.data.completedAt,
        updatedAt: new Date().toISOString(),
      };
      upsertSurvey360(record);
      res.status(200).json(toPublicSurvey360(record));
    },
  );

  app.get(
    "/api/clients/:id/survey-360",
    requireAuth,
    requireCoach,
    (req: AuthedRequest, res) => {
      const id = String(req.params.id ?? "");
      const client = ownedClientOr404(req, res, id);
      if (!client) return;

      const record = findSurvey360ByClientId(client.id);
      if (!record) {
        res.status(404).json({ error: "Survey 360 not found" });
        return;
      }
      res.status(200).json(toPublicSurvey360(record));
    },
  );

  // --- N4: focus areas (ordered list, coach-only, tenant-isolated) ---

  function parseFocusAreasBody(
    body: unknown,
  ): { ok: true; areas: FocusAreaItem[] } | { ok: false; error: string } {
    if (!body || typeof body !== "object") {
      return { ok: false, error: "Invalid body" };
    }
    const b = body as Record<string, unknown>;
    if (!Array.isArray(b.areas)) {
      return { ok: false, error: "areas must be an array" };
    }
    const areas: FocusAreaItem[] = [];
    for (const item of b.areas) {
      if (!item || typeof item !== "object") {
        return { ok: false, error: "each focus area must be an object" };
      }
      const a = item as Record<string, unknown>;
      const title = typeof a.title === "string" ? a.title.trim() : "";
      const priority =
        typeof a.priority === "number" && Number.isFinite(a.priority)
          ? a.priority
          : NaN;
      if (!title || Number.isNaN(priority)) {
        return {
          ok: false,
          error: "each focus area requires title and numeric priority",
        };
      }
      areas.push({ title, priority });
    }
    // Ordered by priority ascending (stable for equal priorities)
    areas.sort((x, y) => x.priority - y.priority);
    return { ok: true, areas };
  }

  app.put(
    "/api/clients/:id/focus-areas",
    requireAuth,
    requireCoach,
    (req: AuthedRequest, res) => {
      const id = String(req.params.id ?? "");
      const client = ownedClientOr404(req, res, id);
      if (!client) return;

      const parsed = parseFocusAreasBody(req.body);
      if (!parsed.ok) {
        res.status(400).json({ error: parsed.error });
        return;
      }

      const record: FocusAreasRecord = {
        clientId: client.id,
        coachId: client.coachId,
        areas: parsed.areas,
        updatedAt: new Date().toISOString(),
      };
      upsertFocusAreas(record);
      res.status(200).json(toPublicFocusAreas(record));
    },
  );

  app.get(
    "/api/clients/:id/focus-areas",
    requireAuth,
    requireCoach,
    (req: AuthedRequest, res) => {
      const id = String(req.params.id ?? "");
      const client = ownedClientOr404(req, res, id);
      if (!client) return;

      const record = findFocusAreasByClientId(client.id);
      if (!record) {
        res.status(200).json({ areas: [] });
        return;
      }
      res.status(200).json(toPublicFocusAreas(record));
    },
  );

  // --- N5: call notes (coach-only create/list; opt-in sharedWithClient) ---

  app.post(
    "/api/clients/:id/notes",
    requireAuth,
    requireCoach,
    (req: AuthedRequest, res) => {
      const id = String(req.params.id ?? "");
      const client = ownedClientOr404(req, res, id);
      if (!client) return;

      const body = typeof req.body?.body === "string" ? req.body.body : "";
      const callDate =
        typeof req.body?.callDate === "string" ? req.body.callDate.trim() : "";
      if (!body.trim() || !callDate) {
        res.status(400).json({ error: "body and callDate are required" });
        return;
      }

      const now = new Date().toISOString();
      const note: CallNoteRecord = {
        id: randomUUID(),
        clientId: client.id,
        coachId: client.coachId,
        body,
        callDate,
        sharedWithClient: false,
        createdAt: now,
        updatedAt: now,
      };
      insertCallNote(note);
      res.status(201).json(toPublicCallNote(note));
    },
  );

  app.get(
    "/api/clients/:id/notes",
    requireAuth,
    requireCoach,
    (req: AuthedRequest, res) => {
      const id = String(req.params.id ?? "");
      const client = ownedClientOr404(req, res, id);
      if (!client) return;

      const notes = listCallNotesByClientId(client.id);
      res.status(200).json(notes.map(toPublicCallNote));
    },
  );

  app.patch(
    "/api/clients/:id/notes/:noteId",
    requireAuth,
    requireCoach,
    (req: AuthedRequest, res) => {
      const clientId = String(req.params.id ?? "");
      const noteId = String(req.params.noteId ?? "");
      const client = ownedClientOr404(req, res, clientId);
      if (!client) return;

      const note = findCallNoteById(noteId);
      if (!note || note.clientId !== client.id || note.coachId !== req.user!.id) {
        res.status(404).json({ error: "Note not found" });
        return;
      }

      if (
        !req.body ||
        typeof req.body !== "object" ||
        typeof (req.body as { sharedWithClient?: unknown }).sharedWithClient !==
          "boolean"
      ) {
        res.status(400).json({ error: "sharedWithClient boolean is required" });
        return;
      }

      const sharedWithClient = (req.body as { sharedWithClient: boolean })
        .sharedWithClient;
      const updated: CallNoteRecord = {
        ...note,
        sharedWithClient,
        updatedAt: new Date().toISOString(),
      };
      updateCallNote(updated);
      res.status(200).json(toPublicCallNote(updated));
    },
  );

  // --- N6: feedback entries (coach-only create/list; opt-in sharedWithClient) ---

  app.post(
    "/api/clients/:id/feedback",
    requireAuth,
    requireCoach,
    (req: AuthedRequest, res) => {
      const id = String(req.params.id ?? "");
      const client = ownedClientOr404(req, res, id);
      if (!client) return;

      const body = typeof req.body?.body === "string" ? req.body.body : "";
      if (!body.trim()) {
        res.status(400).json({ error: "body is required" });
        return;
      }

      const source =
        typeof req.body?.source === "string" ? req.body.source.trim() : undefined;

      const now = new Date().toISOString();
      const entry: FeedbackRecord = {
        id: randomUUID(),
        clientId: client.id,
        coachId: client.coachId,
        body,
        ...(source ? { source } : {}),
        sharedWithClient: false,
        createdAt: now,
        updatedAt: now,
      };
      insertFeedback(entry);
      res.status(201).json(toPublicFeedback(entry));
    },
  );

  app.get(
    "/api/clients/:id/feedback",
    requireAuth,
    requireCoach,
    (req: AuthedRequest, res) => {
      const id = String(req.params.id ?? "");
      const client = ownedClientOr404(req, res, id);
      if (!client) return;

      const entries = listFeedbackByClientId(client.id);
      res.status(200).json(entries.map(toPublicFeedback));
    },
  );

  app.patch(
    "/api/clients/:id/feedback/:feedbackId",
    requireAuth,
    requireCoach,
    (req: AuthedRequest, res) => {
      const clientId = String(req.params.id ?? "");
      const feedbackId = String(req.params.feedbackId ?? "");
      const client = ownedClientOr404(req, res, clientId);
      if (!client) return;

      const entry = findFeedbackById(feedbackId);
      if (
        !entry ||
        entry.clientId !== client.id ||
        entry.coachId !== req.user!.id
      ) {
        res.status(404).json({ error: "Feedback not found" });
        return;
      }

      if (
        !req.body ||
        typeof req.body !== "object" ||
        typeof (req.body as { sharedWithClient?: unknown }).sharedWithClient !==
          "boolean"
      ) {
        res.status(400).json({ error: "sharedWithClient boolean is required" });
        return;
      }

      const sharedWithClient = (req.body as { sharedWithClient: boolean })
        .sharedWithClient;
      const updated: FeedbackRecord = {
        ...entry,
        sharedWithClient,
        updatedAt: new Date().toISOString(),
      };
      updateFeedback(updated);
      res.status(200).json(toPublicFeedback(updated));
    },
  );

  // --- N7: coaching plan (goals + actions, coach-only, tenant-isolated) ---

  function parseCoachingPlanBody(
    body: unknown,
  ):
    | { ok: true; goals: PlanGoal[]; actions: PlanAction[] }
    | { ok: false; error: string } {
    if (!body || typeof body !== "object") {
      return { ok: false, error: "Invalid body" };
    }
    const b = body as Record<string, unknown>;
    if (!Array.isArray(b.goals)) {
      return { ok: false, error: "goals must be an array" };
    }
    if (!Array.isArray(b.actions)) {
      return { ok: false, error: "actions must be an array" };
    }

    const goals: PlanGoal[] = [];
    for (const item of b.goals) {
      if (!item || typeof item !== "object") {
        return { ok: false, error: "each goal must be an object" };
      }
      const g = item as Record<string, unknown>;
      const title = typeof g.title === "string" ? g.title.trim() : "";
      const status = typeof g.status === "string" ? g.status.trim() : "";
      if (!title || !status) {
        return { ok: false, error: "each goal requires title and status" };
      }
      goals.push({ title, status });
    }

    const actions: PlanAction[] = [];
    for (const item of b.actions) {
      if (!item || typeof item !== "object") {
        return { ok: false, error: "each action must be an object" };
      }
      const a = item as Record<string, unknown>;
      const title = typeof a.title === "string" ? a.title.trim() : "";
      if (!title) {
        return { ok: false, error: "each action requires title" };
      }
      const action: PlanAction = { title };
      if (a.dueDate !== undefined && a.dueDate !== null) {
        if (typeof a.dueDate !== "string" || !a.dueDate.trim()) {
          return { ok: false, error: "action dueDate must be a non-empty string when provided" };
        }
        action.dueDate = a.dueDate.trim();
      }
      actions.push(action);
    }

    return { ok: true, goals, actions };
  }

  app.put(
    "/api/clients/:id/plan",
    requireAuth,
    requireCoach,
    (req: AuthedRequest, res) => {
      const id = String(req.params.id ?? "");
      const client = ownedClientOr404(req, res, id);
      if (!client) return;

      const parsed = parseCoachingPlanBody(req.body);
      if (!parsed.ok) {
        res.status(400).json({ error: parsed.error });
        return;
      }

      const record: CoachingPlanRecord = {
        clientId: client.id,
        coachId: client.coachId,
        goals: parsed.goals,
        actions: parsed.actions,
        updatedAt: new Date().toISOString(),
      };
      upsertCoachingPlan(record);
      res.status(200).json(toPublicCoachingPlan(record));
    },
  );

  app.get(
    "/api/clients/:id/plan",
    requireAuth,
    requireCoach,
    (req: AuthedRequest, res) => {
      const id = String(req.params.id ?? "");
      const client = ownedClientOr404(req, res, id);
      if (!client) return;

      const record = findCoachingPlanByClientId(client.id);
      if (!record) {
        res.status(200).json({ goals: [], actions: [] });
        return;
      }
      res.status(200).json(toPublicCoachingPlan(record));
    },
  );

  // --- N8: resource recommendations (book/podcast/other, coach-only) ---

  function parseRecommendationType(
    value: unknown,
  ): RecommendationType | null {
    if (typeof value !== "string") return null;
    return (RECOMMENDATION_TYPES as readonly string[]).includes(value)
      ? (value as RecommendationType)
      : null;
  }

  app.post(
    "/api/clients/:id/recommendations",
    requireAuth,
    requireCoach,
    (req: AuthedRequest, res) => {
      const id = String(req.params.id ?? "");
      const client = ownedClientOr404(req, res, id);
      if (!client) return;

      const title =
        typeof req.body?.title === "string" ? req.body.title.trim() : "";
      if (!title) {
        res.status(400).json({ error: "title is required" });
        return;
      }

      const type = parseRecommendationType(req.body?.type);
      if (!type) {
        res.status(400).json({
          error: "type must be one of: book, podcast, other",
        });
        return;
      }

      const record: RecommendationRecord = {
        id: randomUUID(),
        clientId: client.id,
        coachId: client.coachId,
        title,
        type,
        createdAt: new Date().toISOString(),
      };

      if (req.body?.url !== undefined && req.body?.url !== null) {
        if (typeof req.body.url !== "string") {
          res.status(400).json({ error: "url must be a string when provided" });
          return;
        }
        const url = req.body.url.trim();
        if (url) record.url = url;
      }

      if (req.body?.notes !== undefined && req.body?.notes !== null) {
        if (typeof req.body.notes !== "string") {
          res.status(400).json({ error: "notes must be a string when provided" });
          return;
        }
        record.notes = req.body.notes;
      }

      insertRecommendation(record);
      res.status(201).json(toPublicRecommendation(record));
    },
  );

  app.get(
    "/api/clients/:id/recommendations",
    requireAuth,
    requireCoach,
    (req: AuthedRequest, res) => {
      const id = String(req.params.id ?? "");
      const client = ownedClientOr404(req, res, id);
      if (!client) return;

      const recs = listRecommendationsByClientId(client.id);
      res.status(200).json(recs.map(toPublicRecommendation));
    },
  );

  // --- N9: portal access (coach grants client login) + portal identity ---

  app.post(
    "/api/clients/:id/portal-access",
    requireAuth,
    requireCoach,
    async (req: AuthedRequest, res, next) => {
      try {
        const id = String(req.params.id ?? "");
        const client = ownedClientOr404(req, res, id);
        if (!client) return;

        const email =
          typeof req.body?.email === "string" ? req.body.email.trim() : "";
        const password =
          typeof req.body?.password === "string" ? req.body.password : "";
        const name =
          typeof req.body?.name === "string" ? req.body.name.trim() : "";

        if (!email || !password || !name) {
          res
            .status(400)
            .json({ error: "email, password, and name are required" });
          return;
        }

        if (findUserByEmail(email)) {
          res.status(409).json({ error: "Email already registered" });
          return;
        }

        const user: UserRecord = {
          id: randomUUID(),
          email,
          emailNormalized: email.toLowerCase(),
          name,
          role: "client",
          clientId: client.id,
          passwordHash: await hashPassword(password),
          createdAt: new Date().toISOString(),
        };

        insertUser(user);
        res.status(201).json(toPublicUser(user));
      } catch (err) {
        next(err);
      }
    },
  );

  app.get(
    "/api/portal/me",
    requireAuth,
    requireClient,
    (req: AuthedRequest, res) => {
      res.status(200).json({
        role: "client",
        clientId: req.user!.clientId,
      });
    },
  );

  // --- N10: portal home — client-only assembly of shared coaching content ---

  app.get(
    "/api/portal/home",
    requireAuth,
    requireClient,
    (req: AuthedRequest, res) => {
      const clientId = req.user!.clientId!;

      const survey360 = findSurvey360ByClientId(clientId);
      const focusAreas = findFocusAreasByClientId(clientId);
      const plan = findCoachingPlanByClientId(clientId);
      const recommendations = listRecommendationsByClientId(clientId);
      // Notes/feedback: only entries the coach explicitly shared
      const notes = listCallNotesByClientId(clientId).filter(
        (n) => n.sharedWithClient === true,
      );
      const feedback = listFeedbackByClientId(clientId).filter(
        (f) => f.sharedWithClient === true,
      );

      res.status(200).json({
        survey360: survey360 ? toPublicSurvey360(survey360) : null,
        focusAreas: focusAreas
          ? toPublicFocusAreas(focusAreas)
          : { areas: [] },
        plan: plan ? toPublicCoachingPlan(plan) : { goals: [], actions: [] },
        recommendations: recommendations.map(toPublicRecommendation),
        notes: notes.map(toPublicCallNote),
        feedback: feedback.map(toPublicFeedback),
      });
    },
  );

  // Malformed JSON and other client body errors → 400 (not 500)
  app.use(
    (err: unknown, _req: Request, res: Response, next: NextFunction) => {
      if (err instanceof SyntaxError) {
        res.status(400).json({ error: "Malformed JSON" });
        return;
      }
      const status =
        typeof err === "object" &&
        err !== null &&
        "status" in err &&
        typeof (err as { status: unknown }).status === "number"
          ? (err as { status: number }).status
          : undefined;
      if (status === 400) {
        res.status(400).json({ error: "Bad request" });
        return;
      }
      next(err);
    },
  );

  return app;
}
