import { serve } from "inngest/next";
import { inngest } from "@/inngest/client";
import { meetingsProcessing } from "@/inngest/functions";
import { agentStart } from "@/inngest/functions/agent-start";

export const { GET, POST, PUT } = serve({
  client: inngest,
  functions: [
    agentStart,        // AI agent connection handler
    meetingsProcessing // Summarizer
  ],
});



// ORIGINAL 
// import { serve } from "inngest/next";
// import { inngest } from "@/inngest/client";
// import { meetingsProcessing } from "@/inngest/functions"; 

// export const { GET, POST, PUT } = serve({
//   client: inngest,
//   functions: [
//     meetingsProcessing,
//   ],
// });
