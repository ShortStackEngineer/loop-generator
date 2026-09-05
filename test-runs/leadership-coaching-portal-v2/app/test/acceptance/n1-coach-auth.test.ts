import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import request from "supertest";
import { freshApp, registerCoach, login, sessionCookie } from "../helpers.js";

describe("N1 — coach register / login / me + safe errors", () => {
  const ctx = freshApp();
  after(() => ctx.cleanup());

  it("registers a coach (201) without leaking password material", async () => {
    const { res, body } = await registerCoach(ctx.app, {
      email: "coach@example.com",
      password: "secure-pass-123",
      name: "Ada Coach",
    });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    assert.equal(res.body.email, body.email);
    assert.equal(res.body.name, body.name);
    assert.equal(res.body.role, "coach");
    assert.ok(res.body.id);
    assert.equal(res.body.password, undefined);
    assert.equal(res.body.passwordHash, undefined);
    const blob = JSON.stringify(res.body);
    assert.ok(!blob.includes("secure-pass-123"));
  });

  it("logs in with a session cookie; GET /api/me returns the coach", async () => {
    const email = "login-coach@example.com";
    const password = "secure-pass-123";
    assert.equal((await registerCoach(ctx.app, { email, password })).res.status, 201);

    const loginRes = await login(ctx.app, email, password);
    assert.equal(loginRes.status, 200);
    const cookie = sessionCookie(loginRes);
    assert.ok(cookie.length > 0);

    const me = await request(ctx.app).get("/api/me").set("Cookie", cookie);
    assert.equal(me.status, 200);
    assert.equal(me.body.email, email);
    assert.equal(me.body.role, "coach");
  });

  it("login is case-insensitive on email", async () => {
    const password = "secure-pass-123";
    assert.equal(
      (await registerCoach(ctx.app, { email: "CaseUser@Example.COM", password })).res
        .status,
      201,
    );
    const loginRes = await login(ctx.app, "caseuser@example.com", password);
    assert.equal(loginRes.status, 200, "email match must ignore case");
  });

  it("GET /api/me without session returns 401", async () => {
    assert.equal((await request(ctx.app).get("/api/me")).status, 401);
  });

  it("duplicate email (case-insensitive) returns 409", async () => {
    assert.equal(
      (await registerCoach(ctx.app, { email: "dup@example.com", password: "secure-pass-123" }))
        .res.status,
      201,
    );
    const second = await registerCoach(ctx.app, {
      email: "DUP@example.com",
      password: "other-pass-456",
    });
    assert.equal(second.res.status, 409);
  });

  it("wrong password returns 401 and never echoes the password", async () => {
    const email = "wrong-pw@example.com";
    await registerCoach(ctx.app, { email, password: "secure-pass-123" });
    const res = await login(ctx.app, email, "nope-wrong");
    assert.equal(res.status, 401);
    assert.ok(!JSON.stringify(res.body).includes("nope-wrong"));
    assert.ok(!JSON.stringify(res.body).includes("secure-pass-123"));
  });

  it("malformed JSON body on register returns 400 (not 500)", async () => {
    const res = await request(ctx.app)
      .post("/api/auth/register")
      .set("Content-Type", "application/json")
      .send('{"email": "x@y.com",'); // truncated JSON
    assert.equal(res.status, 400, `expected 400 for bad JSON, got ${res.status}`);
  });
});
