// import OpenAI from "openai";
// import type { ChatCompletionMessageParam } from "openai/resources/chat/completions.mjs";

// import { eq } from "drizzle-orm";
// import { NextRequest, NextResponse } from "next/server";

// import {
//   CallSessionStartedEvent,
//   CallSessionParticipantLeftEvent,
//   CallTranscriptionReadyEvent,
//   CallRecordingReadyEvent,
//   CallEndedEvent,
//   MessageNewEvent,
// } from "@stream-io/node-sdk";

// import { db } from "@/db";
// import { agents, meetings } from "@/db/schema";
// import { streamVideo } from "@/lib/stream-video";
// import { streamChat } from "@/lib/stream-chat";
// import { inngest } from "@/inngest/client";
// import { generateAvatarUri } from "@/lib/avatar";

// const openaiClient = new OpenAI({
//   apiKey: process.env.OPENAI_API_KEY!,
// });

// export const runtime = "nodejs";

// // ------------------------------------------------------------------
// // SAFE BODY PARSER
// // ------------------------------------------------------------------
// async function getSafeBody(req: Request) {
//   try {
//     const text = await req.text();
//     return text ? JSON.parse(text) : {};
//   } catch {
//     return {};
//   }
// }

// // ------------------------------------------------------------------
// // VERIFY SIGNATURE (STREAM VIDEO WEBHOOKS)
// // ------------------------------------------------------------------
// function verifySignature(body: string, signature: string): boolean {
//   return streamVideo.verifyWebhook(body, signature);
// }

// // ------------------------------------------------------------------
// // POST — MAIN WEBHOOK HANDLER
// // ------------------------------------------------------------------
// export async function POST(req: NextRequest) {
//   const signature = req.headers.get("x-signature");
//   const apiKey = req.headers.get("x-api-key");

//   if (!signature || !apiKey) {
//     return NextResponse.json(
//       { error: "Missing signature or API key" },
//       { status: 400 }
//     );
//   }

//   const rawBody = await req.text();

//   if (!verifySignature(rawBody, signature)) {
//     return NextResponse.json({ error: "Invalid signature" }, { status: 401 });
//   }

//   let payload: unknown;
//   try {
//     payload = JSON.parse(rawBody);
//   } catch {
//     return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
//   }

//   const eventType = (payload as { type?: string })?.type;

//   // ------------------------------------------------------------------
//   // EVENT: call.session_started
//   // ------------------------------------------------------------------
//   if (eventType === "call.session_started") {
//     const event = payload as CallSessionStartedEvent;
//     const meetingId = event.call.custom?.meetingId;

//     if (!meetingId) {
//       return NextResponse.json({ error: "Missing meetingId" }, { status: 400 });
//     }

//     // 1. Mark meeting as active
//     const [meeting] = await db
//       .select()
//       .from(meetings)
//       .where(eq(meetings.id, meetingId));

//     if (!meeting) {
//       return NextResponse.json({ error: "Meeting not found" }, { status: 404 });
//     }

//     await db
//       .update(meetings)
//       .set({
//         status: "active",
//         startedAt: new Date(),
//       })
//       .where(eq(meetings.id, meetingId));

//     // 2. Fetch agent
//     const [agent] = await db
//       .select()
//       .from(agents)
//       .where(eq(agents.id, meeting.agentId));

//     if (!agent) {
//       return NextResponse.json({ error: "Agent not found" }, { status: 404 });
//     }

//     // 3. Trigger Inngest to handle agent connection
//     await inngest.send({
//       name: "agent/start",
//       data: {
//         meetingId,
//         agentId: agent.id,
//         model: "gpt-4o-realtime-preview",
//         instructions: agent.instructions,
//       },
//     });

//     return NextResponse.json({ ok: true });
//   }

//   // ------------------------------------------------------------------
//   // EVENT: call.session_participant_left → end call
//   // ------------------------------------------------------------------
//   if (eventType === "call.session_participant_left") {
//     const event = payload as CallSessionParticipantLeftEvent;
//     const meetingId = event.call_cid?.split(":")[1];

//     if (meetingId) {
//       const call = streamVideo.video.call("default", meetingId);
//       await call.end();
//     }

//     return NextResponse.json({ ok: true });
//   }

//   // ------------------------------------------------------------------
//   // EVENT: call.session_ended
//   // ------------------------------------------------------------------
//   if (eventType === "call.session_ended") {
//     const event = payload as CallEndedEvent;
//     const meetingId = event.call.custom?.meetingId;

//     if (meetingId) {
//       await db
//         .update(meetings)
//         .set({ status: "processing", endedAt: new Date() })
//         .where(eq(meetings.id, meetingId));
//     }

//     return NextResponse.json({ ok: true });
//   }

//   // ------------------------------------------------------------------
//   // EVENT: call.transcription_ready → send Inngest event
//   // ------------------------------------------------------------------
//   if (eventType === "call.transcription_ready") {
//     const event = payload as CallTranscriptionReadyEvent;
//     const meetingId = event.call_cid.split(":")[1];

//     const [updated] = await db
//       .update(meetings)
//       .set({
//         transcriptUrl: event.call_transcription.url,
//       })
//       .where(eq(meetings.id, meetingId))
//       .returning();

//     if (updated) {
//       await inngest.send({
//         name: "meetings/processing",
//         data: {
//           meetingId,
//           transcriptUrl: updated.transcriptUrl!,
//         },
//       });
//     }

//     return NextResponse.json({ ok: true });
//   }

//   // ------------------------------------------------------------------
//   // EVENT: call.recording_ready
//   // ------------------------------------------------------------------
//   if (eventType === "call.recording_ready") {
//     const event = payload as CallRecordingReadyEvent;
//     const meetingId = event.call_cid.split(":")[1];

//     await db
//       .update(meetings)
//       .set({ recordingUrl: event.call_recording.url })
//       .where(eq(meetings.id, meetingId));

//     return NextResponse.json({ ok: true });
//   }

//   // ------------------------------------------------------------------
//   // EVENT: message.new → Chat after meeting
//   // ------------------------------------------------------------------
//   if (eventType === "message.new") {
//     const event = payload as MessageNewEvent;

//     const userId = event.user?.id;
//     const channelId = event.channel_id;
//     const text = event.message?.text ?? "";

//     if (!userId || !channelId || !text) {
//       return NextResponse.json({ error: "Missing fields" }, { status: 400 });
//     }

//     const [meeting] = await db
//       .select()
//       .from(meetings)
//       .where(eq(meetings.id, channelId));

//     if (!meeting || meeting.status !== "completed") {
//       return NextResponse.json({ error: "Meeting not found or incomplete" });
//     }

//     const [agent] = await db
//       .select()
//       .from(agents)
//       .where(eq(agents.id, meeting.agentId));

//     if (!agent) return NextResponse.json({ error: "Agent not found" });

//     // User message → GPT response
//     if (userId !== agent.id) {
//       const systemMsg = {
//         role: "system",
//         content: `
// You are an AI assistant helping the user reflect on a completed meeting.
// Summary:
// ${meeting.summary}

// Follow your behavioral instructions:
// ${agent.instructions}
// `,
//       } as ChatCompletionMessageParam;

//       const channel = streamChat.channel("messaging", channelId);
//       await channel.watch();

//       const history = channel.state.messages
//         .slice(-6)
//         .map((msg) => ({
//           role: msg.user?.id === agent.id ? "assistant" : "user",
//           content: msg.text ?? "",
//         })) as ChatCompletionMessageParam[];

//       const completion = await openaiClient.chat.completions.create({
//         model: "gpt-4o",
//         messages: [systemMsg, ...history, { role: "user", content: text }],
//       });

//       const reply = completion.choices[0].message.content ?? "";

//       await channel.sendMessage({
//         text: reply,
//         user: {
//           id: agent.id,
//           name: agent.name,
//           image: generateAvatarUri({
//             seed: agent.name,
//             variant: "botttsNeutral",
//           }),
//         },
//       });
//     }

//     return NextResponse.json({ ok: true });
//   }

//   return NextResponse.json({ ok: true });
// }

// // ------------------------------------------------------------------
// // PUT — For Inngest local dev
// // ------------------------------------------------------------------
// export async function PUT(req: NextRequest) {
//   const body = await getSafeBody(req);

//   try {
//     await inngest.send({ name: "webhook/put", data: body });
//     return NextResponse.json({ ok: true });
//   } catch (err) {
//     console.error("Inngest PUT error:", err);
//     return NextResponse.json({ error: "Failed to handle PUT" }, { status: 500 });
//   }
// }


// ORIGINAL
import OpenAI from "openai";
import { and, eq, not } from "drizzle-orm";
import { NextRequest, NextResponse } from "next/server";
import { ChatCompletionMessageParam } from "openai/resources/index.mjs";
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
import { inngest } from "@/inngest/client";
import { generateAvatarUri } from "@/lib/avatar";
import { streamChat } from "@/lib/stream-chat";

const openaiClient = new OpenAI({ apiKey: process.env.OPENAI_API_KEY! });

export const runtime = "nodejs";

function verifySignatureWithSDK(body: string, signature: string): boolean {
    return streamVideo.verifyWebhook(body, signature);
};

export async function POST(req: NextRequest) {
    const signature = req.headers.get("x-signature");
    const apiKey = req.headers.get("x-api-key");

    if (!signature || !apiKey) {
        return NextResponse.json(
            { error: "Missing signature or API key" },
            { status: 400 }
        );
    }

    const body = await req.text();

    if (!verifySignatureWithSDK(body, signature)) {
        return NextResponse.json({ error: "Invalid signature" }, { status: 401 });
    }

    let payload: unknown;
    try {
        payload = JSON.parse(body) as Record<string, unknown>;
    } catch {
        return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
    }

    const eventType = (payload as Record<string, unknown>)?.type;

    if (eventType === "call.session_started") {
        const event = payload as CallSessionStartedEvent;
        const meetingId = event.call.custom?.meetingId;

        if (!meetingId) {
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
                    not(eq(meetings.status, "processing")),
                )
            );

            if (!existingMeeting) {
                return NextResponse.json({ error: "Meeting not found" }, { status: 404 });
            }

            await db
            .update(meetings)
            .set({
                status: "active",
                startedAt: new Date(),
            })
            .where(eq(meetings.id, existingMeeting.id));

        const [existingAgent] = await db
            .select()
            .from(agents)
            .where(eq(agents.id, existingMeeting.agentId));

            if (!existingAgent) {
                return NextResponse.json({ error: "Agent not found" }, { status: 404 });
            }

            process.env.WS_NO_BUFFER_UTIL = "true";
            process.env.WS_NO_UTF_8_VALIDATE = "true";

        const call = streamVideo.video.call("default", meetingId);
         const realtimeClient = await streamVideo.video.connectOpenAi({
            call,
            openAiApiKey: process.env.OPENAI_API_KEY!,
            agentUserId: existingAgent.id, 
         });

         realtimeClient.updateSession({
            instructions: existingAgent.instructions,
         });

           } else if (eventType === "call.session_participant_left") {
        const event = payload as CallSessionParticipantLeftEvent;
        const meetingId = event.call_cid.split(":")[1]; //call_cid is formatted as "type:id"

        if (!meetingId) {
            return NextResponse.json({ error: "Missing meetingId" }, { status: 400 });
        }

    const call = streamVideo.video.call("default", meetingId);
        await call.end();
    } else if (eventType === "call.session_ended") {
    const event = payload as CallEndedEvent;
    const meetingId = event.call.custom?.meetingId;

        if (!meetingId) {
            return NextResponse.json({ error: "Missing meetingId" }, { status: 400 });
        }

        await db
            .update(meetings)
            .set({
                status: "processing",
                endedAt: new Date(),
            })
            .where(and(eq(meetings.id, meetingId), eq(meetings.status, "active")));
    } else if (eventType === "call.transcription_ready") {
        const event = payload as CallTranscriptionReadyEvent;
        const meetingId = event.call_cid.split(":")[1] // call_cid is formattted as "type:id"

        const [updatedMeeting] = await db
            .update(meetings)
            .set({
                transcriptUrl: event.call_transcription.url,
            })
            .where(eq(meetings.id, meetingId))
            .returning();

            if (!updatedMeeting) {
                return NextResponse.json({ error: "Missing not found" }, { status: 404 });
            }

        await inngest.send({
            name: "meetings/processing",
            data: {
                meetingId: updatedMeeting.id,
                transcriptUrl: updatedMeeting.transcriptUrl,
            },
        });
    } else if (eventType === "call.recording_ready") {
        const event = payload as CallRecordingReadyEvent;
        const meetingId = event.call_cid.split(":")[1] // call_cid is formattted as "type:id"

        await db
            .update(meetings)
            .set({
             recordingUrl: event.call_recording.url,
            })
            .where(eq(meetings.id, meetingId))
        } else if (eventType === "message.new") {
            const event = payload as MessageNewEvent;

            const userId = event.user?.id;
            const channelId = event.channel_id;
            const text = event.message?.text ?? "";

            if (!userId || !channelId || !text) {
                return NextResponse.json(
                    {error: "Missing required fields" },
                    { status: 400 }
                );
            }

            const [existingMeeting] = await db
                .select()
                .from(meetings)
                .where(and(eq(meetings.id, channelId), eq(meetings.status, "completed")));
            
            if (!existingMeeting) {
                return NextResponse.json({ error: "Meeting not found" }, { status: 404 });
            }
        
            const [existingAgent] = await db
                .select()
                .from(agents)
                .where(eq(agents.id, existingMeeting.agentId));
            
            if (!existingAgent) {
                return NextResponse.json({ error: "Agent not found" }, { status: 404 });
            }

            if (userId !== existingAgent.id) {
                const instructions = `
      You are an AI assistant helping the user revisit a recently completed meeting.
      Below is a summary of the meeting, generated from the transcript:
      
      ${existingMeeting.summary}
      
      The following are your original instructions from the live meeting assistant. Please continue to follow these behavioral guidelines as you assist the user:
      
      ${existingAgent.instructions}
      
      The user may ask questions about the meeting, request clarifications, or ask for follow-up actions.
      Always base your responses on the meeting summary above.
      
      You also have access to the recent conversation history between you and the user. Use the context of previous messages to provide relevant, coherent, and helpful responses. If the user's question refers to something discussed earlier, make sure to take that into account and maintain continuity in the conversation.
      
      If the summary does not contain enough information to answer a question, politely let the user know.
      
      Be concise, helpful, and focus on providing accurate information from the meeting and the ongoing conversation.
      `;
      
      const channel = streamChat.channel("messaging", channelId);
      await channel.watch();

      const previousMessages = channel.state.messages
            .slice(-5)
            .filter((msg) => msg.text && msg.text.trim() !== "")
            .map<ChatCompletionMessageParam>((message) => ({
                role:message.user?.id === existingAgent.id ? "assistant" : "user",
                content: message.text || "",
            }));

        const GPTResponse = await openaiClient.chat.completions.create({
            messages: [
                { role: "system", content: instructions },
                ...previousMessages,
                {role: "user", content: text },
            ], 
            model: "gpt-4o",
        });

        const GPTResponseText = GPTResponse.choices[0].message.content;

        if (!GPTResponseText) {
            return NextResponse.json(
                { error: "No response from GPT" },
                { status: 400 }
            );

        const avatarUrl = generateAvatarUri({
            seed: existingAgent.name,
            variant: "botttsNeutral",
        });

        streamChat.upsertUser({
            id: existingAgent.id,
            name: existingAgent.name,
            image: avatarUrl,
        });
        channel.sendMessage({
            text: GPTResponseText ?? "",
            user: {
                id: existingAgent.id,
                name: existingAgent.name, 
                image: avatarUrl,
            },
        });
        }
     }
}

    return NextResponse.json({ status: "ok" });
}