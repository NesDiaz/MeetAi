"use client";

import { LoaderIcon } from "lucide-react";
import { useEffect, useState } from "react";
import { useMutation } from "@tanstack/react-query";
import {
  StreamCall,
  StreamVideo,
  StreamVideoClient,
  type Call,           // <-- ADD THIS
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
  const [call, setCall] = useState<Call | null>(null); // <-- FIXED TYPE

  // Initialize Stream client ONLY (no auto join)
  useEffect(() => {
    const _client = new StreamVideoClient({
      apiKey: process.env.NEXT_PUBLIC_STREAM_VIDEO_API_KEY!,
      user: {
        id: userId,
        name: userName,
        image: userImage,
      },
      tokenProvider: generateToken,
    });

    setClient(_client);

    return () => {
      _client.disconnectUser();
    };
  }, [userId, userName, userImage, generateToken]);

  // Create call instance ONLY (no auto join)
  useEffect(() => {
    if (!client) return;

    const _call = client.call("default", meetingId);
    setCall(_call);

    return () => {
      _call.leave().catch(() => {});
    };
  }, [client, meetingId]);

  if (!client || !call) {
    return (
      <div className="flex h-screen items-center justify-center bg-radial from-sidebar-accent to-sidebar">
        <LoaderIcon className="size-6 animate-spin text-white" />
      </div>
    );
  }

  return (
    <StreamVideo client={client}>
      {/* Call is created but NOT JOINED until user clicks the join button */}
      <StreamCall call={call}>
        <CallUI meetingName={meetingName} />
      </StreamCall>
    </StreamVideo>
  );
};


// "use client";

// import { LoaderIcon } from "lucide-react";
// import { useEffect, useState } from "react";
// import { useMutation } from "@tanstack/react-query";
// import {
//   Call,
//   CallingState,
//   StreamCall,
//   StreamVideo,
//   StreamVideoClient,
// } from "@stream-io/video-react-sdk";

// import { useTRPC } from "@/trpc/client";
// import "@stream-io/video-react-sdk/dist/css/styles.css";
// import { CallUI } from "./call-ui";

// interface Props {
//   meetingId: string;
//   meetingName: string;
//   userId: string;
//   userName: string;
//   userImage: string;
// }

// export const CallConnect = ({
//   meetingId,
//   meetingName,
//   userId,
//   userName,
//   userImage,
// }: Props) => {
//   const trpc = useTRPC();
//   const { mutateAsync: generateToken } = useMutation(
//     trpc.meetings.generateToken.mutationOptions(),
//   );

//   const [client, setClient] = useState<StreamVideoClient | null>(null);
//   const [call, setCall] = useState<Call | null>(null);

//   // Create Stream client
//   useEffect(() => {
//     const apiKey = process.env.NEXT_PUBLIC_STREAM_VIDEO_API_KEY;
//     if (!apiKey) {
//       console.error("Missing NEXT_PUBLIC_STREAM_VIDEO_API_KEY");
//       return;
//     }

//     const _client = new StreamVideoClient({
//       apiKey,
//       user: {
//         id: userId,
//         name: userName,
//         image: userImage,
//       },
//       tokenProvider: () => generateToken(),
//     });

//     setClient(_client);

//     return () => {
//       _client.disconnectUser();
//       setClient(null);
//     };
//   }, [userId, userName, userImage, generateToken]);

//   // Create call instance (no join here)
//   useEffect(() => {
//     if (!client) return;

//     const _call = client.call("default", meetingId);
//     _call.camera.disable();
//     _call.microphone.disable();
//     setCall(_call);

//     return () => {
//       if (_call.state.callingState !== CallingState.LEFT) {
//         _call.leave().catch(() => undefined);
//       }
//       setCall(null);
//     };
//   }, [client, meetingId]);

//   if (!client || !call) {
//     return (
//       <div className="flex h-screen items-center justify-center bg-radial from-sidebar-accent to-sidebar">
//         <LoaderIcon className="size-6 animate-spin text-white" />
//       </div>
//     );
//   }

//   return (
//     <StreamVideo client={client}>
//       <StreamCall call={call}>
//         <CallUI meetingName={meetingName} />
//       </StreamCall>
//     </StreamVideo>
//   );
// };
