#!/usr/bin/env node
import { register } from "tsx/esm/api";

register();
const { runMain } = await import("./src/cli.ts");
process.exit(await runMain());
