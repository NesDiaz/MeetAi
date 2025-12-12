import { inngest } from "@/inngest/client";
import { streamVideo } from "@/lib/stream-video";

export const agentStart = inngest.createFunction(
  { id: "agent/start" },
  { event: "agent/start" },
  async ({ event }) => {
    const { meetingId, agentId, instructions } = event.data;

    if (!meetingId || !agentId) {
      throw new Error("Missing meetingId or agentId");
    }

    const call = streamVideo.video.call("default", meetingId);

    // 1️⃣ Connect agent
    const realtime = await streamVideo.video.connectOpenAi({
      call,
      agentUserId: agentId,
      openAiApiKey: process.env.OPENAI_API_KEY!,
      model: "gpt-4o-realtime-preview",
    });

    // 2️⃣ Enable voice + listening
    realtime.updateSession({
      instructions,
      modalities: ["text", "audio"],
      voice: "alloy",
      turn_detection: {
        type: "server_vad",
        silence_duration_ms: 800,
      },
    });

    // ⛔ NO sendEvent — not supported

    return { ok: true };
  }
);


// Code that agent showes up in
// import { inngest } from "@/inngest/client";
// import { streamVideo } from "@/lib/stream-video";

// export const agentStart = inngest.createFunction(
//   { id: "agent/start" },
//   { event: "agent/start" },
//   async ({ event }) => {
//     const { meetingId, agentId, instructions } = event.data;

//     if (!meetingId || !agentId) {
//       throw new Error("Missing meetingId or agentId");
//     }

//     const call = streamVideo.video.call("default", meetingId);

//   type ConnectOpenAIParams = Parameters<
//   typeof streamVideo.video.connectOpenAi
// >[0] & {
//   session?: {
//     instructions?: string;
//   };
// };

// const params: ConnectOpenAIParams = {
//   call,
//   agentUserId: agentId,
//   openAiApiKey: process.env.OPENAI_API_KEY!,
//   model: "gpt-4o-realtime-preview",
//   session: {
//     instructions,
//   },
// };

// await streamVideo.video.connectOpenAi(params);


//     return { ok: true };
//   }
// );
