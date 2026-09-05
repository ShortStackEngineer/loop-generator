import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import request from "supertest";
import { freshApp, coachWithClient, provisionPortalClient } from "../helpers.js";

describe("N4 — focus areas", () => {
  const ctx = freshApp();
  after(() => ctx.cleanup());

  it("coach sets and reads focus areas", async () => {
    const { coachCookie, clientId } = await coachWithClient(ctx.app, "focus");
    const areas = [
      { title: "Executive presence", priority: 1 },
      { title: "Stakeholder influence", priority: 2 },
    ];
    const put = await request(ctx.app)
      .put(`/api/clients/${clientId}/focus-areas`)
      .set("Cookie", coachCookie)
      .send({ areas });
    assert.equal(put.status, 200, JSON.stringify(put.body));
    assert.equal(put.body.areas.length, 2);

    const get = await request(ctx.app)
      .get(`/api/clients/${clientId}/focus-areas`)
      .set("Cookie", coachCookie);
    assert.equal(get.status, 200);
    assert.equal(get.body.areas[0].title, "Executive presence");
  });

  it("OBLIGATION O3: client cannot set focus areas via coach API", async () => {
    const { coachCookie, clientId } = await coachWithClient(ctx.app, "focus-role");
    const { grant, clientCookie } = await provisionPortalClient(
      ctx.app,
      coachCookie,
      clientId,
      `portal-focus-${Date.now()}@acme.com`,
    );
    if (grant.status !== 201) return;

    const put = await request(ctx.app)
      .put(`/api/clients/${clientId}/focus-areas`)
      .set("Cookie", clientCookie)
      .send({ areas: [{ title: "hack", priority: 1 }] });
    assert.equal(put.status, 403);
  });
});
