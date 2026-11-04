import { spawn } from "node:child_process";

const MAX_CHUNK = 32768;
const END = 0xffffffff;
const [executable, encoded] = process.argv.slice(2);
const args = JSON.parse(encoded);
if (!executable || !Array.isArray(args) || args.some((argument) => typeof argument !== "string")) throw new Error("Invalid trusted grep arguments");
const child = spawn(executable, args, { shell: false, windowsHide: true, stdio: ["pipe", "inherit", "inherit"], env: process.env });
let failed;
child.stdin.on("error", (error) => { failed = error; });
const closed = new Promise((resolve, reject) => { child.once("error", reject); child.once("close", (code) => resolve(code ?? 2)); });
void closed.catch(() => {});
child.once("spawn", () => process.stdout.write('{"type":"pi-grep-ready"}\n'));
let buffered = Buffer.alloc(0);
let expected;
let ended = false;
child.once("error", (error) => { process.stdin.destroy(); process.stderr.write(`${String(error)}\n`, () => process.exit(2)); });
child.once("close", (code) => { if (!ended) { process.stdin.destroy(); process.exit(code ?? 2); } });
try {
  for await (const chunk of process.stdin) {
    let offset = 0;
    while (offset < chunk.length) {
      const need = expected === undefined ? 4 : expected;
      const count = Math.min(need - buffered.length, chunk.length - offset);
      buffered = Buffer.concat([buffered, chunk.subarray(offset, offset + count)]); offset += count;
      if (buffered.length !== need) continue;
      if (expected === undefined) {
        expected = buffered.readUInt32BE(); buffered = Buffer.alloc(0);
        if (expected === END) { ended = true; break; }
        if (expected > MAX_CHUNK) throw new Error("Grep input frame exceeds its bound");
        if (expected === 0) expected = undefined;
      } else {
        if (failed) throw failed;
        await new Promise((resolve, reject) => child.stdin.write(buffered, (error) => error ? reject(error) : resolve()));
        buffered = Buffer.alloc(0); expected = undefined;
      }
    }
    if (ended) break;
  }
  if (!ended) throw new Error("Grep input ended without its terminal marker");
  child.stdin.end(); process.stdin.destroy();
  process.exit(await closed);
} catch (error) {
  process.stdin.destroy(); child.stdin.destroy();
  if (error?.code !== "EPIPE" && error?.code !== "ERR_STREAM_DESTROYED") { child.kill(); process.stderr.write(`${String(error)}\n`); process.exitCode = 2; }
  const code = await closed.catch(() => 2);
  process.exit(process.exitCode ?? code);
}
