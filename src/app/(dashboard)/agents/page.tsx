/* testing code */
// import { auth } from "@/lib/auth";
// import { AgentsListHeader } from "@/modules/agents/ui/components/agents-list-header";
// import { AgentsView, AgentsViewError, AgentsViewLoading } from "@/modules/agents/ui/views/agents-view";
// import { getQueryClient, trpc } from "@/trpc/server";
// import { dehydrate, HydrationBoundary } from "@tanstack/react-query";
// import { headers } from "next/headers";
// import { redirect } from "next/navigation";
// import { Suspense } from "react";
// import { ErrorBoundary } from "react-error-boundary";
// import { SearchParams } from "nuqs";
// import { loadSearchParams } from "@/modules/agents/params";

// interface Props {
//   searchParams: Promise<SearchParams>; // ✅ wrap in Promise
// }

// export default async function Page({ searchParams }: Props) {
//   const resolvedSearchParams = await searchParams;
//   const filters = await loadSearchParams(resolvedSearchParams);

//   const session = await auth.api.getSession({ headers: await headers() });
//   if (!session) redirect("/sign-in");

//   const queryClient = getQueryClient();
//   void queryClient.prefetchQuery(trpc.agents.getMany.queryOptions({ ...filters }));

//   return (
//     <HydrationBoundary state={dehydrate(queryClient)}>
//       <AgentsListHeader />
//       <Suspense fallback={<AgentsViewLoading />}>
//         <ErrorBoundary fallback={<AgentsViewError />}>
//           <AgentsView />
//         </ErrorBoundary>
//       </Suspense>
//     </HydrationBoundary>
//   );
// }


// ORIGINAL CODE
 import { auth } from "@/lib/auth";
import { AgentsListHeader } from "@/modules/agents/ui/components/agents-list-header";
import { AgentsView, AgentsViewError, AgentsViewLoading } from "@/modules/agents/ui/views/agents-view";
import { getQueryClient, trpc } from "@/trpc/server";
import { dehydrate, HydrationBoundary } from "@tanstack/react-query";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { SearchParams } from "nuqs";
import { Suspense } from "react";
import { ErrorBoundary } from "react-error-boundary";

import { loadSearchParams } from "@/modules/agents/params";
// interface Props {
//   searchParams: Promise<SearchParams>
// }
interface Props {
  searchParams: SearchParams; // ✅ no Promise here
}

const Page = async ({ searchParams }: Props) => {
  const filters = await loadSearchParams(searchParams);

 const session = await auth.api.getSession({
    headers: await headers(),
  });

  if (!session) {
    redirect("/sign-in");
  }

  const queryClient = getQueryClient();
  await queryClient.prefetchQuery(trpc.agents.getMany.queryOptions({
    ...filters,
  }));

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