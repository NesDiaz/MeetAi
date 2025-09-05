"use client";

import { ErrorState } from "@/components/error-state";
import { LoadingState } from "@/components/loading-state";
import { useTRPC } from "@/trpc/client";
import { useQueryClient, useSuspenseQuery, useMutation } from "@tanstack/react-query";
import { MeetingIdViewHeader } from "../components/meeting-id-view-header";


import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { useConfirm } from "@/hooks/use-confirm";
import { useState } from "react";
import { UpdateMeetingDialog } from "../components/update-meeting-dialog";
import { UpcomingState } from "../components/upcoming-state";
import { ActiveState } from "../components/active-state";
import { CancelledState } from "../components/cancelled-state";
import { ProcessingState } from "../components/processing-state";


interface Props {
  meetingId: string;
}

export const MeetingIdView = ({ meetingId }: Props) => {
 
  const trpc = useTRPC();
  const router = useRouter();
  const queryClient = useQueryClient();

 const [updateMeetingDialogOpen, setUpdateMeetingDialogOpen] = useState(false);
const { data } = useSuspenseQuery(trpc.meetings.getOne.queryOptions({ id: meetingId }));

  const removeMeeting = useMutation(
    trpc.meetings.remove.mutationOptions({
      onSuccess: async () => {
         await queryClient.invalidateQueries(trpc.meetings.getMany.queryOptions({}));
        //TODO: Invalidate free tier usage
        router.push("/meetings");
      },
       onError: (error) => {
       toast.error(error.message);
       },    
    })
  );

  const [RemoveConfirmation, confirmRemove] = useConfirm(
   "Are you sure?",
   "The following action will remove this meeting"
   );

  const handleRemoveMeeting = async () => {
   const ok = await confirmRemove();

    if (!ok) return;

    await removeMeeting.mutateAsync({ id: meetingId });
  };

  const isActive = data.status === "active";
  const isUpcoming = data.status === "upcoming";
  const isCancelled= data.status === "cancelled";
  const isCompleted = data.status === "completed";
  const isProcessing = data.status === "processing";

  return (
    <>
    <RemoveConfirmation />
    <UpdateMeetingDialog 
      open={updateMeetingDialogOpen}
      onOpenChange={setUpdateMeetingDialogOpen}
      initialValues={data}
     />
   <div className="flex-1 py-4 px-4 md:px-8 flex flex-col gap-y-4">
    {/* {JSON.stringify(data, null, 2)} */}

      <MeetingIdViewHeader
        meetingId={meetingId}
        meetingName={data.name}
        onEdit={() => setUpdateMeetingDialogOpen(true)}
       onRemove={handleRemoveMeeting}
      />
        {isCancelled && <CancelledState />}
        {isCompleted && <div>completed</div>}
        {isProcessing && <ProcessingState />}
        {isActive && <ActiveState meetingId={meetingId} />}
        {isUpcoming && <UpcomingState 
            meetingId={meetingId}
            onCancelMeeting={() => {}}
            isCancelling={false}
        />}
    </div>
    </>
);
};

 export const MeetingIdViewLoading = () => {
 return (
    <LoadingState
      title="Loading Meeting"
      description="This may take a few seconds"
     />
  );
 };
 export const MeetingIdViewError = () => {
  return (
    <ErrorState
      title="Error Loading Meeting"
      description="Something went wrong"
    />
  );
  };
