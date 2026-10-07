import type { NamedTool, ToolContext } from "nanocodex";
import type { Principal } from "./account-auth";

const SEAT_NAME = /^[A-Za-z][A-Za-z0-9 _-]{0,63}$/;
const PURPOSE_LIMIT = 160;
const BODY_LIMIT = 32_000;
const REPLY_ID = /^[A-Za-z0-9._:-]{1,128}$/;

export type CrewSeat = Readonly<{
  agent_id: string;
  crew_id: string;
  seat_name: string;
  role: string;
  coordinator_agent_id?: string;
}>;

export type CrewMessage = Readonly<{
  message_id: string;
  source: CrewSeat;
  target: CrewSeat;
  body: string;
  purpose: string;
  in_reply_to?: string;
}>;

export function crewMessageInput(value: unknown): Readonly<{
  to: string;
  body: string;
  purpose: string;
  inReplyTo?: string;
}> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError("Expected a crew message");
  const input = value as Record<string, unknown>;
  if (Object.keys(input).some(key => !["to", "body", "purpose", "in_reply_to"].includes(key))
    || typeof input.to !== "string" || !SEAT_NAME.test(input.to)
    || typeof input.body !== "string" || input.body.trim().length === 0 || input.body.length > BODY_LIMIT
    || typeof input.purpose !== "string" || input.purpose.trim().length === 0 || input.purpose.length > PURPOSE_LIMIT
    || (input.in_reply_to !== undefined && (typeof input.in_reply_to !== "string" || !REPLY_ID.test(input.in_reply_to)))) {
    throw new TypeError("Invalid crew message");
  }
  return {
    to: input.to.trim(),
    body: input.body,
    purpose: input.purpose.trim(),
    ...(input.in_reply_to === undefined ? {} : { inReplyTo: input.in_reply_to }),
  };
}

export function crewMessagePrompt(message: CrewMessage): string {
  return [
    `Crew message ${message.message_id}`,
    `From: ${message.source.seat_name}`,
    `Crew: ${message.source.crew_id}`,
    `Purpose: ${message.purpose}`,
    ...(message.in_reply_to ? [`In reply to: ${message.in_reply_to}`] : []),
    "",
    message.body,
    "",
    `Reply with send_message to \"${message.source.seat_name}\". Set in_reply_to to \"${message.message_id}\".`,
  ].join("\n");
}

export function crewMessageTool(options: {
  sessionId: string;
  ownerId: string;
  authorizationEpoch: number;
  authorization(context: ToolContext): Principal | undefined;
  resolve(sourceAgentId: string, targetSeatName: string): Promise<Readonly<{ source: CrewSeat; target: CrewSeat }>>;
  messageId(context: ToolContext): Promise<string>;
  deliver(message: CrewMessage, principal: Principal, context: ToolContext): Promise<Record<string, unknown>>;
}): NamedTool {
  return {
    name: "send_message",
    description: "Send a durable message to a named peer in this agent's crew. The message appears as a user turn in the peer conversation. The result is the sender's delivery receipt. Use in_reply_to when replying to a crew message. Direct account root agent only; unavailable to child agents, Connect grants, and shared guests.",
    parameters: { type: "object", additionalProperties: false, required: ["to", "body", "purpose"], properties: {
      to: { type: "string", pattern: SEAT_NAME.source, description: "The recipient seat name." },
      body: { type: "string", minLength: 1, maxLength: BODY_LIMIT, description: "The message body." },
      purpose: { type: "string", minLength: 1, maxLength: PURPOSE_LIMIT, description: "A short reason for the message." },
      in_reply_to: { type: "string", pattern: REPLY_ID.source, description: "The prior crew message ID." },
    } },
    handler: async (value: unknown, context: ToolContext) => {
      context.signal.throwIfAborted();
      const principal = options.authorization(context);
      if (context.subagent !== undefined || !principal
        || principal.connectGrant !== undefined || principal.userId !== options.ownerId
        || principal.authorizationEpoch !== options.authorizationEpoch
        || !principal.capabilities.includes("agents:read")
        || !principal.capabilities.includes("agents:write")
        || !principal.capabilities.includes("tools:use")) {
        throw new Error("Crew messages require current direct account root authorization");
      }
      const input = crewMessageInput(value);
      const seats = await options.resolve(options.sessionId, input.to);
      if (seats.target.agent_id === options.sessionId) throw new TypeError("The recipient must be another crew seat");
      const message: CrewMessage = {
        message_id: await options.messageId(context),
        source: seats.source,
        target: seats.target,
        body: input.body,
        purpose: input.purpose,
        ...(input.inReplyTo === undefined ? {} : { in_reply_to: input.inReplyTo }),
      };
      const delivery = await options.deliver(message, principal, context);
      return {
        message_id: message.message_id,
        from: message.source.seat_name,
        to: message.target.seat_name,
        target_agent_id: message.target.agent_id,
        accepted: true,
        ...delivery,
      };
    },
  };
}
