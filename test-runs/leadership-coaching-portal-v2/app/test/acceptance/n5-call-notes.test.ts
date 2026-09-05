import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import request from "supertest";
import { freshApp, coachWithClient, provisionPortalClient } from "../helpers.js";

describe("N5 — call notes + opt-in share toggle", () => {
  const ctx = freshApp();
  after(() => ctx.cleanup());

  it("coach adds a note that defaults to private (sharedWithClient false)", async () => {
    const { coachCookie, clientId } = await coachWithClient(ctx.app, "notes");
    const create = await request(ctx.app)
      .post(`/api/clients/${clientId}/notes`)
      .set("Cookie", coachCookie)
      .send({
        body: "Discussed board presentation; practice Q&A.",
        callDate: "2026-07-15",
      });
    assert.equal(create.status, 201, JSON.stringify(create.body));
    assert.ok(create.body.id);
    assert.equal(create.body.sharedWithClient, false);

    const list = await request(ctx.app)
      .get(`/api/clients/${clientId}/notes`)
      .set("Cookie", coachCookie);
    assert.equal(list.status, 200);
    assert.equal(list.body.length, 1);
    assert.match(list.body[0].body, /board presentation/);
  });

  it("coach can toggle share on a note (opt-in sharing mechanism)", async () => {
    const { coachCookie, clientId } = await coachWithClient(ctx.app, "notes-share");
    const create = await request(ctx.app)
      .post(`/api/clients/${clientId}/notes`)
      .set("Cookie", coachCookie)
      .send({ body: "Shareable reflection", callDate: "2026-07-16" });
    assert.equal(create.status, 201);
    const noteId = create.body.id as string;

    const share = await request(ctx.app)
      .patch(`/api/clients/${clientId}/notes/${noteId}`)
      .set("Cookie", coachCookie)
      .send({ sharedWithClient: true });
    assert.equal(share.status, 200, JSON.stringify(share.body));
    assert.equal(share.body.sharedWithClient, true);

    const unshare = await request(ctx.app)
      .patch(`/api/clients/${clientId}/notes/${noteId}`)
      .set("Cookie", coachCookie)
      .send({ sharedWithClient: false });
    assert.equal(unshare.status, 200);
    assert.equal(unshare.body.sharedWithClient, false);
  });

  it("OBLIGATION O3: client cannot add notes via coach API", async () => {
    const { coachCookie, clientId } = await coachWithClient(ctx.app, "notes-role");
    const { grant, clientCookie } = await provisionPortalClient(
      ctx.app,
      coachCookie,
      clientId,
      `portal-notes-${Date.now()}@acme.com`,
    );
    if (grant.status !== 201) return;

    const create = await request(ctx.app)
      .post(`/api/clients/${clientId}/notes`)
      .set("Cookie", clientCookie)
      .send({ body: "forged", callDate: "2026-07-01" });
    assert.equal(create.status, 403);
  });
});
