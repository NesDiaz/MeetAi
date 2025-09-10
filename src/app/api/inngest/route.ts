import { serve } from "inngest/next";
import { inngest } from "@/inngest/client";
import { meetingsProcessing } from "@/inngest/functions"; // <--- add this

export const { GET, POST, PUT } = serve({
  client: inngest,
  functions: [
    meetingsProcessing,
  ],
});
