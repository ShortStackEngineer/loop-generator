import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import request from "supertest";
import {
  freshApp,
  coachWithClient,
  provisionPortalClient,
  login,
  sessionCookie,
  registerCoach,
} from "../helpers.js";

describe("N9 — portal access + hard role-separation", () => {
  const ctx = freshApp();
  after(() => ctx.cleanup());

  it("coach grants portal access; client reaches GET /api/portal/me", async () => {
    const { coachCookie, clientId } = await coachWithClient(ctx.app, "portal");
    const email = `client-login-${Date.now()}@acme.com`;
    const { grant, clientCookie } = await provisionPortalClient(
      ctx.app,
      coachCookie,
      clientId,
      email,
    );
    assert.equal(grant.status, 201, JSON.stringify(grant.body));
    assert.equal(grant.body.role, "client");
    assert.equal(grant.body.password, undefined);

    const portal = await request(ctx.app)
      .get("/api/portal/me")
      .set("Cookie", clientCookie);
    assert.equal(portal.status, 200, JSON.stringify(portal.body));
    assert.equal(portal.body.role, "client");
    assert.equal(portal.body.clientId, clientId);
  });

  it("coach session cannot use GET /api/portal/me", async () => {
    const { coachCookie } = await coachWithClient(ctx.app, "portal-coach-block");
    const portal = await request(ctx.app)
      .get("/api/portal/me")
      .set("Cookie", coachCookie);
    assert.ok(portal.status === 403 || portal.status === 401);
  });

  it("OBLIGATION O3 HARD: client session is rejected on all coach client surfaces", async () => {
    const { coachCookie, clientId } = await coachWithClient(ctx.app, "portal-o3");
    const email = `o3-${Date.now()}@acme.com`;
    const { grant, clientCookie } = await provisionPortalClient(
      ctx.app,
      coachCookie,
      clientId,
      email,
    );
    assert.equal(grant.status, 201);

    const surfaces: Array<{ method: "get" | "post" | "put"; path: string; body?: object }> =
      [
        { method: "post", path: "/api/clients", body: { name: "X", email: "x@y.com" } },
        { method: "get", path: "/api/clients" },
        { method: "get", path: `/api/clients/${clientId}` },
        {
          method: "put",
          path: `/api/clients/${clientId}/survey-360`,
          body: { summary: "x", dimensions: [], completedAt: "2026-01-01" },
        },
        {
          method: "put",
          path: `/api/clients/${clientId}/focus-areas`,
          body: { areas: [] },
        },
        {
          method: "post",
          path: `/api/clients/${clientId}/notes`,
          body: { body: "x", callDate: "2026-01-01" },
        },
        {
          method: "post",
          path: `/api/clients/${clientId}/feedback`,
          body: { body: "x" },
        },
        {
          method: "put",
          path: `/api/clients/${clientId}/plan`,
          body: { goals: [], actions: [] },
        },
        {
          method: "post",
          path: `/api/clients/${clientId}/recommendations`,
          body: { title: "x", type: "book" },
        },
        {
          method: "post",
          path: `/api/clients/${clientId}/portal-access`,
          body: { email: "y@z.com", password: "p", name: "Y" },
        },
      ];

    for (const s of surfaces) {
      let req = request(ctx.app)[s.method](s.path).set("Cookie", clientCookie);
      if (s.body) req = req.send(s.body);
      const res = await req;
      assert.equal(
        res.status,
        403,
        `${s.method.toUpperCase()} ${s.path} must be 403 for client, got ${res.status}`,
      );
    }
  });

  it("client cannot read another client's portal identity", async () => {
    const a = await coachWithClient(ctx.app, "iso-a");
    const bClient = await request(ctx.app)
      .post("/api/clients")
      .set("Cookie", a.coachCookie)
      .send({ name: "Other", email: `other-${Date.now()}@acme.com` });
    const emailA = `iso-a-${Date.now()}@acme.com`;
    const emailB = `iso-b-${Date.now()}@acme.com`;
    const portalA = await provisionPortalClient(
      ctx.app,
      a.coachCookie,
      a.clientId,
      emailA,
    );
    const portalB = await provisionPortalClient(
      ctx.app,
      a.coachCookie,
      bClient.body.id,
      emailB,
    );
    assert.equal(portalA.grant.status, 201);
    assert.equal(portalB.grant.status, 201);

    const meA = await request(ctx.app)
      .get("/api/portal/me")
      .set("Cookie", portalA.clientCookie);
    const meB = await request(ctx.app)
      .get("/api/portal/me")
      .set("Cookie", portalB.clientCookie);
    assert.equal(meA.body.clientId, a.clientId);
    assert.equal(meB.body.clientId, bClient.body.id);
    assert.notEqual(meA.body.clientId, meB.body.clientId);
  });
});
