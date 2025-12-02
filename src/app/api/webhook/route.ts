import OpenAI from "openai";
import { and, eq, not } from "drizzle-orm";
import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";

import type {
  MessageNewEvent,
  CallEndedEvent,
  CallTranscriptionReadyEvent,
  CallRecordingReadyEvent,
  CallSessionParticipantLeftEvent,
  CallSessionStartedEvent,
} from "@stream-io/node-sdk";

import { db } from "@/db";
import { agents, meetings } from "@/db/schema";
import { streamVideo } from "@/lib/stream-video";
import { streamChat } from "@/lib/stream-chat";
import { inngest } from "@/inngest/client";
import { generateAvatarUri } from "@/lib/avatar";
import type { ChatCompletionMessageParam } from "openai/resources/index.mjs";

const openaiClient = new OpenAI({ apiKey: process.env.OPENAI_API_KEY! });

export const runtime = "nodejs";

/* =====================================================
   TYPES
====================================================== */

interface StreamCall {
  updateCall?: (args: {
    members: { user_id: string; role: string }[];
  }) => Promise<unknown>;
}

interface StreamMessage {
  text?: string | null;
  user?: { id?: string };
}

type WebhookPayload = {
  type?: string;
  call_cid?: string;
  [key: string]: unknown;
};

/* =====================================================
   HELPERS
====================================================== */

function verifySignature(body: string, signature: string): boolean {
  try {
    return streamVideo.verifyWebhook(body, signature);
  } catch (err) {
    console.error("verifySignature error:", err);
    return false;
  }
}

function hasUpdateCall(
  call: StreamCall
): call is Required<Pick<StreamCall, "updateCall">> {
  return typeof call.updateCall === "function";
}

/* =====================================================
   POST: MAIN WEBHOOK HANDLER
====================================================== */

export async function POST(req: NextRequest) {
  const rawBody = await req.text();

  const signature =
    req.headers.get("x-signature") ?? req.headers.get("x-stream-signature");

  if (!signature) {
    console.warn("Webhook missing signature header");
    return NextResponse.json({ error: "Missing signature" }, { status: 400 });
  }

  if (!verifySignature(rawBody, signature)) {
    console.warn("Webhook signature verification failed");
    return NextResponse.json({ error: "Invalid signature" }, { status: 401 });
  }

  let payload: WebhookPayload;
  try {
    payload = JSON.parse(rawBody) as WebhookPayload;
  } catch (err) {
    console.error("Webhook JSON parse error:", err);
    return NextResponse.json({ error: "Bad JSON" }, { status: 400 });
  }

  const eventType = payload.type as string | undefined;
  console.log("📦 Webhook Event:", eventType);

  try {
    /* =====================================================
       1) CALL SESSION STARTED → MARK ACTIVE + ADD AGENT
    ====================================================== */
    if (eventType === "call.session_started") {
      const event = payload as unknown as CallSessionStartedEvent;
      const meetingId = event.call?.custom?.meetingId as string | undefined;

      console.log("🔔 call.session_started for meeting:", meetingId);

      if (!meetingId) {
        console.log("No meetingId on call.custom; ignoring.");
        return NextResponse.json({ ok: true });
      }

      // Find meeting that isn't completed / active / cancelled / processing
      const [meeting] = await db
        .select()
        .from(meetings)
        .where(
          and(
            eq(meetings.id, meetingId),
            not(eq(meetings.status, "completed")),
            not(eq(meetings.status, "active")),
            not(eq(meetings.status, "cancelled")),
            not(eq(meetings.status, "processing"))
          )
        );

      if (!meeting) {
        console.log("No matching meeting found or already finished:", meetingId);
        return NextResponse.json({ ok: true });
      }

      // Mark meeting as active
      await db
        .update(meetings)
        .set({ status: "active", startedAt: new Date() })
        .where(eq(meetings.id, meetingId));

      console.log("✅ Meeting marked active:", meetingId);

      // Fetch agent
      const [agent] = await db
        .select()
        .from(agents)
        .where(eq(agents.id, meeting.agentId));

      if (!agent) {
        console.log("No agent found for meeting:", meetingId);
        return NextResponse.json({ ok: true });
      }

      // Upsert agent user into Stream Video
      const avatarUrl = generateAvatarUri({
        seed: agent.name,
        variant: "botttsNeutral",
      });

      await streamVideo.upsertUsers([
        {
          id: agent.id,
          name: agent.name,
          role: "video-agent",
          image: avatarUrl,
        },
      ]);

      console.log("👤 Agent user upserted into Stream Video:", agent.id);

      // Add agent as call member
      const call = streamVideo.video.call(
        "default",
        meetingId
      ) as unknown as StreamCall;

      if (hasUpdateCall(call)) {
        try {
          await call.updateCall({
            members: [
              {
                user_id: agent.id,
                role: "video-agent",
              },
            ],
          });
          console.log("➕ Agent added as call member:", agent.id);
        } catch (err) {
          console.error("updateCall error when adding agent:", err);
        }
      } else {
        console.warn(
          "⚠ call.updateCall is not available on this Stream SDK version"
        );
      }

      return NextResponse.json({ ok: true });
    }

    /* =====================================================
       2) PARTICIPANT LEFT → END CALL
    ====================================================== */
    if (eventType === "call.session_participant_left") {
      const event = payload as unknown as CallSessionParticipantLeftEvent;
      const callCid = event.call_cid as string | undefined;

      console.log("👋 call.session_participant_left, callCid:", callCid);

      const meetingId =
        callCid && callCid.includes(":") ? callCid.split(":")[1] : undefined;

      if (meetingId) {
        try {
          await streamVideo.video.call("default", meetingId).end();
          console.log("📞 Call ended after participant left:", meetingId);
        } catch (err) {
          console.error("Error ending call on participant left:", err);
        }
      }

      return NextResponse.json({ ok: true });
    }

    /* =====================================================
       3) CALL ENDED → UPDATE DB
    ====================================================== */
    if (eventType === "call.session_ended") {
      const event = payload as unknown as CallEndedEvent;
      const meetingId = event.call?.custom?.meetingId as string | undefined;

      console.log("🛑 call.session_ended for meeting:", meetingId);

      if (meetingId) {
        await db
          .update(meetings)
          .set({ status: "processing", endedAt: new Date() })
          .where(and(eq(meetings.id, meetingId), eq(meetings.status, "active")));
      }

      return NextResponse.json({ ok: true });
    }

    /* =====================================================
       4) TRANSCRIPTION READY → SAVE URL & TRIGGER INGEST
    ====================================================== */
    if (eventType === "call.transcription_ready") {
      const event = payload as unknown as CallTranscriptionReadyEvent;
      const meetingId = event.call_cid?.split(":")[1];

      console.log("📝 call.transcription_ready for meeting:", meetingId);

      if (meetingId) {
        const [row] = await db
          .update(meetings)
          .set({ transcriptUrl: event.call_transcription?.url ?? null })
          .where(eq(meetings.id, meetingId))
          .returning();

        if (row) {
          await inngest.send({
            name: "meetings/processing",
            data: {
              meetingId: row.id,
              transcriptUrl: row.transcriptUrl,
            },
          });
          console.log("📤 Inngest processing triggered for meeting:", row.id);
        }
      }

      return NextResponse.json({ ok: true });
    }

    /* =====================================================
       5) RECORDING READY → SAVE URL
    ====================================================== */
    if (eventType === "call.recording_ready") {
      const event = payload as unknown as CallRecordingReadyEvent;
      const meetingId = event.call_cid?.split(":")[1];

      console.log("🎥 call.recording_ready for meeting:", meetingId);

      if (meetingId) {
        await db
          .update(meetings)
          .set({ recordingUrl: event.call_recording?.url ?? null })
          .where(eq(meetings.id, meetingId));
      }

      return NextResponse.json({ ok: true });
    }

    /* =====================================================
       6) CHAT MESSAGE → TEXT AI AGENT RESPONSE
    ====================================================== */
    if (eventType === "message.new") {
      const event = payload as unknown as MessageNewEvent;

      const userId = event.user?.id;
      const channelId = event.channel_id;
      const text = (event.message?.text ?? "").trim();

      console.log("💬 message.new on channel:", channelId, "from:", userId);

      if (!userId || !channelId || !text) {
        console.log("Missing userId, channelId or text; ignoring.");
        return NextResponse.json({ ok: true });
      }

      const [meeting] = await db
        .select()
        .from(meetings)
        .where(eq(meetings.id, channelId));

      if (!meeting) {
        console.log("No meeting found for channel:", channelId);
        return NextResponse.json({ ok: true });
      }

      const [agent] = await db
        .select()
        .from(agents)
        .where(eq(agents.id, meeting.agentId));

      if (!agent) {
        console.log("No agent found for meeting:", meeting.id);
        return NextResponse.json({ ok: true });
      }

      // Do not respond to own messages
      if (userId === agent.id) {
        return NextResponse.json({ ok: true });
      }

      const channel = streamChat.channel("messaging", channelId);
      await channel.watch();

      const messages = (channel.state.messages ?? []) as StreamMessage[];

      const previousMessages: ChatCompletionMessageParam[] = messages
        .slice(-5)
        .filter((m) => m.text && m.text.trim())
        .map((m) => ({
          role: m.user?.id === agent.id ? "assistant" : "user",
          content: m.text ?? "",
        }));

      const completion = await openaiClient.chat.completions.create({
        model: "gpt-4o",
        messages: [
          {
            role: "system",
            content:
              agent.instructions ||
              "You are a helpful assistant in this chat channel.",
          },
          ...previousMessages,
          { role: "user", content: text },
        ],
      });

      const reply = completion.choices?.[0]?.message?.content ?? "";

      if (reply) {
        const avatar = generateAvatarUri({
          seed: agent.name,
          variant: "botttsNeutral",
        });

        await streamChat.upsertUser({
          id: agent.id,
          name: agent.name,
          image: avatar,
        });

        await channel.sendMessage({
          text: reply,
          user: { id: agent.id, name: agent.name, image: avatar },
        });

        console.log("🤖 Agent replied in chat on channel:", channelId);
      }

      return NextResponse.json({ ok: true });
    }

    /* =====================================================
       7) FALLBACK: UNKNOWN EVENT
    ====================================================== */
    console.log("Unhandled webhook event type:", eventType);
    return NextResponse.json({ ok: true });
  } catch (err) {
    console.error("🔥 WEBHOOK ERROR:", err);
    return NextResponse.json({ error: "Server error" }, { status: 500 });
  }
}

/* =====================================================
   PUT: DEV TESTING
====================================================== */

export async function PUT(req: NextRequest) {
  const raw = await req.text();
  let body: Record<string, unknown> = {};

  try {
    body = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    // non-JSON is fine for test
  }

  try {
    await inngest.send({ name: "webhook/put", data: body });
    return NextResponse.json({ ok: true });
  } catch (err) {
    console.error("PUT /api/webhook error:", err);
    return NextResponse.json({ error: "Failed" }, { status: 500 });
  }
}
