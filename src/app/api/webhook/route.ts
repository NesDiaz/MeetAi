// src/app/api/webhook/route.ts
import OpenAI from "openai";
import { and, eq, not } from "drizzle-orm";
import { NextRequest, NextResponse } from "next/server";

import {
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
import { ChatCompletionMessageParam } from "openai/resources/index.mjs";

const openaiClient = new OpenAI({ apiKey: process.env.OPENAI_API_KEY! });
export const runtime = "nodejs";

// -------------------------------
// HELPERS / TYPE GUARDS
// -------------------------------
function verifySignature(body: string, signature: string) {
  try {
    return streamVideo.verifyWebhook(body, signature);
  } catch (err) {
    console.error("verifySignature error:", err);
    return false;
  }
}

interface UpdateCallCapable {
  updateCall?: (data: unknown) => Promise<void>;
}

function hasUpdateCall(call: unknown): call is UpdateCallCapable {
  return typeof call === "object" && call !== null && "updateCall" in (call as any) && typeof (call as any).updateCall === "function";
}

interface ConnectOpenAiCapable {
  connectOpenAi?: (opts: { openAiApiKey: string; agentUserId: string }) => Promise<any>;
}

function hasConnectOpenAi(call: unknown): call is ConnectOpenAiCapable {
  return typeof call === "object" && call !== null && "connectOpenAi" in (call as any) && typeof (call as any).connectOpenAi === "function";
}

// -------------------------------
// MAIN WEBHOOK
// -------------------------------
export async function POST(req: NextRequest) {
  const rawBody = await req.text();
  console.log("📩 RAW BODY (preview):", rawBody.slice(0, 1000));

  const signature = req.headers.get("x-signature");
  const apiKey = req.headers.get("x-api-key");

  if (!signature || !apiKey) {
    console.log("❌ Missing headers", { signature: !!signature, apiKey: !!apiKey });
    // Return 400 here because missing webhook headers indicates a misconfigured source.
    return NextResponse.json({ error: "Missing headers" }, { status: 400 });
  }

  if (!verifySignature(rawBody, signature)) {
    console.log("❌ Invalid signature");
    return NextResponse.json({ error: "Invalid signature" }, { status: 401 });
  }

  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(rawBody) as Record<string, unknown>;
  } catch (err) {
    console.error("❌ Bad JSON:", err);
    // Bad JSON likely means the sender used the wrong content-type or body — respond 400.
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const eventType = (payload.type as string) || "unknown";
  console.log("📦 Event:", eventType);

  try {
    // -------------------------------
    // CALL STARTED
    // -------------------------------
    if (eventType === "call.session_started") {
      const event = payload as unknown as CallSessionStartedEvent;
      console.log("▶ call.session_started:", event.call_cid);

      const meetingId = event.call?.custom?.meetingId as string | undefined;
      if (!meetingId) {
        console.warn("❌ Missing meetingId in call.session_started. Ignoring event to keep webhook healthy.");
        // Return success to prevent Stream from disabling webhook due to 4xx
        return NextResponse.json({ ok: true });
      }

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

      if (!existingMeeting) {
        console.warn("❌ Meeting not found:", meetingId);
        // Return OK so streaming platform doesn't disable webhook; logs will indicate missing meeting.
        return NextResponse.json({ ok: true });
      }

      await db
        .update(meetings)
        .set({ status: "active", startedAt: new Date() })
        .where(eq(meetings.id, meetingId));

      const [agent] = await db.select().from(agents).where(eq(agents.id, existingMeeting.agentId));
      if (!agent) {
        console.warn("❌ Agent not found:", existingMeeting.agentId);
        return NextResponse.json({ ok: true });
      }

      // make sure agent exists in Stream Chat
      const avatarUrl = generateAvatarUri({ seed: agent.name, variant: "botttsNeutral" });
      await streamChat.upsertUser({ id: agent.id, name: agent.name, image: avatarUrl });

      const call = streamVideo.video.call("default", meetingId);

      // Add agent to call if updateCall is available
      if (hasUpdateCall(call)) {
        try {
          await call.updateCall({
            members: [{ user_id: agent.id, role: "video-agent" }],
          });
          console.log("➕ Added agent to call");
        } catch (err) {
          console.error("⚠️ updateCall error:", err);
        }
      } else {
        console.log("ℹ️ updateCall not available on call object");
      }

      // Fix Vercel WS issues in environments that need it
      process.env.WS_NO_BUFFER_UTIL = "true";
      process.env.WS_NO_UTF_8_VALIDATE = "true";

      // Connect OpenAI realtime agent via the call object API (supported by your SDK version)
      try {
        if (hasConnectOpenAi(call)) {
          // call.connectOpenAi is called directly on the call object
          const realtimeClient = await call.connectOpenAi({
            openAiApiKey: process.env.OPENAI_API_KEY!,
            agentUserId: agent.id,
          });

          // Some SDKs return different shapes — guard the updateSession call
          if (realtimeClient && typeof (realtimeClient as any).updateSession === "function") {
            await (realtimeClient as any).updateSession({ instructions: agent.instructions });
          } else {
            console.log("ℹ️ Realtime client does not support updateSession on this SDK version.");
          }

          console.log("✅ Realtime agent connected");
        } else {
          console.log("ℹ️ connectOpenAi not available on call object");
        }
      } catch (err) {
        console.error("❌ OpenAI realtime connection error:", err);
      }

      // return success
      return NextResponse.json({ ok: true });
    }

    // -------------------------------
    // PARTICIPANT LEFT
    // -------------------------------
    else if (eventType === "call.session_participant_left") {
      const event = payload as unknown as CallSessionParticipantLeftEvent;
      const meetingId = event.call_cid?.split?.(":")?.[1];
      console.log("⚠ Participant left:", meetingId);

      if (meetingId) {
        try {
          await streamVideo.video.call("default", meetingId).end();
          console.log("🛑 Call ended:", meetingId);
        } catch (err) {
          console.error("⚠️ end() error:", err);
        }
      }

      return NextResponse.json({ ok: true });
    }

    // -------------------------------
    // CALL ENDED → PROCESSING
    // -------------------------------
    else if (eventType === "call.session_ended") {
      const event = payload as unknown as CallEndedEvent;
      const meetingId = event.call?.custom?.meetingId as string | undefined;
      console.log("🛑 call.session_ended:", meetingId);

      if (meetingId) {
        await db
          .update(meetings)
          .set({ status: "processing", endedAt: new Date() })
          .where(and(eq(meetings.id, meetingId), eq(meetings.status, "active")));
        console.log("🔄 Meeting set to processing:", meetingId);
      }

      return NextResponse.json({ ok: true });
    }

    // -------------------------------
    // TRANSCRIPTION READY
    // -------------------------------
    else if (eventType === "call.transcription_ready") {
      const event = payload as unknown as CallTranscriptionReadyEvent;
      const meetingId = event.call_cid?.split?.(":")?.[1];
      console.log("📝 transcription_ready:", meetingId);

      if (meetingId) {
        const [row] = await db
          .update(meetings)
          .set({ transcriptUrl: event.call_transcription?.url })
          .where(eq(meetings.id, meetingId))
          .returning();

        if (row) {
          await inngest.send({
            name: "meetings/processing",
            data: { meetingId: row.id, transcriptUrl: row.transcriptUrl },
          });
          console.log("📨 Inngest processing event sent");
        }
      }

      return NextResponse.json({ ok: true });
    }

    // -------------------------------
    // RECORDING READY
    // -------------------------------
    else if (eventType === "call.recording_ready") {
      const event = payload as unknown as CallRecordingReadyEvent;
      const meetingId = event.call_cid?.split?.(":")?.[1];
      console.log("🎥 recording_ready:", meetingId);

      if (meetingId) {
        await db
          .update(meetings)
          .set({ recordingUrl: event.call_recording?.url })
          .where(eq(meetings.id, meetingId));
        console.log("🎥 Recording saved");
      }

      return NextResponse.json({ ok: true });
    }

    // -------------------------------
    // STREAM CHAT MESSAGE → USE OPENAI
    // -------------------------------
    else if (eventType === "message.new") {
      const event = payload as unknown as MessageNewEvent;
      const userId = event.user?.id;
      const channelId = event.channel_id as string | undefined;
      const text = (event.message as any)?.text ?? "";

      console.log("💬 message.new:", { userId, channelId, text: String(text).slice(0, 200) });

      if (!userId || !channelId || !text) {
        console.warn("❌ Bad message.new fields. Ignoring.");
        return NextResponse.json({ ok: true });
      }

      const [meeting] = await db
        .select()
        .from(meetings)
        .where(and(eq(meetings.id, channelId), not(eq(meetings.status, "cancelled"))));

      if (!meeting) {
        console.warn("❌ Meeting not found for channel:", channelId);
        return NextResponse.json({ ok: true });
      }

      const [agent] = await db.select().from(agents).where(eq(agents.id, meeting.agentId));
      if (!agent) {
        console.warn("❌ Agent missing:", meeting.agentId);
        return NextResponse.json({ ok: true });
      }

      if (userId === agent.id) {
        console.log("ℹ Agent message ignored");
        return NextResponse.json({ ok: true });
      }

      const channel = streamChat.channel("messaging", channelId);
      await channel.watch();

      // Build previous messages
      const previousMessages: ChatCompletionMessageParam[] = (channel.state.messages ?? [])
        .slice(-5)
        .filter((m: any) => m.text?.trim())
        .map((m: any) => ({
          role: m.user?.id === agent.id ? "assistant" : "user",
          content: m.text ?? "",
        }));

      const completion = await openaiClient.chat.completions.create({
        model: "gpt-4o",
        messages: [
          { role: "system", content: agent.instructions || "You are a helpful assistant." },
          ...previousMessages,
          { role: "user", content: text as string },
        ],
      });

      const reply = (completion.choices?.[0]?.message?.content as string) ?? "";
      console.log("🤖 Reply preview:", reply.slice(0, 200));

      const avatar = generateAvatarUri({ seed: agent.name, variant: "botttsNeutral" });
      await streamChat.upsertUser({ id: agent.id, name: agent.name, image: avatar });

      await channel.sendMessage({
        text: reply,
        user: { id: agent.id, name: agent.name, image: avatar },
      });

      console.log("✅ Reply sent");

      return NextResponse.json({ ok: true });
    }

    // -------------------------------
    // UNKNOWN EVENT
    // -------------------------------
    else {
      console.log("ℹ️ Unhandled event:", eventType);
      return NextResponse.json({ ok: true });
    }
  } catch (err) {
    console.error("🔥 WEBHOOK ERROR:", err);
    // Return 500 so you can detect real server errors. Stream will retry if it's a server problem.
    return NextResponse.json({ error: "Server error" }, { status: 500 });
  }
}

// -------------------------------
// DEV TOOL: PUT → forward to Inngest
// -------------------------------
export async function PUT(req: NextRequest) {
  const raw = await req.text();
  let body: Record<string, unknown> = {};

  try {
    body = JSON.parse(raw) as Record<string, unknown>;
  } catch {}

  try {
    await inngest.send({ name: "webhook/put", data: body });
    return NextResponse.json({ ok: true });
  } catch (err) {
    console.error("❌ PUT error:", err);
    return NextResponse.json({ error: "Failed" }, { status: 500 });
  }
}
