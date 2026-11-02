#!/usr/bin/env node
// Development entry point. The distributed form is the bundle this repository
// builds into `skills/revise-and-resubmit/bin/cli.mjs` (decision record 0004).
import { main } from "../src/main.ts";

await main(process.argv.slice(2));
