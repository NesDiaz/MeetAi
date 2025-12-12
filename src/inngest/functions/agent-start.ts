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

    type ConnectOpenAIParams = Parameters<
    typeof streamVideo.video.connectOpenAi
  >[0] & {
    session?: {
      instructions?: string;
    };
  };
  
  const params: ConnectOpenAIParams = {
    call,
    agentUserId: agentId,
    openAiApiKey: process.env.OPENAI_API_KEY!,
    model: "gpt-4o-realtime-preview",
    session: {
      instructions,
    },
  };
  
  await streamVideo.video.connectOpenAi(params);
  

    return { ok: true };
  }
);
