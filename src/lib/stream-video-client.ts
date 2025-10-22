"use client";

import { StreamVideoClient } from "@stream-io/video-react-sdk";

let streamClient: StreamVideoClient | null = null;

export const getOrCreateStreamClient = (
  apiKey: string,
  user: { id: string; name: string; image?: string },
  tokenProvider: () => Promise<string>
) => {
  if (!streamClient) {
    streamClient = new StreamVideoClient({
      apiKey,
      user,
      tokenProvider,
    });
  }

  return streamClient;
};
