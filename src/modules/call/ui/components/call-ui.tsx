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

  if (!call) return null; // 🔒 Prevent premature render

  const handleJoin = async () => {
    if (isJoining) return;
    const state = call.state.callingState;

    if (state === "joined" || state === "joining") return;

    setIsJoining(true);
    try {
      await call.join();
      setShow("call");
    } catch (e) {
      console.error("Join failed:", e);
      setShow("ended");
    } finally {
      setIsJoining(false);
    }
  };

  const handleLeave = () => {
    call.endCall();
    setShow("ended");
  };

  // 🔄 Listen for automatic call-end events
  call.on("call.ended", () => setShow("ended"));

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
