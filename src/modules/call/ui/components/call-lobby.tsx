"use client";

import { LogInIcon } from "lucide-react";
import {
  DefaultVideoPlaceholder,
  StreamVideoParticipant,
  ToggleAudioPreviewButton,
  ToggleVideoPreviewButton,
  useCallStateHooks,
  VideoPreview,
} from "@stream-io/video-react-sdk";

import { authClient } from "@/lib/auth-client";
import { Button } from "@/components/ui/button";
import { generateAvatarUri } from "@/lib/avatar";
import { useTRPC } from "@/trpc/client"; // ✅ same as your meeting files
import { MeetingStatus } from "@/modules/meetings/types";
import { useParams, useRouter } from "next/navigation";
import { useMutation, useQueryClient } from "@tanstack/react-query"; // ✅ needed for invalidate
import { toast } from "sonner";
import { useConfirm } from "@/hooks/use-confirm"; // ✅ your existing confirm hook
import "@stream-io/video-react-sdk/dist/css/styles.css";
import Link from "next/link";
interface CallLobbyProps {
  onJoin: () => void;
}

const DisabledVideoPreview = () => {
  const { data } = authClient.useSession();

  return (
    <DefaultVideoPlaceholder
      participant={
        {
          name: data?.user.name ?? "",
          image:
            data?.user.image ??
            generateAvatarUri({
              seed: data?.user.name ?? "",
              variant: "initials",
            }),
        } as StreamVideoParticipant
      }
    />
  );
};

const AllowBrowserPermissions = () => (
  <p className="text-sm">
    Please grant your browser permission to access your camera and microphone.
  </p>
);

export const CallLobby = ({ onJoin }: CallLobbyProps) => {
  const { useCameraState, useMicrophoneState } = useCallStateHooks();
  const { hasBrowserPermission: hasMicPermission } = useMicrophoneState();
  const { hasBrowserPermission: hasCameraPermission } = useCameraState();
  const hasBrowserMediaPermission = hasCameraPermission && hasMicPermission;

  const router = useRouter();
  const { meetingId } = useParams() as { meetingId: string };
  const trpc = useTRPC();
  const queryClient = useQueryClient();

  // ✅ confirmation dialog (reuses your existing hook)
  const [RemoveConfirmation, confirmRemove] = useConfirm(
    "Are you sure?",
    "This will cancel the meeting."
  );

  // ✅ cancel meeting mutation
  const cancelMeeting = useMutation(
    trpc.meetings.update.mutationOptions({
      onSuccess: async () => {
        await queryClient.invalidateQueries(trpc.meetings.getMany.queryOptions({}));
        await queryClient.invalidateQueries(
          trpc.meetings.getOne.queryOptions({ id: meetingId })
        );
        toast.success("Meeting cancelled");
        router.push("/meetings");
      },
      onError: (error) => {
        toast.error(error.message);
      },
    })
  );

  const handleCancelMeeting = async () => {
    const ok = await confirmRemove();
    if (!ok) return;

    cancelMeeting.mutate({
      id: meetingId,
      status: MeetingStatus.Cancelled,
    });
  };

  return (
    <>
      {/* ✅ add your confirmation modal */}
      <RemoveConfirmation />

      <div className="flex flex-col items-center justify-center h-full bg-radial from-sidebar-accent to-sidebar">
        <div className="py-4 px-8 flex flex-1 items-center justify-center">
          <div className="flex flex-col items-center justify-center gap-y-6 bg-background rounded-lg p-10 shadow-sm">
            <div className="flex flex-col gap-y-2 text-center">
              <h6 className="text-lg font-medium">Ready to Join?</h6>
              <p className="text-sm">Set up your call before joining</p>
            </div>

            <VideoPreview
              DisabledVideoPreview={
                hasBrowserMediaPermission
                  ? DisabledVideoPreview
                  : AllowBrowserPermissions
              }
            />

            <div className="flex gap-x-2">
              <ToggleAudioPreviewButton />
              <ToggleVideoPreviewButton />
            </div>

            <div className="flex gap-x-2 justify-between w-full">
              <Button
                variant="destructive"
                onClick={handleCancelMeeting}
                disabled={cancelMeeting.isPending}
              >
                 <Link href="/meetings">                           
                 Cancel
                </Link>
              </Button>

              <Button onClick={onJoin}>
                <LogInIcon className="mr-2 h-4 w-4" />
                Join Call
              </Button>
            </div>
          </div>
        </div>
      </div>
    </>
  );
};


// import { LogInIcon } from "lucide-react";
// import Link from "next/link";
// import {
//     DefaultVideoPlaceholder,
//     StreamVideoParticipant,
//     ToggleAudioPreviewButton,
//     ToggleVideoPreviewButton,
//     useCallStateHooks,
//     VideoPreview,
// } from "@stream-io/video-react-sdk";

// import { authClient } from "@/lib/auth-client";
// import { Button } from "@/components/ui/button";
// import { generateAvatarUri } from "@/lib/avatar";

// import "@stream-io/video-react-sdk/dist/css/styles.css";


// interface Props {
//     onJoin: () => void;
// };

// const DisabledVideoPreview = () => {
//     const { data } = authClient.useSession();

//     return (
//         <DefaultVideoPlaceholder 
//          participant={
//             {
//                 name: data?.user.name ?? "",
//                 image:
//                     data?.user.image ??
//                     generateAvatarUri({
//                         seed: data?.user.name ?? "",
//                         variant: "initials",
//                     }),
//             } as StreamVideoParticipant
//          }
//         />
//     )
// }

// const AllowBrowserPermissions = () => {
//     return (
//         <p className="text-sm">
//             Please grant your browser a permission to access your camera and microphone.
//         </p>
//     );
// };

// export const CallLobby = ({ onJoin }: Props) => {
//     const { useCameraState, useMicrophoneState } = useCallStateHooks();

//     const { hasBrowserPermission: hasMicPermission } = useMicrophoneState();
//     const { hasBrowserPermission: hasCameraPermission } = useCameraState();

//     const hasBrowserMediaPermission = hasCameraPermission && hasMicPermission;

//     return (
//         <div className="flex flex-col items-center justify-center h-full bg-radial from-sidebar-accent to-sidebar">
//             <div className="py-4 px-8 flex flex-1 items-center justify-center">
//                 <div className="flex flex-col items-center justify-center gap-y-6 bg-background rounded-lg p-10 shadow-sm">
//                     <div className="flex flex-col gap-y-2 text-center">
//                         <h6 className="text-lg font-medium">Ready to Join?</h6>
//                         <p className="text-sm">Set up your call before joining</p>
//                     </div>
//                     <VideoPreview 
//                         DisabledVideoPreview={
//                             hasBrowserMediaPermission
//                             ? DisabledVideoPreview
//                             : AllowBrowserPermissions
//                         }
//                     />
//                     <div className="flex gap-x-2">
//                         <ToggleAudioPreviewButton />
//                         <ToggleVideoPreviewButton />
//                     </div>
//                     <div className="flex gap-x-2 justify-between w-full">
//                         <Button asChild variant="ghost">
//                             <Link href="/meetings">
//                             Cancel
//                             </Link>
//                         </Button>
//                         <Button
//                             onClick={onJoin}
//                         >
//                             <LogInIcon />
//                             Join Call
//                         </Button>
//                     </div>
//                 </div>
//             </div>
//         </div>
//     )
// }