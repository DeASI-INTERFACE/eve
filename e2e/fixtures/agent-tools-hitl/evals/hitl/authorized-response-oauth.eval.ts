import { defineEval } from "eve/evals";

const MARKER = "authorized-response-oauth-e2e-R8N5";
const TOOL_NAME = "oauth-authorized-gate";

export default defineEval({
  tags: ["real-model"],
  description: "Approval response policy parks for fake OAuth, resumes, and settles.",
  async test(t) {
    const parked = await t.send(`Call the \`${TOOL_NAME}\` tool with marker "${MARKER}".`);
    const approval = t.requireInputRequest({ display: "confirmation", toolName: TOOL_NAME });
    const afterApproval = await t.respond({
      optionId: "approve",
      requestId: approval.requestId,
    });

    const required = afterApproval.events.find((event) => event.type === "authorization.required");
    if (
      required?.type !== "authorization.required" ||
      required.data.authorization?.url === undefined
    ) {
      throw new Error("Expected a fake OAuth authorization URL.");
    }
    afterApproval.event("approval.candidate", {
      data: { outcome: "pending", requestId: approval.requestId },
      count: 1,
    });
    afterApproval.event("authorization.required", { count: 1 });

    const startIndex = t.events.length;
    const callback = await t.target.fetch(required.data.authorization.url);
    if (!callback.ok) {
      throw new Error(`Fixture OAuth callback failed (${String(callback.status)}).`);
    }

    const resumed = await t.target.watchTurn(afterApproval.sessionId, { startIndex }).result();
    resumed.expectOk();
    resumed.event("authorization.completed", {
      data: { candidateId: required.data.candidateId, outcome: "authorized" },
      count: 1,
    });
    resumed.event("approval.settled", {
      data: { outcome: "approved", requestId: approval.requestId },
      count: 1,
    });
    resumed.event("action.result", {
      data: {
        result: {
          kind: "tool-result",
          output: new RegExp(MARKER),
          toolName: TOOL_NAME,
        },
        status: "completed",
      },
      count: 1,
    });
    t.succeeded();
  },
});
