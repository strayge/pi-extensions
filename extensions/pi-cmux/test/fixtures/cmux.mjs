import { appendFileSync } from "node:fs";

let input = "";
for await (const chunk of process.stdin) input += chunk;
appendFileSync(
  process.env.CMUX_TEST_PI_LOG,
  `${JSON.stringify({
    args: process.argv.slice(2),
    payload: input ? JSON.parse(input) : undefined,
    stockDisabled: process.env.CMUX_PI_HOOKS_DISABLED,
  })}\n`,
);
process.stdout.write("{}");
