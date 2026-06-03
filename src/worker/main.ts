// Entrypoint for `npm run worker` (tsx --tsconfig tsconfig.worker.json). tsx does not
// auto-load .env, so we load it here (like drizzle.config.ts and test/setup.ts do).
import "dotenv/config";
import { runForever } from "@/worker/index";

runForever().then(() => process.exit(0));
