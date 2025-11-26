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
   TYPES (no "any")
-------------------------------- */

interface StreamCall {
  updateCall?: (args: {
    members: { user_id: string; role: string }[];
  }) => Promise<unknown>;
  connectOpenAi?: (args: {
    openAiApiKey: string;
    agentUserId: string;
  }) => Promise<RealtimeClient>;
}

interface RealtimeClient {
  updateSession?: (args: { instructions: string }) => Promise<unknown>;
}

interface StreamMessage {
  text?: string | null;
  user?: { id?: string };
}

/* -------------------------------
   HELPERS
-------------------------------- */

function verifySignature(body: string, signature: string): boolean {
  try {
    // Uses your existing Stream Video server client
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

function hasConnectOpenAi(
  call: StreamCall
): call is Required<Pick<StreamCall, "connectOpenAi">> {
  return typeof call.connectOpenAi === "function";
}

/* -------------------------------
   MAIN WEBHOOK (POST)
-------------------------------- */

export async function POST(req: NextRequest) {
  const rawBody = await req.text();
  console.log("📩 RAW BODY (preview):", rawBody.slice(0, 2000));

  // Stream typically sends x-signature, but we also support x-stream-signature
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

  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(rawBody) as Record<string, unknown>;
  } catch (err) {
    console.error("Bad JSON in webhook:", err);
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const eventType = (payload.type as string) || "unknown";
  console.log("📦 Event:", eventType);

  try {
    /* -------------------------------
       CALL SESSION STARTED
    -------------------------------- */
    if (eventType === "call.session_started") {
      const event = payload as unknown as CallSessionStartedEvent;
      const meetingId = event.call?.custom?.meetingId as string | undefined;
    
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
    
      // ---- FETCH AGENT ----
      const [agent] = await db.select().from(agents).where(eq(agents.id, existingMeeting.agentId));
      if (!agent) return NextResponse.json({ ok: true });
    
      const avatarUrl = generateAvatarUri({
        seed: agent.name,
        variant: "botttsNeutral",
      });
    
      // ---------- AGENT MUST BE UPSERTED INTO STREAM VIDEO ----------
      await streamVideo.upsertUsers([
        {
          id: agent.id,
          name: agent.name,
          role: "video-agent", // <-- REQUIRED
          image: avatarUrl,
        },
      ]);
      console.log("Video agent upserted");
    
      // ---------- UPDATE CALL MEMBERS ----------
      const call = streamVideo.video.call("default", meetingId) as unknown as StreamCall;
    
      if (hasUpdateCall(call)) {
        try {
          await call.updateCall({
            members: [
              { user_id: agent.id, role: "video-agent" }
            ],
          });
          console.log("Agent added to call");
        } catch (err) {
          console.error("updateCall error:", err);
        }
      }
    
      // ---------- CONNECT REALTIME OPENAI AGENT ----------
      if (hasConnectOpenAi(call)) {
        try {
          const realtimeClient = await call.connectOpenAi({
            openAiApiKey: process.env.OPENAI_API_KEY!,
            agentUserId: agent.id,
          });
    
          if (realtimeClient.updateSession) {
            await realtimeClient.updateSession({
              instructions: agent.instructions || "You are a helpful AI assistant.",
            });
          }
    
          console.log("Realtime agent connected");
        } catch (err) {
          console.error("connectOpenAi error:", err);
        }
      }
    
      return NextResponse.json({ ok: true });
    } 

    /* -------------------------------
       PARTICIPANT LEFT
    -------------------------------- */
    if (eventType === "call.session_participant_left") {
      const event = payload as unknown as CallSessionParticipantLeftEvent;
      const meetingId = event.call_cid?.split(":")[1];

      if (meetingId) {
        try {
          await streamVideo.video.call("default", meetingId).end();
          console.log("📞 Call ended after participant left");
        } catch (err) {
          console.error("end() error:", err);
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

      if (meetingId) {
        await db
          .update(meetings)
          .set({ status: "processing", endedAt: new Date() })
          .where(and(eq(meetings.id, meetingId), eq(meetings.status, "active")));

        console.log("📊 Meeting moved to processing:", meetingId);
      }

      return NextResponse.json({ ok: true });
    }

    /* -------------------------------
       TRANSCRIPTION READY
    -------------------------------- */
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

          console.log("📝 Transcript saved & processing triggered");
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

      if (meetingId) {
        await db
          .update(meetings)
          .set({ recordingUrl: event.call_recording?.url ?? null })
          .where(eq(meetings.id, meetingId));

        console.log("🎥 Recording URL saved for meeting:", meetingId);
      }

      return NextResponse.json({ ok: true });
    }

    /* -------------------------------
       STREAM CHAT MESSAGE
    -------------------------------- */
    if (eventType === "message.new") {
      const event = payload as unknown as MessageNewEvent;

      const userId = event.user?.id;
      const channelId = event.channel_id;
      const text = (event.message?.text ?? "").toString();

      if (!userId || !channelId || !text.trim()) {
        return NextResponse.json({ ok: true });
      }

      const [meeting] = await db
        .select()
        .from(meetings)
        .where(
          and(
            eq(meetings.id, channelId),
            not(eq(meetings.status, "cancelled"))
          )
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
          user: {
            id: agent.id,
            name: agent.name,
            image: avatar,
          },
        });
      }

      return NextResponse.json({ ok: true });
    }

    /* -------------------------------
       UNKNOWN EVENT
    -------------------------------- */
    console.log("Unhandled webhook event type:", eventType);
    return NextResponse.json({ ok: true });
  } catch (err) {
    console.error("🔥 WEBHOOK ERROR:", err);
    return NextResponse.json({ error: "Server error" }, { status: 500 });
  }
}

/* -------------------------------
   PUT (DEV)
-------------------------------- */

export async function PUT(req: NextRequest) {
  const raw = await req.text();
  let body: Record<string, unknown> = {};

  try {
    body = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    // leave as empty/unused if not JSON
  }

  try {
    await inngest.send({ name: "webhook/put", data: body });
    return NextResponse.json({ ok: true });
  } catch (err) {
    console.error("PUT error:", err);
    return NextResponse.json({ error: "Failed" }, { status: 500 });
  }
}
