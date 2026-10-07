import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { Principal } from "../src/account-auth";
import { attachAgent, resolveCrewSeats, setCrewSeat } from "../src/account-auth";
import { crewMessagePrompt, crewMessageTool, type CrewMessage } from "../src/crew-message-tool";

const runtime = env as Parameters<typeof attachAgent>[0];

describe("crew messages", () => {
  it("resolves unique account seats and retains stable crew identity", async () => {
    const ownerId = crypto.randomUUID();
    const kirbyId = crypto.randomUUID();
    const foxId = crypto.randomUUID();
    await attachAgent(runtime, ownerId, kirbyId);
    await attachAgent(runtime, ownerId, foxId);
    await setCrewSeat(runtime, ownerId, kirbyId, {
      crew_id: "remora", seat_name: "Kirby", role: "Coordinator",
    });
    await setCrewSeat(runtime, ownerId, foxId, {
      crew_id: "remora", seat_name: "Fox", role: "Designer and reviewer", coordinator_agent_id: kirbyId,
    });
    await expect(resolveCrewSeats(runtime, ownerId, kirbyId, "fox")).resolves.toEqual({
      source: { agent_id: kirbyId, crew_id: "remora", seat_name: "Kirby", role: "Coordinator" },
      target: { agent_id: foxId, crew_id: "remora", seat_name: "Fox", role: "Designer and reviewer", coordinator_agent_id: kirbyId },
    });
    const thirdId = crypto.randomUUID();
    await attachAgent(runtime, ownerId, thirdId);
    await expect(setCrewSeat(runtime, ownerId, thirdId, {
      crew_id: "remora", seat_name: "FOX", role: "Duplicate",
    })).rejects.toMatchObject({ status: 409 });
  });

  it("delivers a visible turn and returns the sender receipt", async () => {
    const ownerId = crypto.randomUUID();
    const source = { agent_id: crypto.randomUUID(), crew_id: "remora", seat_name: "Kirby", role: "Coordinator" };
    const target = { agent_id: crypto.randomUUID(), crew_id: "remora", seat_name: "Fox", role: "Designer" };
    const principal: Principal = {
      kind: "account_session", userId: ownerId, organizationId: crypto.randomUUID(), teamId: crypto.randomUUID(),
      role: "writer", subjectId: `user:${ownerId}`, credentialId: "test", authorizationEpoch: 1,
      capabilities: ["agents:read", "agents:write", "tools:use"],
    };
    let delivered: CrewMessage | undefined;
    const tool = crewMessageTool({
      sessionId: source.agent_id, ownerId, authorizationEpoch: 1, authorization: () => principal,
      resolve: async () => ({ source, target }), messageId: async () => "message-1",
      deliver: async message => { delivered = message; return { disposition: "accepted" }; },
    });
    const context = { sessionId: source.agent_id, turnId: "turn-1", callId: "call-1", parentCallId: "",
      model: "test", signal: new AbortController().signal };
    await expect(tool.handler({ to: "Fox", body: "Review change 122.", purpose: "Design review" }, context))
      .resolves.toMatchObject({ message_id: "message-1", from: "Kirby", to: "Fox", accepted: true });
    expect(crewMessagePrompt(delivered!)).toContain("Reply with send_message to \"Kirby\"");
    expect(crewMessagePrompt(delivered!)).toContain("Review change 122.");
    await expect(tool.handler({ to: "Fox", body: "Review", purpose: "Review" }, { ...context, subagent: {} } as typeof context))
      .rejects.toThrow(/root authorization/);
  });
});
