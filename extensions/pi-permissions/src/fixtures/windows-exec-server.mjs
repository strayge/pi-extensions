import readline from "node:readline";

const mode = process.env.PI_FAKE_EXECUTOR_MODE;
const processes = new Map();
const reviews = new Map();
const trace = [];
const frames = [];
let sending = false;
let initialized = false;
let reviewId = 0;

function send(value) {
  frames.push(Buffer.from(`${JSON.stringify(value)}\n`)); pump();
}
function pump() {
  if (sending || !frames.length) return;
  sending = true;
  const frame = frames.shift();
  let offset = 0;
  const write = () => {
    const end = mode === "fragment" ? Math.min(frame.length, offset + 3) : frame.length;
    process.stdout.write(frame.subarray(offset, end), () => {
      offset = end;
      if (offset < frame.length) setImmediate(write);
      else { sending = false; pump(); }
    });
  };
  write();
}
function reply(id, result) { send({ id, result }); }
function event(id, method, fields = {}) {
  const child = processes.get(id); send({ method, params: { processId: id, seq: ++child.seq, ...fields } });
}
function finish(id, exitCode = 0) {
  const child = processes.get(id); if (!child) return;
  event(id, "process/exited", { exitCode }); event(id, "process/closed");
  for (const write of child.writes) reply(write.id, { status: "stdinClosed" });
  processes.delete(id);
}
function review(id, complete) {
  const requestId = `policy-${++reviewId}`;
  reviews.set(requestId, complete);
  send({ id: requestId, method: "network/policyRequest", params: { processId: id, request: { host: "test.example", port: 443, protocol: "https_connect" } } });
}
readline.createInterface({ input: process.stdin }).on("line", (line) => {
  const message = JSON.parse(line);
  if (!message.method) {
    trace.push({ policy: message.result?.decision?.type });
    const complete = reviews.get(message.id); reviews.delete(message.id); complete?.(); return;
  }
  const { id, method, params } = message;
  if (method === "initialize") {
    if (mode === "early-eof") { process.exit(0); }
    reply(id, { sessionId: "fake-session", environmentInfo: process.env.PI_FAKE_EXECUTOR_ENVIRONMENT ? JSON.parse(process.env.PI_FAKE_EXECUTOR_ENVIRONMENT) : { platformOs: "windows", capabilities: { windowsMxc: true, networkProxyLaunch: true, networkProxyReviewDomains: true } } });
  } else if (method === "initialized") initialized = true;
  else if (method === "echo") setTimeout(() => reply(id, { params, initialized, argv: process.argv.slice(2), trace }), params?.delay ?? 0);
  else if (method === "error") send({ id, error: { code: -32602, message: "fake launch rejected", data: { denied: true } } });
  else if (method === "malformed") process.stdout.write("not-json\n");
  else if (method === "bad-error") send({ id, error: { code: "invalid", message: "bad" } });
  else if (method === "oversized") process.stdout.write(Buffer.alloc(2 * 1024 * 1024 + 1, 65));
  else if (method === "crash") process.exit(9);
  else if (method === "diagnostic") process.stderr.write("x".repeat(65536), () => setTimeout(() => reply(id, {}), 20));
  else if (method === "process/start") {
    if (params.networkProxy?.policyDecisionTimeoutMs === 0) { send({ id, error: { code: -32602, message: "policy decision timeout must be nonzero" } }); return; }
    processes.set(params.processId, { seq: 0, writes: [], chunks: [], reviews: (params.networkProxy?.policyDecisionTimeoutMs ?? 0) > 0 });
    const started = () => reply(id, mode === "null-sandbox" ? null : { processId: params.processId, sandboxType: mode === "bad-sandbox" ? "none" : "windowsMxc" });
    if (mode === "reverse-start" && processes.get(params.processId).reviews) review(params.processId, started);
    else started();
    if (mode === "paused-policy" && processes.get(params.processId).reviews) {
      process.stdin.pause(); setImmediate(() => review(params.processId, () => {})); setTimeout(() => process.stdin.resume(), 200);
    }
    if (mode === "complete") {
      event(params.processId, "process/output", { stream: "stdout", chunk: Buffer.from('{"id":999,"result":"only workload output"}\n').toString("base64") });
      finish(params.processId, 7);
    }
  } else if (method === "process/write") {
    const child = processes.get(params.processId);
    if (!child) { reply(id, { status: "unknownProcess" }); return; }
    child.chunks.push({ chunk: params.chunk, writeId: params.writeId });
    if (mode === "blocked-write") { child.writes.push(message); if (child.reviews) review(params.processId, () => {}); }
    else reply(id, { status: "accepted" });
  } else if (method === "process/read") {
    const child = processes.get(params.processId);
    reply(id, { chunks: child?.chunks ?? [], nextSeq: 0, exited: false, closed: false, failure: null, sandboxDenied: false });
  } else if (method === "review-again") {
    review(params.processId, () => reply(id, {}));
  } else if (method === "process/terminate") {
    trace.push({ terminate: params.processId }); reply(id, { success: mode !== "refuse-terminate" });
    if (mode !== "refuse-terminate") finish(params.processId);
  }
});
