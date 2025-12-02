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

/* -------------------------------
   TYPES
-------------------------------- */

type WebhookPayload =
  | CallSessionStartedEvent
  | CallSessionParticipantLeftEvent
  | CallEndedEvent
  | CallTranscriptionReadyEvent
  | CallRecordingReadyEvent
  | MessageNewEvent
  | { type?: string; [key: string]: unknown };

interface StreamMessage {
  text?: string | null;
  user?: { id?: string };
}

/* -------------------------------
   VERIFY SIGNATURE
-------------------------------- */

function verifySignature(body: string, signature: string): boolean {
  try {
    return streamVideo.verifyWebhook(body, signature);
  } catch (err) {
    console.error("verifySignature error:", err);
    return false;
  }
}

/* -------------------------------
   WEBHOOK POST ROUTE
-------------------------------- */

export async function POST(req: NextRequest) {
  const rawBody = await req.text();

  const signature =
    req.headers.get("x-signature") ?? req.headers.get("x-stream-signature");

  if (!signature) {
    console.warn("[Webhook] Missing signature header");
    return NextResponse.json({ error: "Missing signature" }, { status: 400 });
  }

  if (!verifySignature(rawBody, signature)) {
    console.warn("[Webhook] Invalid signature");
    return NextResponse.json({ error: "Invalid signature" }, { status: 401 });
  }

  let payload: WebhookPayload;
  try {
    payload = JSON.parse(rawBody) as WebhookPayload;
  } catch {
    console.error("[Webhook] Bad JSON");
    return NextResponse.json({ error: "Bad JSON" }, { status: 400 });
  }

  const eventType = (payload as { type?: string }).type ?? "unknown";
  console.log("📦 [Webhook] EVENT:", eventType);

  try {
    /* -------------------------------
       CALL SESSION STARTED
    -------------------------------- */
    if (eventType === "call.session_started") {
      const event = payload as unknown as CallSessionStartedEvent;
      const meetingId = event.call?.custom?.meetingId as string | undefined;

      console.log("[Webhook] call.session_started, meetingId:", meetingId);

      if (!meetingId) {
        console.warn("[Webhook] Missing meetingId in call.custom");
        return NextResponse.json({ ok: true });
      }

      // Find meeting that is not already done/active/cancelled
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
        console.warn("[Webhook] Meeting not found or already processed:", meetingId);
        return NextResponse.json({ ok: true });
      }

      // Mark as active
      await db
        .update(meetings)
        .set({ status: "active", startedAt: new Date() })
        .where(eq(meetings.id, meetingId));

      console.log("[Webhook] Meeting marked active:", meetingId);

      // Fetch agent from DB
      const [agent] = await db
        .select()
        .from(agents)
        .where(eq(agents.id, meeting.agentId));

      if (!agent) {
        console.error("[Webhook] Agent not found for id:", meeting.agentId);
        return NextResponse.json({ ok: true });
      }

      console.log(
        "[Webhook] Found agent:",
        agent.id,
        "instructions length:",
        agent.instructions?.length ?? 0
      );

      // Upsert agent user into Stream Video (so it can join as a participant)
      const avatarUrl = generateAvatarUri({
        seed: agent.name,
        variant: "botttsNeutral",
      });

      await streamVideo.upsertUsers([
        {
          id: agent.id,
          name: agent.name,
          // you *can* keep this as "video-agent" if you've set up that role
          // but "admin" is safest if you're unsure:
          role: "video-agent",
          image: avatarUrl,
        },
      ]);

      console.log("[Webhook] Agent user upserted into Stream Video");

      // Create call handle
      const call = streamVideo.video.call("default", meetingId);
      console.log("[Webhook] Call handle created, connecting OpenAI...");

      // ✅ PRIVATE PREVIEW-STYLE: connectOpenAi via streamVideo.video
      const realtimeClient = await streamVideo.video.connectOpenAi({
        call,
        openAiApiKey: process.env.OPENAI_API_KEY!,
        agentUserId: agent.id,
        model: "gpt-4o-realtime-preview-2025-06-03",
      });

      console.log("[Webhook] connectOpenAi SUCCESS, updating session...");

      await realtimeClient.updateSession({
        instructions:
          agent.instructions ||
          "You are an AI assistant participating in this video meeting.",
      });

      // Optional: log user + agent messages in Vercel logs
      realtimeClient.on(
        "conversation.item.input_audio_transcription_completed",
        (event: { transcript?: string }) => {
          console.log("[Webhook] User said:", event?.transcript);
        }
      );

      realtimeClient.on("conversation.item.created", (event: unknown) => {
        console.log("[Webhook] Agent event:", event);
      });

      console.log("[Webhook] Agent setup complete! 🎉");

      return NextResponse.json({ ok: true });
    }

    /* -------------------------------
       PARTICIPANT LEFT
    -------------------------------- */
    if (eventType === "call.session_participant_left") {
      const event = payload as unknown as CallSessionParticipantLeftEvent;

      const callCid = event.call_cid as string | undefined;
      const meetingId = callCid?.split(":")[1];

      console.log(
        "[Webhook] call.session_participant_left, call_cid:",
        callCid,
        "meetingId:",
        meetingId
      );

      if (meetingId) {
        try {
          const call = streamVideo.video.call("default", meetingId);
          await call.end();
          console.log("[Webhook] Call ended because last participant left");
        } catch (err) {
          console.error("[Webhook] Error ending call:", err);
        }
      }

      return NextResponse.json({ ok: true });
    }

    /* -------------------------------
       CALL ENDED
    -------------------------------- */
    if (eventType === "call.session_ended") {
      const event = payload as unknown as CallEndedEvent;
      const meetingId = event.call?.custom?.meetingId as string | undefined;

      console.log("[Webhook] call.session_ended, meetingId:", meetingId);

      if (meetingId) {
        await db
          .update(meetings)
          .set({ status: "processing", endedAt: new Date() })
          .where(and(eq(meetings.id, meetingId), eq(meetings.status, "active")));
      }

      return NextResponse.json({ ok: true });
    }

    /* -------------------------------
       TRANSCRIPTION READY
    -------------------------------- */
    if (eventType === "call.transcription_ready") {
      const event = payload as unknown as CallTranscriptionReadyEvent;
      const meetingId = event.call_cid?.split(":")[1];

      console.log("[Webhook] call.transcription_ready, meetingId:", meetingId);

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

          console.log("[Webhook] Transcript saved & Inngest triggered");
        }
      }

      return NextResponse.json({ ok: true });
    }

    /* -------------------------------
       RECORDING READY
    -------------------------------- */
    if (eventType === "call.recording_ready") {
      const event = payload as unknown as CallRecordingReadyEvent;
      const meetingId = event.call_cid?.split(":")[1];

      console.log("[Webhook] call.recording_ready, meetingId:", meetingId);

      if (meetingId) {
        await db
          .update(meetings)
          .set({ recordingUrl: event.call_recording?.url ?? null })
          .where(eq(meetings.id, meetingId));

        console.log("[Webhook] Recording URL saved");
      }

      return NextResponse.json({ ok: true });
    }

    /* -------------------------------
       STREAM CHAT MESSAGE → AI CHATBOT
    -------------------------------- */
    if (eventType === "message.new") {
      const event = payload as unknown as MessageNewEvent;

      const userId = event.user?.id;
      const channelId = event.channel_id;
      const text = (event.message?.text ?? "").trim();

      console.log(
        "[Webhook] message.new, userId:",
        userId,
        "channelId:",
        channelId,
        "text:",
        text
      );

      if (!userId || !channelId || !text) {
        return NextResponse.json({ ok: true });
      }

      const [meeting] = await db
        .select()
        .from(meetings)
        .where(eq(meetings.id, channelId));

      if (!meeting) return NextResponse.json({ ok: true });

      const [agent] = await db
        .select()
        .from(agents)
        .where(eq(agents.id, meeting.agentId));

      // Ignore messages from the agent itself
      if (!agent || userId === agent.id) return NextResponse.json({ ok: true });

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
      }

      return NextResponse.json({ ok: true });
    }

    console.log("[Webhook] Unhandled event type:", eventType);
    return NextResponse.json({ ok: true });
  } catch (err) {
    console.error("🔥 WEBHOOK ERROR:", err);
    return NextResponse.json({ error: "Server error" }, { status: 500 });
  }
}

/* -------------------------------
   DEV TEST (PUT)
-------------------------------- */

export async function PUT(req: NextRequest) {
  const raw = await req.text();
  let body: Record<string, unknown> = {};

  try {
    body = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    // ignore non-JSON
  }

  await inngest.send({ name: "webhook/put", data: body });
  return NextResponse.json({ ok: true });
}
