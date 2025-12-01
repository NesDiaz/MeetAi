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

import { createRealtimeClient } from "@stream-io/openai-realtime-api";

import { db } from "@/db";
import { agents, meetings } from "@/db/schema";
import { streamVideo } from "@/lib/stream-video";
import { streamChat } from "@/lib/stream-chat";
import { inngest } from "@/inngest/client";
import { generateAvatarUri } from "@/lib/avatar";
import type { ChatCompletionMessageParam } from "openai/resources/index.mjs";

const openaiClient = new OpenAI({ apiKey: process.env.OPENAI_API_KEY! });

export const runtime = "nodejs";

/* ----------------------------------------
   TYPES
---------------------------------------- */

interface StreamCall {
  updateCall?: (args: {
    members: { user_id: string; role: string }[];
  }) => Promise<unknown>;
}

interface StreamMessage {
  text?: string | null;
  user?: { id?: string };
}

/* ----------------------------------------
   HELPERS
---------------------------------------- */

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

/* ----------------------------------------
   MAIN WEBHOOK — POST
---------------------------------------- */

export async function POST(req: NextRequest) {
  const rawBody = await req.text();

  const signature =
    req.headers.get("x-signature") ?? req.headers.get("x-stream-signature");

  if (!signature) {
    return NextResponse.json({ error: "Missing signature" }, { status: 400 });
  }

  if (!verifySignature(rawBody, signature)) {
    return NextResponse.json({ error: "Invalid signature" }, { status: 401 });
  }

  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const eventType = payload.type || "unknown";
  console.log("📦 Webhook Event:", eventType);

  try {
    /* ----------------------------------------
       CALL SESSION STARTED
    ---------------------------------------- */
    if (eventType === "call.session_started") {
      const event = payload as unknown as CallSessionStartedEvent;
      const meetingId = event.call?.custom?.meetingId;
      if (!meetingId) return NextResponse.json({ ok: true });

      const [existingMeeting] = await db
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

      if (!existingMeeting) return NextResponse.json({ ok: true });

      await db
        .update(meetings)
        .set({ status: "active", startedAt: new Date() })
        .where(eq(meetings.id, meetingId));

      /* GET AGENT */
      const [agent] = await db
        .select()
        .from(agents)
        .where(eq(agents.id, existingMeeting.agentId));

      if (!agent) return NextResponse.json({ ok: true });

      /* UPSERT AGENT AS STREAM USER */
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

      console.log("Agent user upserted into Stream Video");

      const call = streamVideo.video.call(
        "default",
        meetingId
      ) as unknown as StreamCall;

      /* ADD AGENT AS CALL MEMBER */
      if (hasUpdateCall(call)) {
        try {
          await call.updateCall({
            members: [{ user_id: agent.id, role: "video-agent" }],
          });
          console.log("Agent added as call member");
        } catch (err) {
          console.error("updateCall error:", err);
        }
      }

      /* ----------------------------------------
         CONNECT AI AGENT — CORRECT API FOR v0.3.x
      ---------------------------------------- */
      try {
        const agentToken = streamVideo.generateUserToken({
          user_id: agent.id,
          validity_in_seconds: 3600,
        });

        const realtimeClient = createRealtimeClient({
          baseUrl: "wss://video.stream-io-api.com/realtime",
          call: {
            type: "default",
            id: meetingId,
          },
          streamApiKey: process.env.NEXT_PUBLIC_STREAM_VIDEO_API_KEY!,
          streamUserToken: agentToken,
          openAiApiKey: process.env.OPENAI_API_KEY!,
          model: "gpt-4o-realtime-preview",
          debug: true,
        });

        realtimeClient.connect();
        console.log("🤖 Agent connected using createRealtimeClient()");
      } catch (err) {
        console.error("Agent realtime connection error:", err);
      }

      return NextResponse.json({ ok: true });
    }

    /* ----------------------------------------
       PARTICIPANT LEFT
    ---------------------------------------- */
    if (eventType === "call.session_participant_left") {
      const event = payload as unknown as CallSessionParticipantLeftEvent;
      const meetingId = event.call_cid?.split(":")[1];

      if (meetingId) {
        try {
          await streamVideo.video.call("default", meetingId).end();
        } catch (err) {
          console.error("end() error:", err);
        }
      }

      return NextResponse.json({ ok: true });
    }

    /* ----------------------------------------
       CALL ENDED
    ---------------------------------------- */
    if (eventType === "call.session_ended") {
      const event = payload as unknown as CallEndedEvent;
      const meetingId = event.call?.custom?.meetingId;

      if (meetingId) {
        await db
          .update(meetings)
          .set({
            status: "processing",
            endedAt: new Date(),
          })
          .where(and(eq(meetings.id, meetingId), eq(meetings.status, "active")));
      }

      return NextResponse.json({ ok: true });
    }

    /* ----------------------------------------
       TRANSCRIPTION READY
    ---------------------------------------- */
    if (eventType === "call.transcription_ready") {
      const event = payload as unknown as CallTranscriptionReadyEvent;
      const meetingId = event.call_cid?.split(":")[1];

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
        }
      }

      return NextResponse.json({ ok: true });
    }

    /* ----------------------------------------
       RECORDING READY
    ---------------------------------------- */
    if (eventType === "call.recording_ready") {
      const event = payload as unknown as CallRecordingReadyEvent;
      const meetingId = event.call_cid?.split(":")[1];

      if (meetingId) {
        await db
          .update(meetings)
          .set({ recordingUrl: event.call_recording?.url ?? null })
          .where(eq(meetings.id, meetingId));
      }

      return NextResponse.json({ ok: true });
    }

    /* ----------------------------------------
       CHAT MESSAGE
    ---------------------------------------- */
    if (eventType === "message.new") {
      const event = payload as unknown as MessageNewEvent;

      const userId = event.user?.id;
      const channelId = event.channel_id;
      const text = (event.message?.text ?? "").trim();

      if (!userId || !channelId || !text) return NextResponse.json({ ok: true });

      const [meeting] = await db
        .select()
        .from(meetings)
        .where(
          and(eq(meetings.id, channelId), not(eq(meetings.status, "cancelled")))
        );

      if (!meeting) return NextResponse.json({ ok: true });

      const [agent] = await db
        .select()
        .from(agents)
        .where(eq(agents.id, meeting.agentId));

      if (!agent || userId === agent.id) return NextResponse.json({ ok: true });

      const channel = streamChat.channel("messaging", channelId);
      await channel.watch();

      const messages = (channel.state.messages ?? []) as StreamMessage[];

      const previousMessages: ChatCompletionMessageParam[] = messages
        .slice(-5)
        .filter((m) => m.text?.trim())
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

      const reply = completion.choices?.[0]?.message?.content;

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

    return NextResponse.json({ ok: true });
  } catch (err) {
    console.error("🔥 WEBHOOK ERROR:", err);
    return NextResponse.json({ error: "Server error" }, { status: 500 });
  }
}

/* ----------------------------------------
   PUT (DEV)
---------------------------------------- */

export async function PUT(req: NextRequest) {
  const raw = await req.text();
  let body: Record<string, unknown> = {};

  try {
    body = JSON.parse(raw);
  } catch {}

  try {
    await inngest.send({ name: "webhook/put", data: body });
    return NextResponse.json({ ok: true });
  } catch (err) {
    console.error("PUT error:", err);
    return NextResponse.json({ error: "Failed" }, { status: 500 });
  }
}
