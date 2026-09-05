import request from "supertest";
import { createApp } from "../src/app.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

export function freshApp() {
  const dataDir = mkdtempSync(path.join(tmpdir(), "lcp-v2-"));
  process.env.LCP_DATA_DIR = dataDir;
  const app = createApp();
  return {
    app,
    dataDir,
    cleanup: () => {
      try {
        rmSync(dataDir, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
    },
  };
}

export async function registerCoach(
  app: ReturnType<typeof createApp>,
  overrides: Partial<{ email: string; password: string; name: string }> = {},
) {
  const body = {
    email:
      overrides.email ??
      `coach-${Date.now()}-${Math.random().toString(36).slice(2)}@example.com`,
    password: overrides.password ?? "secure-pass-123",
    name: overrides.name ?? "Ada Coach",
  };
  const res = await request(app).post("/api/auth/register").send(body);
  return { res, body };
}

export async function login(
  app: ReturnType<typeof createApp>,
  email: string,
  password: string,
) {
  return request(app).post("/api/auth/login").send({ email, password });
}

export function sessionCookie(res: request.Response): string {
  const raw = res.headers["set-cookie"];
  if (!raw) return "";
  const list = Array.isArray(raw) ? raw : [raw];
  return list.map((c) => c.split(";")[0]).join("; ");
}

/** Coach session + a client they own. */
export async function coachWithClient(
  app: ReturnType<typeof createApp>,
  label = "client",
) {
  const email = `coach-${label}-${Date.now()}@example.com`;
  const password = "secure-pass-123";
  await registerCoach(app, { email, password, name: "Coach" });
  const cookie = sessionCookie(await login(app, email, password));
  const client = await request(app)
    .post("/api/clients")
    .set("Cookie", cookie)
    .send({ name: `${label} Person`, email: `${label}-${Date.now()}@acme.com` });
  return {
    coachCookie: cookie,
    clientId: client.body.id as string,
    coachEmail: email,
    password,
  };
}

/** Provision a client login bound to a coach-owned client record. */
export async function provisionPortalClient(
  app: ReturnType<typeof createApp>,
  coachCookie: string,
  clientId: string,
  portalEmail: string,
  portalPassword = "client-pass-123",
) {
  const grant = await request(app)
    .post(`/api/clients/${clientId}/portal-access`)
    .set("Cookie", coachCookie)
    .send({ email: portalEmail, password: portalPassword, name: "Portal User" });
  const loginRes = await login(app, portalEmail, portalPassword);
  return {
    grant,
    clientCookie: sessionCookie(loginRes),
    portalEmail,
    portalPassword,
  };
}
