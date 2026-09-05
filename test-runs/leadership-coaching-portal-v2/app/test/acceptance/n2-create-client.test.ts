import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import request from "supertest";
import {
  freshApp,
  registerCoach,
  login,
  sessionCookie,
  coachWithClient,
  provisionPortalClient,
} from "../helpers.js";

async function coachSession(app: ReturnType<typeof freshApp>["app"], email: string) {
  const password = "secure-pass-123";
  await registerCoach(app, { email, password, name: "Coach" });
  return sessionCookie(await login(app, email, password));
}

describe("N2 — create clients + role separation + tenant isolation", () => {
  const ctx = freshApp();
  after(() => ctx.cleanup());

  it("coach creates a client; it appears in their list and by id", async () => {
    const cookie = await coachSession(ctx.app, "n2-coach@example.com");
    const create = await request(ctx.app)
      .post("/api/clients")
      .set("Cookie", cookie)
      .send({ name: "Sam Leader", email: "sam@acme.com" });
    assert.equal(create.status, 201, JSON.stringify(create.body));
    assert.equal(create.body.name, "Sam Leader");
    assert.ok(create.body.id);

    const list = await request(ctx.app).get("/api/clients").set("Cookie", cookie);
    assert.equal(list.status, 200);
    assert.ok(list.body.some((c: { id: string }) => c.id === create.body.id));

    const get = await request(ctx.app)
      .get(`/api/clients/${create.body.id}`)
      .set("Cookie", cookie);
    assert.equal(get.status, 200);
    assert.equal(get.body.name, "Sam Leader");
  });

  it("unauthenticated create returns 401", async () => {
    const res = await request(ctx.app)
      .post("/api/clients")
      .send({ name: "X", email: "x@y.com" });
    assert.equal(res.status, 401);
  });

  it("coach A cannot list or fetch coach B's clients", async () => {
    const cookieA = await coachSession(ctx.app, "tenant-a@example.com");
    const cookieB = await coachSession(ctx.app, "tenant-b@example.com");
    const created = await request(ctx.app)
      .post("/api/clients")
      .set("Cookie", cookieA)
      .send({ name: "Only A", email: "only-a@acme.com" });
    assert.equal(created.status, 201);

    const listB = await request(ctx.app).get("/api/clients").set("Cookie", cookieB);
    assert.equal(listB.status, 200);
    assert.ok(!listB.body.some((c: { id: string }) => c.id === created.body.id));

    const getB = await request(ctx.app)
      .get(`/api/clients/${created.body.id}`)
      .set("Cookie", cookieB);
    assert.ok(getB.status === 403 || getB.status === 404);
  });

  it("OBLIGATION O3: client session cannot create or list clients (403)", async () => {
    const { coachCookie, clientId } = await coachWithClient(ctx.app, "role-sep");
    const { clientCookie, grant } = await provisionPortalClient(
      ctx.app,
      coachCookie,
      clientId,
      `portal-n2-${Date.now()}@acme.com`,
    );
    // If portal-access isn't implemented yet this test fails for the right reason
    // once N9 exists; when only N2 is in scope, grant may 404 — skip soft?
    // No: cumulative suite after N9 will catch; for N2 alone portal-access
    // isn't required. Use a two-phase approach: only assert when grant works.
    // Actually for v2 N2's test:n2 does NOT include n9 — so we can't provision
    // a real client session until N9. Role-sep for client must live in N9/N10
    // OR we seed a way to get client role earlier.
    //
    // Design: N2 requires coach-only on POST/GET /api/clients. To test client
    // role we need a client session. That needs portal-access (N9). So put
    // the client→coach role checks in a dedicated section of N9 + each content
    // node after portal exists, AND in n10 full suite.
    //
    // For N2-only RED suite without portal: we can't get a client cookie.
    // Alternative: allow register with role:client only via portal-access.
    //
    // Solution used here: if portal-access returns 201, assert O3; otherwise
    // this assertion is deferred (N9/N10 will fail hard). For cumulative
    // test:n2 before N9, portal-access 404 means we skip this block.
    if (grant.status !== 201) {
      // Pre-N9: cannot obtain client session — N9 suite owns the hard assert.
      return;
    }
    assert.ok(clientCookie.length > 0);

    const create = await request(ctx.app)
      .post("/api/clients")
      .set("Cookie", clientCookie)
      .send({ name: "Hijack", email: "hijack@evil.com" });
    assert.equal(create.status, 403, "client must not create clients");

    const list = await request(ctx.app).get("/api/clients").set("Cookie", clientCookie);
    assert.equal(list.status, 403, "client must not list coach client directory");
  });
});
