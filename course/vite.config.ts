import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const here = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  plugins: [react()],
  base: "./",
  resolve: {
    // The course imports the REAL engine logic (criteria, feedback, prompt
    // assembly) straight from ../src, so demos can't drift from the code.
    alias: { "@src": path.resolve(here, "../src") },
  },
});
