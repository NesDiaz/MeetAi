// "use client";

// import { useQuery } from "@tanstack/react-query";
// import { getMeetings } from "@/modules/meetings/api";

// export function MeetingsList() {
//   const { data, isLoading, error } = useQuery({
//     queryKey: ["meetings", { page: 1 }], // match prefetch key
//     queryFn: () => getMeetings({ page: 1 }),
//   });

//   if (isLoading) return <div>Loading...</div>;
//   if (error) return <div>Something went wrong</div>;

//   return (
//     <ul>
//       {data?.map((meeting: any) => (
//         <li key={meeting.id}>{meeting.title}</li>
//       ))}
//     </ul>
//   );
// }

 // error testing page
