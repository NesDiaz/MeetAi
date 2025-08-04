import { auth } from "@/lib/auth";
import { AgentsListHeader } from "@/modules/agents/server/ui/components/agents-list-header";
import { AgentsView, AgentsViewError, AgentsViewLoading } from "@/modules/agents/server/ui/views/agents-view";
import { getQueryClient, trpc } from "@/trpc/server";
import { dehydrate, HydrationBoundary } from "@tanstack/react-query";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { Suspense } from "react";
import { ErrorBoundary } from "react-error-boundary";

// Note: This is a SERVER COMPONENT (because it's async)
const Page = async () => {
 const session = await auth.api.getSession({
    headers: await headers(),
  });

  if (!session) {
    redirect("/sign-in");
  }

  const queryClient = getQueryClient();

  // Prefetch data on the server
  await queryClient.prefetchQuery(trpc.agents.getMany.queryOptions());

  // Dehydrate server state once
  const dehydratedState = dehydrate(queryClient);

  return (
    <>
    <AgentsListHeader />
    <HydrationBoundary state={dehydratedState}>
      <Suspense fallback={<AgentsViewLoading />}>
        <ErrorBoundary fallback={<AgentsViewError />}>
          <AgentsView />
        </ErrorBoundary>
      </Suspense>
    </HydrationBoundary>
    </>
  );
};

export default Page;


// import { AgentsView, AgentsViewError, AgentsViewLoading } from "@/modules/agents/server/ui/views/agents-view"
// import { getQueryClient, trpc } from "@/trpc/server";
// import { dehydrate, HydrationBoundary } from "@tanstack/react-query";
// import { Suspense } from "react";
// import { ErrorBoundary } from "react-error-boundary";

// const Page = async () => {
//     const queryClient = getQueryClient();
//     void queryClient.prefetchQuery(trpc.agents.getMany.queryOptions());
    
//     return ( 
//     <HydrationBoundary state={dehydrate(queryClient)}>
//         <Suspense fallback={<AgentsViewLoading />}>
//         <ErrorBoundary fallback={<AgentsViewError />}>
//      <AgentsView />  
//       </ErrorBoundary>
//      </Suspense>
//     </HydrationBoundary>
    

// );
// };

// export default Page;