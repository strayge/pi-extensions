const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);
const text = Buffer.concat(chunks).toString("utf8");
const lines = text.split("\n");
let matches = 0;
for (let i = 0; i < lines.length; i++) {
  if (!lines[i].includes("needle")) continue;
  process.stdout.write(`${JSON.stringify({ type: "match", data: { line_number: i + 1 } })}\n`); matches++;
}
process.exitCode = matches ? 0 : 1;
