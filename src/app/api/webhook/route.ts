import OpenAI from "openai";
import { and, eq, not } from "drizzle-orm";
import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";

import type {
  MessageNewEvent,
  CallEndedEvent,
  CallTranscriptionReadyEvent,
  CallRecordingReadyEvent,
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
   TYPES (no explicit any)
-------------------------------- */

type WebhookPayload = {
  type?: string;
  call_cid?: string;
  [key: string]: unknown;
};

interface StreamMessage {
  text?: string | null;
  user?: { id?: string };
}

// Minimal shape of the Realtime client we care about
interface RealtimeClientLike {
  updateSession?: (args: { instructions: string }) => Promise<unknown>;
}

/* -------------------------------
   HELPERS
-------------------------------- */

function verifySignature(body: string, signature: string) {
  try {
    return streamVideo.verifyWebhook(body, signature);
  } catch (err) {
    console.error("verifySignature error:", err);
    return false;
  }
}

/* -------------------------------
   WEBHOOK POST
-------------------------------- */

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

  let payload: WebhookPayload;
  try {
    payload = JSON.parse(rawBody) as WebhookPayload;
  } catch {
    return NextResponse.json({ error: "Bad JSON" }, { status: 400 });
  }

  const eventType = payload.type as string;
  console.log("📦 EVENT:", eventType);

  try {
    /* -------------------------------
       CALL SESSION STARTED
    -------------------------------- */
    if (eventType === "call.session_started") {
      const event = payload as unknown as CallSessionStartedEvent;
      const meetingId = event.call?.custom?.meetingId;

      console.log("🔔 call.session_started for meeting:", meetingId);

      if (!meetingId) return NextResponse.json({ ok: true });

      const [meeting] = await db
        .select()
        .from(meetings)
        .where(
          and(
            eq(meetings.id, meetingId),
            not(eq(meetings.status, "completed")),
            not(eq(meetings.status, "active")),
            not(eq(meetings.status, "cancelled"))
          )
        );

      if (!meeting) {
        console.log("⚠ No matching meeting for session_started:", meetingId);
        return NextResponse.json({ ok: true });
      }

      await db
        .update(meetings)
        .set({ status: "active", startedAt: new Date() })
        .where(eq(meetings.id, meetingId));

      // Fetch agent
      const [agent] = await db
        .select()
        .from(agents)
        .where(eq(agents.id, meeting.agentId));

      if (!agent) {
        console.log("⚠ No agent found for meeting:", meetingId);
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

      console.log("👤 Agent upserted into Stream Video:", agent.id);

      // Get call handle
      const call = streamVideo.video.call("default", meetingId);

      // ✅ Add agent as a member via updateCallMembers (correct API)
      try {
        await streamVideo.video.updateCallMembers({
          type: "default",
          id: meetingId,
          update_members: [
            {
              user_id: agent.id,
              role: "video-agent",
            },
          ],
        });

        console.log("➕ Agent added to call members via updateCallMembers");
      } catch (err) {
        console.error("updateCallMembers error:", err);
      }

   // ✅ Connect the AI agent using private-preview connectOpenAi (if present)
try {
  // TS does not know this exists, so we force-cast video as any
  const videoApi = streamVideo.video as unknown as {
    connectOpenAi?: (args: {
      call: unknown;
      agentUserId: string;
      openAiApiKey: string;
      model: string;
      validityInSeconds: number;
    }) => Promise<unknown>;
  };

  if (!videoApi.connectOpenAi) {
    console.log("⚠ connectOpenAi() not found on this SDK version");
  } else {
    console.log("🔌 connectOpenAi() available — attempting connection…");

    const realtimeClient = (await videoApi.connectOpenAi({
      call,
      agentUserId: agent.id,
      openAiApiKey: process.env.OPENAI_API_KEY!,
      model: "gpt-4o-realtime-preview",
      validityInSeconds: 3600,
    })) as RealtimeClientLike;

    await realtimeClient.updateSession?.({
      instructions:
        agent.instructions ||
        "You are an AI assistant participating in a video call.",
    });

    console.log("🤖 AI Agent connected via connectOpenAi (private preview)");
  }
} catch (err) {
  console.error("connectOpenAi runtime error:", err);
}

      return NextResponse.json({ ok: true });
    }

    /* -------------------------------
       PARTICIPANT LEFT
       (end call when last participant leaves)
    -------------------------------- */
    if (eventType === "call.session_participant_left") {
      const callCid = payload.call_cid;
      const meetingId =
        typeof callCid === "string" && callCid.includes(":")
          ? callCid.split(":")[1]
          : undefined;

      console.log(
        "👋 call.session_participant_left, callCid:",
        callCid,
        "meetingId:",
        meetingId,
      );

      if (meetingId) {
        try {
          await streamVideo.video.call("default", meetingId).end();
        } catch (err) {
          console.error("end() error after participant_left:", err);
        }
      }

      return NextResponse.json({ ok: true });
    }

    /* -------------------------------
       CALL ENDED
    -------------------------------- */
    if (eventType === "call.session_ended") {
      const event = payload as unknown as CallEndedEvent;
      const meetingId = event.call?.custom?.meetingId;

      console.log("🛑 call.session_ended for meeting:", meetingId);

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

      console.log("📝 call.transcription_ready for callCid:", event.call_cid);

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

    /* -------------------------------
       RECORDING READY
    -------------------------------- */
    if (eventType === "call.recording_ready") {
      const event = payload as unknown as CallRecordingReadyEvent;
      const meetingId = event.call_cid?.split(":")[1];

      console.log("🎥 call.recording_ready for callCid:", event.call_cid);

      if (meetingId) {
        await db
          .update(meetings)
          .set({ recordingUrl: event.call_recording?.url ?? null })
          .where(eq(meetings.id, meetingId));
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

    // Fallback for unhandled events
    console.log("ℹ Unhandled event type:", eventType);
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
    // ignore non-JSON body
  }

  try {
    await inngest.send({ name: "webhook/put", data: body });
    return NextResponse.json({ ok: true });
  } catch (err) {
    console.error("PUT error:", err);
    return NextResponse.json({ error: "Failed" }, { status: 500 });
  }
}
