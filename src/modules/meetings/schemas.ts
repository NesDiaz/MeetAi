import { z } from "zod";
import { MeetingStatus } from "./types";

export const meetingsInsertSchema = z.object({
        name: z.string().min(1, { message: "Name is required" }),
        agentId: z.string().min(1, { message: "Agent is required" }),
        recordingUrl: z.string().url().optional(),
           });

export const meetingsUpdateSchema = z.object({
  id: z.string().min(1, { message: "Id is required" }),
  name: z.string().optional(),
  agentId: z.string().optional(),
  recordingUrl: z.string().url().optional(),
  status: z.nativeEnum(MeetingStatus).optional(), // ✅ key fix
});
