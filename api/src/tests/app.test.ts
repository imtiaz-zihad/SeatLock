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

describe("tier and seat routes (no database needed)", () => {
  const eventId = "11111111-1111-4111-8111-111111111111";

  it("POST /events/:id/tiers without login is 401", async () => {
    const res = await request(app).post(`/events/${eventId}/tiers`).send({});
    expect(res.status).toBe(401);
  });

  it("POST /events/:id/seats/bulk without login is 401", async () => {
    const res = await request(app).post(`/events/${eventId}/seats/bulk`).send({});
    expect(res.status).toBe(401);
  });

  it("GET /events/not-a-uuid/seats is 400", async () => {
    const res = await request(app).get("/events/not-a-uuid/seats");
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("VALIDATION_ERROR");
  });

  it("GET /events/:id/seats?status=BROKEN is 400", async () => {
    const res = await request(app).get(`/events/${eventId}/seats?status=BROKEN`);
    expect(res.status).toBe(400);
  });

  it("GET /events/:id/tiers with a bad id is 400", async () => {
    const res = await request(app).get("/events/abc/tiers");
    expect(res.status).toBe(400);
  });
});

describe("booking routes (no database needed)", () => {
  const bookingId = "33333333-3333-4333-8333-333333333333";

  it("POST /bookings without login is 401", async () => {
    const res = await request(app).post("/bookings").send({});
    expect(res.status).toBe(401);
  });

  it("GET /bookings without login is 401", async () => {
    const res = await request(app).get("/bookings");
    expect(res.status).toBe(401);
  });

  it("GET /bookings/:id without login is 401", async () => {
    const res = await request(app).get(`/bookings/${bookingId}`);
    expect(res.status).toBe(401);
  });

  it("POST /bookings/:id/cancel without login is 401", async () => {
    const res = await request(app).post(`/bookings/${bookingId}/cancel`);
    expect(res.status).toBe(401);
  });
});

describe("payment routes (no database needed)", () => {
  const bookingId = "33333333-3333-4333-8333-333333333333";

  it("POST /bookings/:id/pay without login is 401", async () => {
    const res = await request(app).post(`/bookings/${bookingId}/pay`);
    expect(res.status).toBe(401);
  });

  it("webhook without a signature is 400 INVALID_SIGNATURE", async () => {
    const res = await request(app)
      .post("/webhooks/payments")
      .set("Content-Type", "application/json")
      .send(JSON.stringify({ id: "evt_1", type: "payment.succeeded" }));
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("INVALID_SIGNATURE");
  });

  it("webhook with a wrong signature is 400", async () => {
    const res = await request(app)
      .post("/webhooks/payments")
      .set("Content-Type", "application/json")
      .set("x-signature", `t=${Math.floor(Date.now() / 1000)},v1=${"a".repeat(64)}`)
      .send(JSON.stringify({ id: "evt_1", type: "payment.succeeded" }));
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("INVALID_SIGNATURE");
  });

  it("webhook that is not JSON content-type is 400", async () => {
    const res = await request(app).post("/webhooks/payments").set("Content-Type", "text/plain").send("hello");
    expect(res.status).toBe(400);
  });
});

describe("admin routes (no database needed)", () => {
  it("GET /admin/stats without login is 401", async () => {
    const res = await request(app).get("/admin/stats");
    expect(res.status).toBe(401);
  });

  it("GET /admin/audit-logs without login is 401", async () => {
    const res = await request(app).get("/admin/audit-logs");
    expect(res.status).toBe(401);
  });
});