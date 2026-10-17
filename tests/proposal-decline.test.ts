import { describe, expect, test } from "bun:test";
import { createApi } from "../src/server/api";
import { proposalSchema } from "../src/shared/contracts";
import { createTestHarness } from "./support/test-mail";

describe("declining proposals", () => {
  test("the person declines a waiting proposal; it is final and changes no mail", async () => {
    const { store, service, account, messages } = await createTestHarness();
    const app = createApi(service);
    const message = messages[0]!;
    const proposal = await service.createProposal({
      accountId: account.id, title: "Tidy",
      items: [{ id: "i1", message: message.ref, subject: message.subject, action: { type: "trash" }, reason: "" }],
    });
    const declined = await app.request(`/api/proposals/${proposal.id}/decline`, { method: "POST" });
    expect(declined.status).toBe(200);
    expect(proposalSchema.parse(await declined.json())).toMatchObject({ status: "declined", approvedAt: null, batchId: null });
    expect(await service.listBatches(account.id)).toEqual([]);

    const again = await app.request(`/api/proposals/${proposal.id}/decline`, { method: "POST" });
    expect(await again.json()).toEqual({ error: "Only a waiting proposal can be declined" });
    expect((await app.request(`/api/proposals/${proposal.id}/approve`, { method: "POST" })).status).toBe(400);
    await expect(service.updateProposal(proposal.id, { status: "review" })).rejects.toThrow("Only draft or review proposals can be edited");
    store.close();
  });
});
