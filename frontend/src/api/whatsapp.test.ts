import { describe, expect, it } from "vitest";
import { canRetry, consentTone, needsDeliveryCheck, problemOf, statusTone } from "./whatsapp";

describe("whatsapp helpers", () => {
  it("maps delivery status to a tone", () => {
    expect(statusTone("Delivered")).toBe("good");
    expect(statusTone("Read")).toBe("good");
    expect(statusTone("Sent")).toBe("info");
    expect(statusTone("Failed")).toBe("danger");
    expect(statusTone("Queued")).toBe("warn");
    expect(statusTone("Skipped")).toBe("warn");
  });

  it("maps consent to a tone", () => {
    expect(consentTone("Explicit Consent")).toBe("good");
    expect(consentTone("Withdrawn")).toBe("danger");
    expect(consentTone("Not Recorded")).toBe("neutral");
  });

  it("shows the right reason and allows retry only for Failed or Skipped", () => {
    expect(problemOf({ status: "Failed", last_error: "boom", skip_reason: null })).toBe("boom");
    expect(problemOf({ status: "Skipped", last_error: null, skip_reason: "no number" })).toBe("no number");
    expect(problemOf({ status: "Sent", last_error: "old", skip_reason: null })).toBeNull();
    expect(canRetry({ status: "Failed" })).toBe(true);
    expect(canRetry({ status: "Read" })).toBe(false);
  });

  it("recognises the lost-answer message", () => {
    expect(needsDeliveryCheck("The provider's answer was lost and the message may have reached the learner.")).toBe(true);
    expect(needsDeliveryCheck("There is no WhatsApp number on file")).toBe(false);
  });
});
