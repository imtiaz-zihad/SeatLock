import request from "supertest";
import { describe, expect, it } from "vitest";
import { app } from "../app.js";

describe("API basics", () => {
  it("GET /health returns ok", async () => {
    const res = await request(app).get("/health");
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("ok");
  });

  it("Better Auth is mounted (GET /api/auth/ok)", async () => {
    const res = await request(app).get("/api/auth/ok");
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });
});

describe("error handling", () => {
  it("returns a JSON 404 for unknown routes", async () => {
    const res = await request(app).get("/nope");
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe("NOT_FOUND");
  });

  it("returns 400 for malformed JSON", async () => {
    const res = await request(app).post("/events").set("Content-Type", "application/json").send("{bad json");
    expect(res.status).toBe(400);
  });
});

describe("events routes (no database needed)", () => {
  it("POST /events without login is 401", async () => {
    const res = await request(app).post("/events").send({});
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe("UNAUTHORIZED");
  });

  it("GET /events/not-a-uuid is 400", async () => {
    const res = await request(app).get("/events/not-a-uuid");
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("VALIDATION_ERROR");
  });

  it("GET /events?limit=999 is 400", async () => {
    const res = await request(app).get("/events?limit=999");
    expect(res.status).toBe(400);
    expect(res.body.error.details[0].path).toBe("query.limit");
  });
});
