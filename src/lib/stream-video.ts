import "server-only";

import { StreamClient } from "@stream-io/node-sdk";

export const streamVideo = new StreamClient(
    process.env.NEXT_PUBLIC_STREAM_VIDEO_API_KEY!,
    process.env.STREAM_VIDEO_SECRET_KEY!
);
console.log("🔐 STREAM_VIDEO_SECRET_KEY:", process.env.STREAM_VIDEO_SECRET_KEY);
console.log("🚀 STREAM VIDEO KEYS CHECK:");
console.log("NEXT_PUBLIC_STREAM_VIDEO_API_KEY =", process.env.NEXT_PUBLIC_STREAM_VIDEO_API_KEY);

