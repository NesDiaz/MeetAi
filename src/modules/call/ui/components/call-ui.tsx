import { StreamTheme, useCall } from "@stream-io/video-react-sdk";
import { useState } from "react";
import { CallLobby } from "./call-lobby";
import { CallActive } from "./call-active";
import { CallEnded } from "./call-ended";

interface Props {
  meetingName: string;
}

export const CallUI = ({ meetingName }: Props) => {
  const call = useCall();
  const [show, setShow] = useState<"lobby" | "call" | "ended">("lobby");

  const [isJoining, setIsJoining] = useState(false);

  const handleJoin = async () => {
    if (!call || isJoining) return;
  
    const state = call.state.callingState;
    if (state === "joined" || state === "joining") return;
  
    setIsJoining(true);
    try {
      await call.join();
      setShow("call");
    } finally {
      setIsJoining(false);
    }
  };
 

  const handleLeave = () => {
    if (!call) return;
    call.endCall();
    setShow("ended");
  };

  return (
    <StreamTheme className="h-full">
      {show === "lobby" && <CallLobby onJoin={handleJoin} />}
      {show === "call" && (
        <CallActive onLeave={handleLeave} meetingName={meetingName} />
      )}
      {show === "ended" && <CallEnded />}
    </StreamTheme>
  );
};


// original 
// import { StreamTheme, useCall } from "@stream-io/video-react-sdk";
// import { useState } from "react";
// import { CallLobby } from "./call-lobby";
// import { CallActive } from "./call-active";
// import { CallEnded } from "./call-ended";

// interface Props {
//     meetingName: string;
// };

// export const CallUI = ({ meetingName }: Props) => {
//     const call = useCall();
//     const [show, setShow] = useState<"lobby" | "call" | "ended">("lobby");

//     const handleJoin = async () => {
//         if (!call) return;

//         await call.join();

//         setShow("call");
//     };

//     const handleLeave = () => {
//         if (!call) return;

//         call.endCall();
//         setShow("ended")
//     };

//     return (
//         <StreamTheme className="h-full">
//             {show === "lobby" && <CallLobby onJoin={handleJoin} />}
//             {show === "call" && <CallActive onLeave={handleLeave} meetingName={meetingName} />}
//             {show === "ended" && <CallEnded />}
//         </StreamTheme>
//     )
// };