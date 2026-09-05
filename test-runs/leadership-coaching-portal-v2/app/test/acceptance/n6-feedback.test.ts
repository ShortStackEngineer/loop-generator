import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import request from "supertest";
import { freshApp, coachWithClient, provisionPortalClient } from "../helpers.js";

describe("N6 — feedback + share toggle", () => {
  const ctx = freshApp();
  after(() => ctx.cleanup());

  it("coach adds private feedback and can list it", async () => {
    const { coachCookie, clientId } = await coachWithClient(ctx.app, "fb");
    const create = await request(ctx.app)
      .post(`/api/clients/${clientId}/feedback`)
      .set("Cookie", coachCookie)
      .send({ body: "Peer: interrupts in meetings.", source: "peer-interview" });
    assert.equal(create.status, 201, JSON.stringify(create.body));
    assert.equal(create.body.sharedWithClient, false);

    const list = await request(ctx.app)
      .get(`/api/clients/${clientId}/feedback`)
      .set("Cookie", coachCookie);
    assert.equal(list.status, 200);
    assert.equal(list.body.length, 1);
    assert.match(list.body[0].body, /interrupts/);
  });

  it("coach can mark feedback sharedWithClient true", async () => {
    const { coachCookie, clientId } = await coachWithClient(ctx.app, "fb-share");
    const create = await request(ctx.app)
      .post(`/api/clients/${clientId}/feedback`)
      .set("Cookie", coachCookie)
      .send({ body: "Strength: calm under pressure", source: "skip-level" });
    assert.equal(create.status, 201);
    const id = create.body.id as string;

    const share = await request(ctx.app)
      .patch(`/api/clients/${clientId}/feedback/${id}`)
      .set("Cookie", coachCookie)
      .send({ sharedWithClient: true });
    assert.equal(share.status, 200);
    assert.equal(share.body.sharedWithClient, true);
  });

  it("OBLIGATION O3: client cannot post feedback via coach API", async () => {
    const { coachCookie, clientId } = await coachWithClient(ctx.app, "fb-role");
    const { grant, clientCookie } = await provisionPortalClient(
      ctx.app,
      coachCookie,
      clientId,
      `portal-fb-${Date.now()}@acme.com`,
    );
    if (grant.status !== 201) return;

    const create = await request(ctx.app)
      .post(`/api/clients/${clientId}/feedback`)
      .set("Cookie", clientCookie)
      .send({ body: "forged" });
    assert.equal(create.status, 403);
  });
});
