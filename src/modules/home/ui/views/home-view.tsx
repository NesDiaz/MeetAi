"use client";
import { useTRPC } from "@/trpc/client";

export const HomeView = () => {
  const trpc = useTRPC();
  
  const { data, isLoading, error } = trpc.hello.useQuery({ text: "Antonio" });

  if (isLoading) return <div>Loading...</div>;
  if (error) return <div>Error: {error.message}</div>;

  return (
    <div className="flex flex-col p-4 gap-y-4">
      {data?.greeting ?? "No greeting returned"}
    </div>
  );
};


// "use client";

// import { useTRPC } from "@/trpc/client"; // or wherever your tRPC hook is
// import { useQuery } from "@tanstack/react-query";

// export const HomeView = () => {
//   const trpc = useTRPC();
//   const { data } = useQuery(trpc.hello.queryOptions({ text: "Antonio" }));

//   return (
//     <div className="flex flex-col p-4 gap-y-4">
//       {data?.greeting}
//     </div>
//   );
// };

// import { authClient } from "@/lib/auth-client"; 
// import { Button } from "@/components/ui/button";
// import { useRouter } from "next/navigation";

// export const HomeView = () => {
//   const router = useRouter();
//   const { data: session } = authClient.useSession();

//   if (!session) {
//     return (
//       <p>Loading...</p>
//     )
//   }

//   return (
//     <div className="flex flex-col p-4 gap-y-4">
//           <p>Logged in as {session.user.name}</p>
//            <Button onClick={() => authClient.signOut({
//             fetchOptions: {
//               onSuccess: () => router.push("/sign-in"),
//             }
//            })}>
//             Sign out
//            </Button>
//        </div>
//    )};