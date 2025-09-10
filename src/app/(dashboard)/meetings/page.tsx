// app/(dashboard)/meetings/page.tsx
// import { MeetingsListHeader } from "@/modules/meetings/ui/components/meetings-list-header";
// import { MeetingsView, MeetingsViewError, MeetingsViewLoading } from "@/modules/meetings/ui/views/meetings-view";

// import { dehydrate, HydrationBoundary } from "@tanstack/react-query";
// import { getQueryClient, trpc } from "@/trpc/server";

// import { Suspense } from "react";
// import { ErrorBoundary } from "react-error-boundary";

// export default async function Page() {

//   const queryClient = getQueryClient();
//    void queryClient.prefetchQuery(trpc.meetings.getMany.queryOptions({
//      ...filters,
//   }));


//   return (
//     <>
//     <HydrationBoundary state={dehydrate(queryClient)}>
//       <MeetingsListHeader />
//       <Suspense fallback={<MeetingsViewLoading />}>
//         <MeetingsViewError />
//         <ErrorBoundary fallback={<MeetingsViewError />}>
//         <MeetingsView />
//         </ErrorBoundary>
//       </Suspense>
//     </HydrationBoundary>
//     </>
//   );
// }
 // error testing page

 /*Original code */
import { auth } from "@/lib/auth";
import { loadSearchParams } from "@/modules/agents/params";
import { MeetingsListHeader } from "@/modules/meetings/ui/components/meetings-list-header";
import { MeetingsView, MeetingsViewError, MeetingsViewLoading } from "@/modules/meetings/ui/views/meetings-view";
import { getQueryClient, trpc } from "@/trpc/server";
import { dehydrate, HydrationBoundary } from "@tanstack/react-query";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { SearchParams } from "nuqs";
import { Suspense } from "react";
import { ErrorBoundary } from "react-error-boundary";

interface Props {
  searchParams: Promise<SearchParams>;
}

const Page = async ({searchParams }: Props ) => {
  const filters = await loadSearchParams(searchParams);

 const session = await auth.api.getSession({
    headers: await headers(),
  });

  if (!session) {
    redirect("/sign-in");
  }

  const queryClient = getQueryClient();
  void queryClient.prefetchQuery(trpc.meetings.getMany.queryOptions({
    ...filters,
  }));

  return (
  <>
 
    <HydrationBoundary state={dehydrate(queryClient)}>
      <MeetingsListHeader /> 
      <Suspense fallback={<MeetingsViewLoading />}>
        <ErrorBoundary fallback={<MeetingsViewError />}>
          <MeetingsView />
        </ErrorBoundary>
      </Suspense>
    </HydrationBoundary>
    </>
  );
};

export default Page;
