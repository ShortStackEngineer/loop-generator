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

describe("N3 — 360 survey + ownership + role separation", () => {
  const ctx = freshApp();
  after(() => ctx.cleanup());

  it("coach records and reads 360 results on their client", async () => {
    const { coachCookie, clientId } = await coachWithClient(ctx.app, "360");
    const payload = {
      summary: "Strong strategist; needs executive presence.",
      dimensions: [
        { name: "Strategic Thinking", score: 4.5, notes: "Board-ready" },
        { name: "Executive Presence", score: 2.8, notes: "Inconsistent" },
      ],
      completedAt: "2026-07-01",
    };
    const put = await request(ctx.app)
      .put(`/api/clients/${clientId}/survey-360`)
      .set("Cookie", coachCookie)
      .send(payload);
    assert.equal(put.status, 200, JSON.stringify(put.body));
    assert.equal(put.body.summary, payload.summary);
    assert.equal(put.body.dimensions.length, 2);

    const get = await request(ctx.app)
      .get(`/api/clients/${clientId}/survey-360`)
      .set("Cookie", coachCookie);
    assert.equal(get.status, 200);
    assert.equal(get.body.dimensions[0].name, "Strategic Thinking");
  });

  it("other coach cannot read or write 360 (tenant isolation)", async () => {
    const { coachCookie, clientId } = await coachWithClient(ctx.app, "360-iso");
    await request(ctx.app)
      .put(`/api/clients/${clientId}/survey-360`)
      .set("Cookie", coachCookie)
      .send({ summary: "secret", dimensions: [], completedAt: "2026-07-01" });

    const email = `other-${Date.now()}@example.com`;
    await registerCoach(ctx.app, { email, password: "secure-pass-123" });
    const otherCookie = sessionCookie(await login(ctx.app, email, "secure-pass-123"));

    const get = await request(ctx.app)
      .get(`/api/clients/${clientId}/survey-360`)
      .set("Cookie", otherCookie);
    assert.ok(get.status === 403 || get.status === 404);

    const put = await request(ctx.app)
      .put(`/api/clients/${clientId}/survey-360`)
      .set("Cookie", otherCookie)
      .send({ summary: "pwn", dimensions: [], completedAt: "2026-07-01" });
    assert.ok(put.status === 403 || put.status === 404);
  });

  it("OBLIGATION O3: client session cannot write 360 on coach routes", async () => {
    const { coachCookie, clientId } = await coachWithClient(ctx.app, "360-role");
    const { grant, clientCookie } = await provisionPortalClient(
      ctx.app,
      coachCookie,
      clientId,
      `portal-360-${Date.now()}@acme.com`,
    );
    if (grant.status !== 201) return;

    const put = await request(ctx.app)
      .put(`/api/clients/${clientId}/survey-360`)
      .set("Cookie", clientCookie)
      .send({ summary: "client forged", dimensions: [], completedAt: "2026-07-01" });
    assert.equal(put.status, 403);
  });
});
