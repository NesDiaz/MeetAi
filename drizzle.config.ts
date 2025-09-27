import { defineConfig } from "drizzle-kit";

export default defineConfig({
  schema: "./src/db/schema.ts",   // adjust path if different
  out: "./drizzle",                   // migrations folder
  dialect: "postgresql",              // ✅ REQUIRED now
  dbCredentials: {
    url: process.env.DATABASE_URL!,   // your connection string
  },
});


// import 'dotenv/config';
// import { defineConfig } from "drizzle-kit";

// export default defineConfig({
//   out: './drizzle',
//   schema: './src/db/schema.ts',
//   dialect: 'postgresql',
//   dbCredentials: {
//     url: process.env.DATABASE_URL!,
//   },
// });
