import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import request from "supertest";
import { freshApp, coachWithClient, provisionPortalClient } from "../helpers.js";

describe("N7 — coaching plan", () => {
  const ctx = freshApp();
  after(() => ctx.cleanup());

  it("coach authors a plan with goals and actions", async () => {
    const { coachCookie, clientId } = await coachWithClient(ctx.app, "plan");
    const plan = {
      goals: [
        { title: "Lead Q3 strategy offsite", status: "active" },
        { title: "Improve 1:1 cadence", status: "active" },
      ],
      actions: [
        { title: "Draft narrative for offsite", dueDate: "2026-08-01" },
        { title: "Book weekly 1:1s with directs", dueDate: "2026-07-20" },
      ],
    };
    const put = await request(ctx.app)
      .put(`/api/clients/${clientId}/plan`)
      .set("Cookie", coachCookie)
      .send(plan);
    assert.equal(put.status, 200, JSON.stringify(put.body));
    assert.equal(put.body.goals.length, 2);

    const get = await request(ctx.app)
      .get(`/api/clients/${clientId}/plan`)
      .set("Cookie", coachCookie);
    assert.equal(get.status, 200);
    assert.equal(get.body.goals[0].title, "Lead Q3 strategy offsite");
  });

  it("OBLIGATION O3: client cannot author plan via coach API", async () => {
    const { coachCookie, clientId } = await coachWithClient(ctx.app, "plan-role");
    const { grant, clientCookie } = await provisionPortalClient(
      ctx.app,
      coachCookie,
      clientId,
      `portal-plan-${Date.now()}@acme.com`,
    );
    if (grant.status !== 201) return;

    const put = await request(ctx.app)
      .put(`/api/clients/${clientId}/plan`)
      .set("Cookie", clientCookie)
      .send({ goals: [{ title: "hack", status: "active" }], actions: [] });
    assert.equal(put.status, 403);
  });
});
