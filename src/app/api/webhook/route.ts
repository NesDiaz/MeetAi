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
// HELPER: verify Stream signature
// -------------------------------
function verifySignature(body: string, signature: string) {
  try {
    return streamVideo.verifyWebhook(body, signature);
  } catch (err) {
    console.error("verifySignature error:", err);
    return false;
  }
}

// -------------------------------
// TYPE GUARDS
// -------------------------------
interface AddMembersCapable {
  addMembers?: (ids: string[]) => Promise<void>;
}

function hasAddMembers(call: unknown): call is AddMembersCapable {
  return (
    typeof call === "object" &&
    call !== null &&
    "addMembers" in call &&
    typeof (call as AddMembersCapable).addMembers === "function"
  );
}

interface UpdateCallCapable {
  updateCall?: (data: unknown) => Promise<void>;
}

function hasUpdateCall(call: unknown): call is UpdateCallCapable {
  return (
    typeof call === "object" &&
    call !== null &&
    "updateCall" in call &&
    typeof (call as UpdateCallCapable).updateCall === "function"
  );
}

interface OpenAIConnectCapable {
  connectOpenAi?: (opts: { openAiApiKey: string; agentUserId: string }) => Promise<any>;
}

function hasConnectOpenAi(call: unknown): call is OpenAIConnectCapable {
  return (
    typeof call === "object" &&
    call !== null &&
    "connectOpenAi" in call &&
    typeof (call as OpenAIConnectCapable).connectOpenAi === "function"
  );
}

// -------------------------------
// MAIN WEBHOOK
// -------------------------------
export async function POST(req: NextRequest) {
  const rawBody = await req.text();
  console.log("📩 RAW BODY:", rawBody.slice(0, 1000));

  const signature = req.headers.get("x-signature");
  const apiKey = req.headers.get("x-api-key");

  if (!signature || !apiKey) {
    console.log("❌ Missing headers", { signature: !!signature, apiKey: !!apiKey });
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
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const eventType = payload.type as string | undefined;
  console.log("📦 Event:", eventType);

  try {
    // -------------------------------
    // CALL STARTED
    // -------------------------------
    if (eventType === "call.session_started") {
      const event = payload as unknown as CallSessionStartedEvent;
      console.log("▶ call.session_started:", event.call_cid);

      const meetingId = event.call?.custom?.meetingId;
      if (!meetingId) {
        console.warn("❌ Missing meetingId");
        return NextResponse.json({ error: "Missing meetingId" }, { status: 400 });
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
        return NextResponse.json({ error: "Meeting not found" }, { status: 404 });
      }

      await db
        .update(meetings)
        .set({ status: "active", startedAt: new Date() })
        .where(eq(meetings.id, meetingId));

      const [agent] = await db.select().from(agents).where(eq(agents.id, existingMeeting.agentId));
      if (!agent) {
        console.warn("❌ Agent not found:", existingMeeting.agentId);
        return NextResponse.json({ error: "Agent not found" }, { status: 404 });
      }

      const avatarUrl = generateAvatarUri({
        seed: agent.name,
        variant: "botttsNeutral",
      });

      await streamChat.upsertUser({
        id: agent.id,
        name: agent.name,
        image: avatarUrl,
      });

      const call = streamVideo.video.call("default", meetingId);

      // Add agent to call
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
        console.log("ℹ️ updateCall not available in SDK");
      }

      // Fix Vercel WS
      process.env.WS_NO_BUFFER_UTIL = "true";
      process.env.WS_NO_UTF_8_VALIDATE = "true";

      // Connect OpenAI realtime agent
      try {
        if (hasConnectOpenAi(call)) {
          const realtimeClient = await call.connectOpenAi({
            openAiApiKey: process.env.OPENAI_API_KEY!,
            agentUserId: agent.id,
          });
          await realtimeClient.updateSession({ instructions: agent.instructions });
          console.log("✅ Realtime agent connected");
        } else {
          console.log("ℹ️ connectOpenAi not available on call object");
        }
      } catch (err) {
        console.error("❌ OpenAI realtime error:", err);
      }
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
    }

    // -------------------------------
    // CALL ENDED → PROCESSING
    // -------------------------------
    else if (eventType === "call.session_ended") {
      const event = payload as unknown as CallEndedEvent;
      const meetingId = event.call?.custom?.meetingId;
      console.log("🛑 call.session_ended:", meetingId);

      if (meetingId) {
        await db
          .update(meetings)
          .set({ status: "processing", endedAt: new Date() })
          .where(and(eq(meetings.id, meetingId), eq(meetings.status, "active")));
        console.log("🔄 Meeting set to processing:", meetingId);
      }
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
    }

    // -------------------------------
    // STREAM CHAT MESSAGE → USE OPENAI
    // -------------------------------
    else if (eventType === "message.new") {
      const event = payload as unknown as MessageNewEvent;
      const userId = event.user?.id;
      const channelId = event.channel_id;
      const text = event.message?.text ?? "";

      console.log("💬 message.new:", { userId, channelId, text });

      if (!userId || !channelId || !text) {
        console.warn("❌ Bad message.new fields");
      } else {
        const [meeting] = await db
          .select()
          .from(meetings)
          .where(and(eq(meetings.id, channelId), not(eq(meetings.status, "cancelled"))));

        if (!meeting) {
          console.warn("❌ Meeting not found for channel:", channelId);
        } else {
          const [agent] = await db.select().from(agents).where(eq(agents.id, meeting.agentId));
          if (!agent) {
            console.warn("❌ Agent missing:", meeting.agentId);
          } else if (userId === agent.id) {
            console.log("ℹ Agent message ignored");
          } else {
            const channel = streamChat.channel("messaging", channelId);
            await channel.watch();

            const previousMessages: ChatCompletionMessageParam[] = channel.state.messages
              .slice(-5)
              .filter((m) => m.text?.trim())
              .map((m) => ({
                role: m.user?.id === agent.id ? "assistant" : "user",
                content: m.text ?? "",
              }));

            const completion = await openaiClient.chat.completions.create({
              model: "gpt-4o",
              messages: [
                { role: "system", content: agent.instructions || "You are a helpful assistant." },
                ...previousMessages,
                { role: "user", content: text },
              ],
            });

            const reply = completion.choices?.[0]?.message?.content ?? "";
            console.log("🤖 Reply:", reply.slice(0, 200));

            const avatar = generateAvatarUri({ seed: agent.name, variant: "botttsNeutral" });
            await streamChat.upsertUser({ id: agent.id, name: agent.name, image: avatar });

            await channel.sendMessage({
              text: reply,
              user: { id: agent.id, name: agent.name, image: avatar },
            });

            console.log("✅ Reply sent");
          }
        }
      }
    }

    // -------------------------------
    // UNKNOWN EVENT
    // -------------------------------
    else {
      console.log("ℹ️ Unhandled event:", eventType);
    }

    return NextResponse.json({ ok: true });
  } catch (err) {
    console.error("🔥 WEBHOOK ERROR:", err);
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

// import OpenAI from "openai";
// import { and, eq, not } from "drizzle-orm";
// import { NextRequest, NextResponse } from "next/server";
// import { ChatCompletionMessageParam } from "openai/resources/index.mjs";
// import {
//   MessageNewEvent,
//   CallEndedEvent,
//   CallTranscriptionReadyEvent,
//   CallRecordingReadyEvent,
//   CallSessionParticipantLeftEvent,
//   CallSessionStartedEvent,
// } from "@stream-io/node-sdk";

// import { db } from "@/db";
// import { agents, meetings } from "@/db/schema";
// import { streamVideo } from "@/lib/stream-video";
// import { inngest } from "@/inngest/client";
// import { generateAvatarUri } from "@/lib/avatar";
// import { streamChat } from "@/lib/stream-chat";

// const openaiClient = new OpenAI({ apiKey: process.env.OPENAI_API_KEY! });

// export const runtime = "nodejs";

// function verifySignatureWithSDK(body: string, signature: string): boolean {
//   return streamVideo.verifyWebhook(body, signature);
// }

// // --- Safe JSON body helper ---
// async function getSafeBody(request: Request) {
//   try {
//     const text = await request.text();
//     return text ? JSON.parse(text) : {};
//   } catch {
//     return {};
//   }
// }

// export async function POST(req: NextRequest) {
//   const bodyText = await req.text();
// console.log("📩 Webhook received:", bodyText.slice(0, 500));

// const signature = req.headers.get("x-signature");
//   const apiKey = req.headers.get("x-api-key");

//   if (!signature || !apiKey) {
//     return NextResponse.json(
//       { error: "Missing signature or API key" },
//       { status: 400 }
//     );
//   }

//   const body = await req.text();

//   if (!verifySignatureWithSDK(body, signature)) {
//     return NextResponse.json({ error: "Invalid signature" }, { status: 401 });
//   }

//   let payload: unknown;
//   try {
//     payload = JSON.parse(body) as Record<string, unknown>;
//   } catch {
//     return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
//   }

//   const eventType = (payload as Record<string, unknown>)?.type;
//   console.log("📦 Incoming Stream event:", eventType);

//   // 🟢 Handle event types below
//   if (eventType === "call.session_started") {
//     const event = payload as CallSessionStartedEvent;
//     const meetingId = event.call.custom?.meetingId;

//     if (!meetingId) {
//       return NextResponse.json({ error: "Missing meetingId" }, { status: 400 });
//     }

//     const [existingMeeting] = await db
//       .select()
//       .from(meetings)
//       .where(
//         and(
//           eq(meetings.id, meetingId),
//           not(eq(meetings.status, "completed")),
//           not(eq(meetings.status, "active")),
//           not(eq(meetings.status, "cancelled")),
//           not(eq(meetings.status, "processing"))
//         )
//       );

//     if (!existingMeeting) {
//       return NextResponse.json({ error: "Meeting not found" }, { status: 404 });
//     }

//     await db
//       .update(meetings)
//       .set({
//         status: "active",
//         startedAt: new Date(),
//       })
//       .where(eq(meetings.id, existingMeeting.id));

//     const [existingAgent] = await db
//       .select()
//       .from(agents)
//       .where(eq(agents.id, existingMeeting.agentId));

//     if (!existingAgent) {
//       return NextResponse.json({ error: "Agent not found" }, { status: 404 });
//     }

//     process.env.WS_NO_BUFFER_UTIL = "true";
//     process.env.WS_NO_UTF_8_VALIDATE = "true";

//     const call = streamVideo.video.call("default", meetingId);
//     const realtimeClient = await streamVideo.video.connectOpenAi({
//       call,
//       openAiApiKey: process.env.OPENAI_API_KEY!,
//       agentUserId: existingAgent.id,
//     });

//     realtimeClient.updateSession({
//       instructions: existingAgent.instructions,
//     });
//   } else if (eventType === "call.session_participant_left") {
//     const event = payload as CallSessionParticipantLeftEvent;
//     const meetingId = event.call_cid.split(":")[1];

//     if (!meetingId) {
//       return NextResponse.json({ error: "Missing meetingId" }, { status: 400 });
//     }

//     const call = streamVideo.video.call("default", meetingId);
//     await call.end();
//   } else if (eventType === "call.session_ended") {
//     const event = payload as CallEndedEvent;
//     const meetingId = event.call.custom?.meetingId;

//     if (!meetingId) {
//       return NextResponse.json({ error: "Missing meetingId" }, { status: 400 });
//     }

//     await db
//       .update(meetings)
//       .set({
//         status: "processing",
//         endedAt: new Date(),
//       })
//       .where(and(eq(meetings.id, meetingId), eq(meetings.status, "active")));
//   } else if (eventType === "call.transcription_ready") {
//     const event = payload as CallTranscriptionReadyEvent;
//     const meetingId = event.call_cid.split(":")[1];

//     const [updatedMeeting] = await db
//       .update(meetings)
//       .set({
//         transcriptUrl: event.call_transcription.url,
//       })
//       .where(eq(meetings.id, meetingId))
//       .returning();

//     if (!updatedMeeting) {
//       return NextResponse.json({ error: "Meeting not found" }, { status: 404 });
//     }

//     await inngest.send({
//       name: "meetings/processing",
//       data: {
//         meetingId: updatedMeeting.id,
//         transcriptUrl: updatedMeeting.transcriptUrl,
//       },
//     });
//     if (!signature || !apiKey) {
//       console.log("⚠️ Missing headers:", { signature, apiKey });
//     }
    
//   } else if (eventType === "call.recording_ready") {
//     const event = payload as CallRecordingReadyEvent;
//     const meetingId = event.call_cid.split(":")[1];

//     await db
//       .update(meetings)
//       .set({
//         recordingUrl: event.call_recording.url,
//       })
//       .where(eq(meetings.id, meetingId));
//   } else if (eventType === "message.new") {
//     const event = payload as MessageNewEvent;
//     const userId = event.user?.id;
//     const channelId = event.channel_id;
//     const text = event.message?.text ?? "";

//     if (!userId || !channelId || !text) {
//       return NextResponse.json({ error: "Missing required fields" }, { status: 400 });
//     }

//     const [existingMeeting] = await db
//       .select()
//       .from(meetings)
//       .where(and(eq(meetings.id, channelId), not(eq(meetings.status, "cancelled"))));


//     if (!existingMeeting) {
//       return NextResponse.json({ error: "Meeting not found" }, { status: 404 });
//     }

//     const [existingAgent] = await db
//       .select()
//       .from(agents)
//       .where(eq(agents.id, existingMeeting.agentId));

//     if (!existingAgent) {
//       return NextResponse.json({ error: "Agent not found" }, { status: 404 });
//     }

//     if (userId !== existingAgent.id) {
//       const instructions = `
// You are an AI assistant helping the user revisit a recently completed meeting.
// Below is a summary of the meeting:

// ${existingMeeting.summary}

// Follow your previous behavioral instructions:
// ${existingAgent.instructions}

// Respond concisely and accurately.
// `;

//       const channel = streamChat.channel("messaging", channelId);
//       await channel.watch();

//       const previousMessages = channel.state.messages
//         .slice(-5)
//         .filter((msg) => msg.text && msg.text.trim() !== "")
//         .map<ChatCompletionMessageParam>((message) => ({
//           role: message.user?.id === existingAgent.id ? "assistant" : "user",
//           content: message.text || "",
//         }));

//       const GPTResponse = await openaiClient.chat.completions.create({
//         messages: [
//           { role: "system", content: instructions },
//           ...previousMessages,
//           { role: "user", content: text },
//         ],
//         model: "gpt-4o",
//       });

//       const GPTResponseText = GPTResponse.choices[0].message.content;

//       if (!GPTResponseText) {
//         return NextResponse.json({ error: "No response from GPT" }, { status: 400 });
//       }

//       const avatarUrl = generateAvatarUri({
//         seed: existingAgent.name,
//         variant: "botttsNeutral",
//       });

//       streamChat.upsertUser({
//         id: existingAgent.id,
//         name: existingAgent.name,
//         image: avatarUrl,
//       });

//       channel.sendMessage({
//         text: GPTResponseText ?? "",
//         user: {
//           id: existingAgent.id,
//           name: existingAgent.name,
//           image: avatarUrl,
//         },
//       });
//     }
//   }

//   // ✅ This return belongs here, at the *end of POST*
//   return NextResponse.json({ status: "ok" });
// }

// // ✅ Separate PUT handler
// export async function PUT(request: NextRequest) {
//   const body = await getSafeBody(request);

//   try {
//     await inngest.send({
//       name: "webhook/put",
//       data: body,
//     });

//     return NextResponse.json({ ok: true });
//   } catch (err) {
//     console.error("Inngest PUT error:", err);
//     return NextResponse.json({ error: "Failed to handle PUT" }, { status: 500 });
//   }
// }
