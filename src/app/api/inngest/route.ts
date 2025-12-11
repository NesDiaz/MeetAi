import { serve } from "inngest/next";
import { inngest } from "@/inngest/client";
import { meetingsProcessing } from "@/inngest/functions"; 
import { agentStart } from "@/inngest/agent-start";

export const { GET, POST, PUT } = serve({
  client: inngest,
  functions: [
    meetingsProcessing,
    agentStart,
  ],
});
