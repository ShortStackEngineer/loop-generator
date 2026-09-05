import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import request from "supertest";
import { freshApp, coachWithClient, provisionPortalClient } from "../helpers.js";

async function provisionRichPortal(app: ReturnType<typeof freshApp>["app"]) {
  const { coachCookie, clientId } = await coachWithClient(app, "n10");

  await request(app)
    .put(`/api/clients/${clientId}/survey-360`)
    .set("Cookie", coachCookie)
    .send({
      summary: "360 summary for client eyes",
      dimensions: [{ name: "Influence", score: 3.5, notes: "Growing" }],
      completedAt: "2026-06-01",
    });

  await request(app)
    .put(`/api/clients/${clientId}/focus-areas`)
    .set("Cookie", coachCookie)
    .send({ areas: [{ title: "Influence without authority", priority: 1 }] });

  const privateNote = await request(app)
    .post(`/api/clients/${clientId}/notes`)
    .set("Cookie", coachCookie)
    .send({ body: "PRIVATE coach note — never on portal", callDate: "2026-06-10" });

  const sharedNote = await request(app)
    .post(`/api/clients/${clientId}/notes`)
    .set("Cookie", coachCookie)
    .send({ body: "SHARED reflection the client may see", callDate: "2026-06-11" });

  if (sharedNote.status === 201) {
    await request(app)
      .patch(`/api/clients/${clientId}/notes/${sharedNote.body.id}`)
      .set("Cookie", coachCookie)
      .send({ sharedWithClient: true });
  }

  const privateFb = await request(app)
    .post(`/api/clients/${clientId}/feedback`)
    .set("Cookie", coachCookie)
    .send({ body: "PRIVATE feedback transcript", source: "skip-level" });

  const sharedFb = await request(app)
    .post(`/api/clients/${clientId}/feedback`)
    .set("Cookie", coachCookie)
    .send({ body: "SHARED strength: calm under pressure", source: "peer" });

  if (sharedFb.status === 201) {
    await request(app)
      .patch(`/api/clients/${clientId}/feedback/${sharedFb.body.id}`)
      .set("Cookie", coachCookie)
      .send({ sharedWithClient: true });
  }

  await request(app)
    .put(`/api/clients/${clientId}/plan`)
    .set("Cookie", coachCookie)
    .send({
      goals: [{ title: "Ship influence playbook", status: "active" }],
      actions: [{ title: "Draft playbook v1", dueDate: "2026-08-15" }],
    });

  await request(app)
    .post(`/api/clients/${clientId}/recommendations`)
    .set("Cookie", coachCookie)
    .send({ title: "Radical Candor", type: "book" });

  const email = `n10-client-${Date.now()}@acme.com`;
  const portal = await provisionPortalClient(app, coachCookie, clientId, email);

  return {
    coachCookie,
    clientId,
    clientCookie: portal.clientCookie,
    grant: portal.grant,
    privateNote,
    sharedNote,
    privateFb,
    sharedFb,
  };
}

describe("N10 — portal home: shared content + opt-in notes/feedback", () => {
  const ctx = freshApp();
  after(() => ctx.cleanup());

  it("portal home includes 360, focus areas, plan, recommendations", async () => {
    const p = await provisionRichPortal(ctx.app);
    assert.equal(p.grant.status, 201);

    const home = await request(ctx.app)
      .get("/api/portal/home")
      .set("Cookie", p.clientCookie);
    assert.equal(home.status, 200, JSON.stringify(home.body));
    assert.ok(home.body.survey360);
    assert.match(home.body.survey360.summary, /360 summary/);
    assert.ok(home.body.focusAreas?.areas?.length >= 1);
    assert.ok(home.body.plan?.goals?.length >= 1);
    assert.ok(home.body.recommendations?.length >= 1);
    assert.equal(home.body.recommendations[0].title, "Radical Candor");
  });

  it("portal home includes ONLY shared notes/feedback; omits private ones", async () => {
    const p = await provisionRichPortal(ctx.app);
    assert.equal(p.grant.status, 201);

    const home = await request(ctx.app)
      .get("/api/portal/home")
      .set("Cookie", p.clientCookie);
    assert.equal(home.status, 200);
    const blob = JSON.stringify(home.body);

    assert.ok(!blob.includes("PRIVATE coach note"), "private notes must not leak");
    assert.ok(!blob.includes("PRIVATE feedback"), "private feedback must not leak");
    assert.ok(
      blob.includes("SHARED reflection the client may see"),
      "shared notes must appear after toggle",
    );
    assert.ok(
      blob.includes("SHARED strength: calm under pressure"),
      "shared feedback must appear after toggle",
    );

    // structured fields when present
    if (Array.isArray(home.body.notes)) {
      assert.ok(home.body.notes.every((n: { sharedWithClient?: boolean; body: string }) => {
        return n.sharedWithClient !== false && !n.body.includes("PRIVATE");
      }));
    }
    if (Array.isArray(home.body.feedback)) {
      assert.ok(home.body.feedback.every((f: { body: string }) => !f.body.includes("PRIVATE")));
    }
  });

  it("client B cannot see client A's portal content", async () => {
    const a = await provisionRichPortal(ctx.app);
    assert.equal(a.grant.status, 201);

    const bClient = await request(ctx.app)
      .post("/api/clients")
      .set("Cookie", a.coachCookie)
      .send({ name: "Other", email: `other-n10-${Date.now()}@acme.com` });
    const bPortal = await provisionPortalClient(
      ctx.app,
      a.coachCookie,
      bClient.body.id,
      `n10-b-${Date.now()}@acme.com`,
    );
    assert.equal(bPortal.grant.status, 201);

    const homeB = await request(ctx.app)
      .get("/api/portal/home")
      .set("Cookie", bPortal.clientCookie);
    assert.equal(homeB.status, 200);
    assert.ok(!JSON.stringify(homeB.body).includes("360 summary for client eyes"));
  });

  it("coach session cannot use portal home", async () => {
    const p = await provisionRichPortal(ctx.app);
    const home = await request(ctx.app)
      .get("/api/portal/home")
      .set("Cookie", p.coachCookie);
    assert.ok(home.status === 403 || home.status === 401);
  });
});
