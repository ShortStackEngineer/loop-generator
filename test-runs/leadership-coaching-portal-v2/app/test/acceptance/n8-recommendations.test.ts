import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import request from "supertest";
import { freshApp, coachWithClient, provisionPortalClient } from "../helpers.js";

describe("N8 — resource recommendations", () => {
  const ctx = freshApp();
  after(() => ctx.cleanup());

  it("coach adds book and podcast recommendations", async () => {
    const { coachCookie, clientId } = await coachWithClient(ctx.app, "recs");
    const book = await request(ctx.app)
      .post(`/api/clients/${clientId}/recommendations`)
      .set("Cookie", coachCookie)
      .send({
        title: "The Culture Code",
        type: "book",
        url: "https://example.com/culture-code",
        notes: "Ch. 3–5 for belonging cues",
      });
    assert.equal(book.status, 201, JSON.stringify(book.body));
    assert.equal(book.body.type, "book");

    const podcast = await request(ctx.app)
      .post(`/api/clients/${clientId}/recommendations`)
      .set("Cookie", coachCookie)
      .send({ title: "Coaching for Leaders", type: "podcast" });
    assert.equal(podcast.status, 201);

    const list = await request(ctx.app)
      .get(`/api/clients/${clientId}/recommendations`)
      .set("Cookie", coachCookie);
    assert.equal(list.status, 200);
    assert.equal(list.body.length, 2);
  });

  it("rejects invalid recommendation type with 400", async () => {
    const { coachCookie, clientId } = await coachWithClient(ctx.app, "recs-bad");
    const bad = await request(ctx.app)
      .post(`/api/clients/${clientId}/recommendations`)
      .set("Cookie", coachCookie)
      .send({ title: "Nope", type: "scroll" });
    assert.equal(bad.status, 400);
  });

  it("OBLIGATION O3: client cannot add recommendations via coach API", async () => {
    const { coachCookie, clientId } = await coachWithClient(ctx.app, "recs-role");
    const { grant, clientCookie } = await provisionPortalClient(
      ctx.app,
      coachCookie,
      clientId,
      `portal-recs-${Date.now()}@acme.com`,
    );
    if (grant.status !== 201) return;

    const post = await request(ctx.app)
      .post(`/api/clients/${clientId}/recommendations`)
      .set("Cookie", clientCookie)
      .send({ title: "forged", type: "book" });
    assert.equal(post.status, 403);
  });
});
