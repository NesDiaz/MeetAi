import { inngest } from "@/inngest/client";
import { streamVideo } from "@/lib/stream-video";

interface RealtimeClientLike {
  updateSession?: (data: { instructions?: string | null }) => Promise<void>;
  send?: (msg: { type: string; text?: string }) => Promise<void>;
}

export const agentStart = inngest.createFunction(
  { id: "agent/start" },
  { event: "agent/start" },
  async ({ event }) => {
    const { meetingId, agentId } = event.data as {
      meetingId: string;
      agentId: string;
    };

    console.log("🧠 Inngest agent/start:", { meetingId, agentId });

    // Get the call from Stream Video
    const call = streamVideo.video.call("default", meetingId);

    // Connect the OpenAI Realtime agent via Stream Video client (NOT on the call object)
    const realtimeClient = (await streamVideo.video.connectOpenAi({
      call,
      openAiApiKey: process.env.OPENAI_API_KEY!,
      agentUserId: agentId,
    })) as RealtimeClientLike;

    // Optional: set base instructions here (you can later load real instructions from DB)
    if (realtimeClient.updateSession) {
      await realtimeClient.updateSession({
        instructions: "You are a friendly AI meeting assistant.",
      });
    }

    // Kick off the agent so it actually starts talking
    if (realtimeClient.send) {
      await realtimeClient.send({
        type: "input_text",
        text: "start",
      });
      console.log("🤖 Agent started via Inngest worker");
    } else {
      console.log("ℹ️ realtimeClient.send not available");
    }

    // Keep the WebSocket alive for the duration of the call
    await new Promise<never>(() => {
      // never resolve – this keeps the worker/process open
    });
  }
);
