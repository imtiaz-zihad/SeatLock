import { describe, expect, it } from "vitest";
import { FakePaymentProvider } from "./fake.provider.js";

const provider = new FakePaymentProvider("test-secret");
const data = { providerPaymentId: "fake_pay_1", amountCents: 5000, currency: "USD" };

describe("FakePaymentProvider webhooks", () => {
  it("accepts a correctly signed webhook", () => {
    const { body, signature } = provider.buildWebhook("payment.succeeded", data, "evt_1");
    const event = provider.verifyWebhook(Buffer.from(body), signature, new Date());

    expect(event).toMatchObject({ id: "evt_1", type: "payment.succeeded", ...data });
  });

  it("rejects a missing signature", () => {
    const { body } = provider.buildWebhook("payment.succeeded", data);
    expect(() => provider.verifyWebhook(Buffer.from(body), undefined, new Date())).toThrowError(
      expect.objectContaining({ status: 400, code: "INVALID_SIGNATURE" }),
    );
  });

  it("rejects a malformed signature header", () => {
    const { body } = provider.buildWebhook("payment.succeeded", data);
    expect(() => provider.verifyWebhook(Buffer.from(body), "garbage", new Date())).toThrowError(
      expect.objectContaining({ code: "INVALID_SIGNATURE" }),
    );
  });

  it("rejects a body that was changed after signing (amount tampering)", () => {
    const { body, signature } = provider.buildWebhook("payment.succeeded", data);
    const tampered = body.replace("5000", "1");
    expect(() => provider.verifyWebhook(Buffer.from(tampered), signature, new Date())).toThrowError(
      expect.objectContaining({ code: "INVALID_SIGNATURE" }),
    );
  });

  it("rejects a signature made with a different secret", () => {
    const other = new FakePaymentProvider("another-secret");
    const { body, signature } = other.buildWebhook("payment.succeeded", data);
    expect(() => provider.verifyWebhook(Buffer.from(body), signature, new Date())).toThrowError(
      expect.objectContaining({ code: "INVALID_SIGNATURE" }),
    );
  });

  it("rejects an old signature (replay protection)", () => {
    const tenMinutesAgo = new Date(Date.now() - 10 * 60 * 1000);
    const { body, signature } = provider.buildWebhook("payment.succeeded", data, "evt_old", tenMinutesAgo);
    expect(() => provider.verifyWebhook(Buffer.from(body), signature, new Date())).toThrowError(
      expect.objectContaining({ code: "INVALID_SIGNATURE" }),
    );
  });

  it("rejects a validly signed body that is not JSON", () => {
    const body = "not json";
    expect(() => provider.verifyWebhook(Buffer.from(body), provider.sign(body), new Date())).toThrowError(
      expect.objectContaining({ code: "INVALID_PAYLOAD" }),
    );
  });

  it("rejects a validly signed body with the wrong shape", () => {
    const body = JSON.stringify({ id: "evt_x", type: "payment.refunded", data: {} });
    expect(() => provider.verifyWebhook(Buffer.from(body), provider.sign(body), new Date())).toThrowError(
      expect.objectContaining({ code: "INVALID_PAYLOAD" }),
    );
  });

  it("createPayment returns an id and dev checkout links", async () => {
    const created = await provider.createPayment({ bookingId: "b1", amountCents: 100, currency: "USD" });
    expect(created.providerPaymentId).toMatch(/^fake_pay_/);
    expect(created.checkout).toMatchObject({ type: "fake" });
  });
});