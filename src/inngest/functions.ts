// import JSONL from "jsonl-parse-stringify";
// import { inngest } from "./client";
// import { StreamTranscriptItem } from "@/modules/meetings/types";
// import { eq, inArray } from "drizzle-orm";
// import { db } from "@/db";
// import { agents, meetings, user } from "@/db/schema";
// import { createAgent, openai, TextMessage } from "@inngest/agent-kit";

// const summarizer = createAgent({
//   name: "summarizer",
//   system: `
// You are an expert summarizer. You write readable, concise, simple content. You are given a transcript of a meeting and need to summarize it.

// ### Overview
// Provide a detailed, engaging summary.

// ### Notes
// Break down key sections with timestamps and bullet points.
// `.trim(),
//   model: openai({ model: "gpt-4o", apiKey: process.env.OPENAI_API_KEY }),
// });

// export const meetingsProcessing = inngest.createFunction(
//   { id: "meetings/processing" },
//   { event: "meetings/processing" },
//   async ({ event, step }) => {
//     try {
//       // 1️⃣ Fetch the transcript
//       const text = await step.run("fetch-transcript", async () => {
//         const res = await fetch(event.data.transcriptUrl);
//         if (!res.ok) throw new Error(`Failed to fetch transcript: ${res.statusText}`);
//         return res.text();
//       });

//       // 2️⃣ Parse the JSONL
//       const transcript = await step.run("parse-transcript", async () => {
//         return JSONL.parse<StreamTranscriptItem>(text);
//       });

//       // 3️⃣ Add speaker names
//       const transcriptWithSpeakers = await step.run("add-speakers", async () => {
//         const speakerIds = [...new Set(transcript.map((i) => i.speaker_id))];

//         const [userSpeakers, agentSpeakers] = await Promise.all([
//           db.select().from(user).where(inArray(user.id, speakerIds)),
//           db.select().from(agents).where(inArray(agents.id, speakerIds)),
//         ]);

//         const allSpeakers = [...userSpeakers, ...agentSpeakers];

//         return transcript.map((item) => {
//           const speaker = allSpeakers.find((s) => s.id === item.speaker_id);
//           return {
//             ...item,
//             user: { name: speaker?.name || "Unknown" },
//           };
//         });
//       });

//       // 4️⃣ Summarize
//       const { output } = await step.run("summarize", async () => {
//         return summarizer.run(
//           "Summarize the following transcript: " + JSON.stringify(transcriptWithSpeakers)
//         );
//       });

//       // 5️⃣ Save summary to DB
//       await step.run("save-summary", async () => {
//         await db
//           .update(meetings)
//           .set({
//             summary: (output[0] as TextMessage).content as string,
//             status: "completed",
//           })
//           .where(eq(meetings.id, event.data.meetingId));
//       });

//       console.log("✅ Meeting updated to completed");
//       return { success: true };
//     } catch (err) {
//       console.error("❌ Inngest function failed:", err);
//       await db
//         .update(meetings)
//         .set({ status: "cancelled" })
//         .where(eq(meetings.id, event.data.meetingId));
//       throw err;
//     }
//   }
// );

/*original */
import JSONL from "jsonl-parse-stringify"

import { inngest } from "./client";
import { StreamTranscriptItem } from "@/modules/meetings/types";
import { eq, inArray } from "drizzle-orm";
import { db } from "@/db";
import { agents, meetings, user } from "@/db/schema";
import { createAgent, openai, TextMessage } from "@inngest/agent-kit";

const summarizer = createAgent({
  name: "summarizer",
  system: `You are an expert summarizer. You write readable, concise, simple content. You are given a transcript of a meeting and you need to summarize it.

Use the following markdown structure for every output:

### Overview
Provide a detailed, engaging summary of the session's content. Focus on major features, user workflows, and any key takeaways. Write in a narrative style, using full sentences. Highlight unique or powerful aspects of the product, platform, or discussion.

### Notes
Break down key content into thematic sections with timestamp ranges. Each section should summarize key points, actions, or demos in bullet format.

Example:
#### Section Name
- Main point or demo shown here
- Another key insight or interaction
- Follow-up tool or explanation provided

#### Next Section
- Feature X automatically does Y
- Mention of integration with Z
`.trim(),
model: openai({ model: "gpt-4o", apiKey: process.env.OPENAI_API_KEY }),
});

export const meetingsProcessing = inngest.createFunction(
  { id: "meetings/processing" },
  { event: "meetings/processing" },
  async ({ event, step }) => {
    const response = await fetch(event.data.transcriptUrl);
// TODO: change before deployment 
// const response = await step.run("fetch-transcript", async () => {
//    return fetch(event.data.transcriptUrl).then((res) => res.text());
//   });

    const transcript = await step.run("parse-transcript", async () => {
      const text = await response.text();
      return JSONL.parse<StreamTranscriptItem>(text);

// cosnt transcript = await step.run("parse-transcript", async () => {
//  return JSONL.parse<StreamTranscriptItem>(response);
//  });      
      
    });

    const transcriptWithSpeakers = await step.run("add-speakers", async () => {
      const speakerIds = [
        ...new Set(transcript.map((item) => item.speaker_id)),
      ];

      const userSpeakers = await db
        .select()
        .from(user)
        .where(inArray(user.id, speakerIds))
        .then((users) =>
            users.map((user) => ({
              ...user,
            }))
          );

          const agentSpeakers = await db
          .select()
          .from(agents)
          .where(inArray(agents.id, speakerIds))
          .then((agents) =>
            agents.map((agent) => ({
                ...agent,
              }))
            );

            const speakers = [...userSpeakers, ...agentSpeakers];

            return transcript.map((item) => {
              const speaker = speakers.find(
                (speaker) => speaker.id === item.speaker_id
              );

              if (!speaker) {
                return {
                  ...item,
                  user: {
                    name: "Unknown",
                  },
                };
              }

              return {
                ...item,
                user: {
                  name: speaker.name,
                },
              };
            });
          });

          const { output } = await summarizer.run(
            "Summarize the following transcript: " +
            JSON.stringify(transcriptWithSpeakers)
          );

          await step.run("save-summary", async () => {
            await db
            .update(meetings)
            .set({
              summary: (output[0] as TextMessage).content as string,
              status: "completed",
            })
              .where(eq(meetings.id, event.data.meetingId))
          })
      },
  );