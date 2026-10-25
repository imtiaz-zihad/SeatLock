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