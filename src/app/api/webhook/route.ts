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

export const runtime = "nodejs";

const openaiClient = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY!,
});

/* -----------------------------------------
   TYPES (PRIVATE PREVIEW)
------------------------------------------ */

interface StreamCall {
  updateCall?: (args: {
    members: { user_id: string; role: string }[];
  }) => Promise<unknown>;

  connectOpenAi?: (args: {
    openAiApiKey: string;
    agentUserId: string;
  }) => Promise<{
    updateSession?: (args: { instructions: string }) => Promise<unknown>;
  }>;
}

interface StreamMessage {
  text?: string | null;
  user?: { id?: string };
}

/* -----------------------------------------
   VERIFY SIGNATURE
------------------------------------------ */

function verifySignature(body: string, signature: string) {
  try {
    return streamVideo.verifyWebhook(body, signature);
  } catch (err) {
    console.error("verifySignature error:", err);
    return false;
  }
}

/* -----------------------------------------
   WEBHOOK POST ENTRYPOINT
------------------------------------------ */

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

  let payload: { type?: string; [key: string]: unknown };

  try {
    payload = JSON.parse(rawBody);
  } catch {
    return NextResponse.json({ error: "Bad JSON" }, { status: 400 });
  }

  const eventType = payload.type || "unknown";
  console.log("📦 EVENT:", eventType);

  try {
    /* =====================================================
       1) CALL SESSION STARTED → JOIN AGENT + CONNECT AI
    ====================================================== */

    if (eventType === "call.session_started") {
      const event = payload as unknown as CallSessionStartedEvent;

      const meetingId = event.call?.custom?.meetingId;
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

      if (!meeting) return NextResponse.json({ ok: true });

      await db
        .update(meetings)
        .set({ status: "active", startedAt: new Date() })
        .where(eq(meetings.id, meetingId));

      // Fetch the agent assigned to the meeting
      const [agent] = await db
        .select()
        .from(agents)
        .where(eq(agents.id, meeting.agentId));

      if (!agent) return NextResponse.json({ ok: true });

      // Upsert Stream user
      const avatarUrl = generateAvatarUri({
        seed: agent.name,
        variant: "botttsNeutral",
      });

      await streamVideo.upsertUsers([
        {
          id: agent.id,
          name: agent.name,
          image: avatarUrl,
          role: "video-agent",
        },
      ]);

      // Stream call instance
      const call = streamVideo.video.call("default", meetingId) as StreamCall;

      /* --------------------------
         ADD AGENT AS A MEMBER
      --------------------------- */
      if (call.updateCall) {
        try {
          await call.updateCall({
            members: [{ user_id: agent.id, role: "video-agent" }],
          });
          console.log("👤 Agent added to call members");
        } catch (err) {
          console.error("updateCall error:", err);
        }
      } else {
        console.log("⚠ updateCall() missing in this SDK version");
      }

      /* --------------------------
         CONNECT AI AGENT (PRIVATE PREVIEW)
      --------------------------- */
      if (call.connectOpenAi) {
        try {
          const realtime = await call.connectOpenAi({
            openAiApiKey: process.env.OPENAI_API_KEY!,
            agentUserId: agent.id,
          });

          await realtime.updateSession?.({
            instructions:
              agent.instructions ||
              "You are an AI assistant participating in a video call.",
          });

          console.log("🤖 AI Agent connected through connectOpenAi()");
        } catch (err) {
          console.error("connectOpenAi error:", err);
        }
      } else {
        console.log("⚠ connectOpenAi() missing in this SDK version");
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

    /* =====================================================
       3) CALL ENDED → UPDATE DB
    ====================================================== */

    if (eventType === "call.session_ended") {
      const event = payload as unknown as CallEndedEvent;
      const meetingId = event.call?.custom?.meetingId;

      if (meetingId) {
        await db
          .update(meetings)
          .set({ status: "processing", endedAt: new Date() })
          .where(and(eq(meetings.id, meetingId), eq(meetings.status, "active")));
      }

      return NextResponse.json({ ok: true });
    }

    /* =====================================================
       4) TRANSCRIPTION READY
    ====================================================== */

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

    /* =====================================================
       5) RECORDING READY
    ====================================================== */

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

    /* =====================================================
       6) STREAM CHAT → AI CHATBOT
    ====================================================== */

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

      const previousMsgs: ChatCompletionMessageParam[] = messages
        .slice(-5)
        .filter((m) => m.text?.length)
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
          ...previousMsgs,
          { role: "user", content: text },
        ],
      });

      const reply = completion.choices?.[0]?.message?.content || "";

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

      return NextResponse.json({ ok: true });
    }

    return NextResponse.json({ ok: true });
  } catch (err) {
    console.error("🔥 WEBHOOK ERROR:", err);
    return NextResponse.json({ error: "Server error" }, { status: 500 });
  }
}

/* -----------------------------------------
   PUT (DEV TEST)
------------------------------------------ */

export async function PUT(req: NextRequest) {
  const raw = await req.text();
  let body = {};
  try {
    body = JSON.parse(raw);
  } catch {}
  await inngest.send({ name: "webhook/put", data: body });
  return NextResponse.json({ ok: true });
}
