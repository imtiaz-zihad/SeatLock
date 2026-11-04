import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

// These tests go through the real Express app, the real raw-body handling and the real
// signature check. Only the database is replaced, so no database is needed.
vi.mock("../../lib/prisma.js", () => ({
  prisma: {
    $transaction: async (fn: (tx: unknown) => unknown) => fn({}),
    payment: { findUnique: vi.fn() },
  },
}));

vi.mock("./payment.core.js", () => ({
  processWebhookEvent: vi.fn(),
  initiatePayment: vi.fn(),
}));

import { app } from "../../app.js";
import { prisma } from "../../lib/prisma.js";
import * as core from "./payment.core.js";
import { isFakeProvider } from "./payment.providers.js";
import { getPaymentProvider } from "./payment.providers.js";

const provider = getPaymentProvider();
if (!isFakeProvider(provider)) throw new Error("these tests need the fake provider");

const data = { providerPaymentId: "fake_pay_1", amountCents: 5000, currency: "USD" };
const processWebhookEvent = vi.mocked(core.processWebhookEvent);

beforeEach(() => {
  vi.resetAllMocks();
});

describe("POST /webhooks/payments", () => {
  it("accepts a correctly signed webhook and passes the parsed event to the handler", async () => {
    processWebhookEvent.mockResolvedValue({ result: "processed", action: "confirmed" });
    const { body, signature } = provider.buildWebhook("payment.succeeded", data, "evt_route_1");

    const res = await request(app)
      .post("/webhooks/payments")
      .set("Content-Type", "application/json")
      .set("x-signature", signature)
      .send(body);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ received: true, result: "processed" });
    const call = processWebhookEvent.mock.calls[0]![1];
    expect(call.event).toMatchObject({ id: "evt_route_1", type: "payment.succeeded", ...data });
    expect(call.provider).toBe("fake");
  });

  it("rejects a body changed after signing and never reaches the handler", async () => {
    const { body, signature } = provider.buildWebhook("payment.succeeded", data);

    const res = await request(app)
      .post("/webhooks/payments")
      .set("Content-Type", "application/json")
      .set("x-signature", signature)
      .send(body.replace("5000", "1"));

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("INVALID_SIGNATURE");
    expect(processWebhookEvent).not.toHaveBeenCalled();
  });

  it("answers 200 for a duplicate so the provider stops retrying", async () => {
    processWebhookEvent.mockResolvedValue({ result: "duplicate" });
    const { body, signature } = provider.buildWebhook("payment.succeeded", data, "evt_dup");

    const res = await request(app)
      .post("/webhooks/payments")
      .set("Content-Type", "application/json")
      .set("x-signature", signature)
      .send(body);

    expect(res.status).toBe(200);
    expect(res.body.result).toBe("duplicate");
  });

  it("asks the provider for a refund when the handler says refund_required", async () => {
    const refund = vi.spyOn(provider, "refund");
    processWebhookEvent.mockResolvedValue({
      result: "processed",
      action: "refund_required",
      refund: { providerPaymentId: "fake_pay_1", amountCents: 5000 },
    });
    const { body, signature } = provider.buildWebhook("payment.succeeded", data, "evt_refund");

    const res = await request(app)
      .post("/webhooks/payments")
      .set("Content-Type", "application/json")
      .set("x-signature", signature)
      .send(body);

    expect(res.status).toBe(200);
    expect(refund).toHaveBeenCalledWith("fake_pay_1", 5000);
  });

  it("still answers 200 when the refund call fails (the payment is already marked REFUNDED)", async () => {
    vi.spyOn(provider, "refund").mockRejectedValue(new Error("provider down"));
    vi.spyOn(console, "error").mockImplementation(() => {});
    processWebhookEvent.mockResolvedValue({
      result: "processed",
      action: "refund_required",
      refund: { providerPaymentId: "fake_pay_1", amountCents: 5000 },
    });
    const { body, signature } = provider.buildWebhook("payment.succeeded", data, "evt_refund_fail");

    const res = await request(app)
      .post("/webhooks/payments")
      .set("Content-Type", "application/json")
      .set("x-signature", signature)
      .send(body);

    expect(res.status).toBe(200);
  });

  it("returns 500 (so the provider retries) when processing crashes", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    processWebhookEvent.mockRejectedValue(new Error("database down"));
    const { body, signature } = provider.buildWebhook("payment.succeeded", data, "evt_crash");

    const res = await request(app)
      .post("/webhooks/payments")
      .set("Content-Type", "application/json")
      .set("x-signature", signature)
      .send(body);

    expect(res.status).toBe(500);
    expect(res.body.error.code).toBe("INTERNAL_ERROR");
  });
});

describe("development helper /dev/payments/...", () => {
  it("builds a signed webhook for the payment and sends it through the normal handler", async () => {
    vi.mocked(prisma.payment.findUnique).mockResolvedValue({ amountCents: 5000, currency: "USD" } as never);
    processWebhookEvent.mockResolvedValue({ result: "processed", action: "confirmed" });

    const res = await request(app).post("/dev/payments/fake_pay_1/succeed").send({ eventId: "evt_manual_1" });

    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ result: "processed", action: "confirmed" });
    expect(processWebhookEvent.mock.calls[0]![1].event).toMatchObject({
      id: "evt_manual_1",
      type: "payment.succeeded",
      providerPaymentId: "fake_pay_1",
      amountCents: 5000,
    });
  });

  it("works with no body and the fail endpoint", async () => {
    vi.mocked(prisma.payment.findUnique).mockResolvedValue({ amountCents: 5000, currency: "USD" } as never);
    processWebhookEvent.mockResolvedValue({ result: "processed", action: "payment_failed" });

    const res = await request(app).post("/dev/payments/fake_pay_1/fail");

    expect(res.status).toBe(200);
    expect(processWebhookEvent.mock.calls[0]![1].event.type).toBe("payment.failed");
  });

  it("404 for a payment that does not exist", async () => {
    vi.mocked(prisma.payment.findUnique).mockResolvedValue(null as never);
    const res = await request(app).post("/dev/payments/nope/succeed");
    expect(res.status).toBe(404);
  });
});