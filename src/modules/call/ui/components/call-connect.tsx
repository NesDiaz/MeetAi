"use client";

import { LoaderIcon } from "lucide-react";
import { useEffect, useState } from "react";
import { useMutation } from "@tanstack/react-query";
import {
  Call,
  StreamCall,
  StreamVideo,
  StreamVideoClient,
} from "@stream-io/video-react-sdk";

import { useTRPC } from "@/trpc/client";
import "@stream-io/video-react-sdk/dist/css/styles.css";
import { CallUI } from "./call-ui";

interface Props {
  meetingId: string;
  meetingName: string;
  userId: string;
  userName: string;
  userImage: string;
}

export const CallConnect = ({
  meetingId,
  meetingName,
  userId,
  userName,
  userImage,
}: Props) => {
  const trpc = useTRPC();
  const { mutateAsync: generateToken } = useMutation(
    trpc.meetings.generateToken.mutationOptions()
  );

  const [client, setClient] = useState<StreamVideoClient | null>(null);
  const [call, setCall] = useState<Call | null>(null);

  // 1) Create StreamVideoClient
  useEffect(() => {
    let cancelled = false;
    let localClient: StreamVideoClient | null = null;

    (async () => {
      try {
        const token = await generateToken();

        if (cancelled) return;

        localClient = new StreamVideoClient({
          apiKey: process.env.NEXT_PUBLIC_STREAM_VIDEO_API_KEY!,
          user: {
            id: userId,
            name: userName,
            image: userImage,
          },
          tokenProvider: async () => token,
        });

        if (!cancelled) {
          setClient(localClient);
        }
      } catch (err) {
        console.error("Error creating StreamVideoClient:", err);
      }
    })();

    return () => {
      cancelled = true;
      if (localClient) {
        localClient.disconnectUser();
      }
      setClient(null);
    };
  }, [generateToken, userId, userName, userImage]);

  // 2) Create Call object (NO auto-join here)
  useEffect(() => {
    if (!client) return;

    const _call = client.call("default", meetingId);

    // start with camera/mic off
    _call.camera.disable();
    _call.microphone.disable();

    setCall(_call);

    return () => {
      _call.leave().catch(() => {
        // ignore
      });
      setCall(null);
    };
  }, [client, meetingId]);

  // 3) Loading state while client+call are not ready
  if (!client || !call) {
    return (
      <div className="flex h-screen items-center justify-center bg-radial from-sidebar-accent to-sidebar">
        <LoaderIcon className="size-6 animate-spin text-white" />
      </div>
    );
  }

  // 4) Provide client + call to the UI
  return (
    <StreamVideo client={client}>
      <StreamCall call={call}>
        <CallUI meetingName={meetingName} />
      </StreamCall>
    </StreamVideo>
  );
};
