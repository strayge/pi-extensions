/**
 * Closes a startup race in the sandbox runtime's Linux network bridge.
 *
 * The runtime backgrounds the in-namespace socat listeners that HTTP_PROXY and
 * ALL_PROXY point at, then runs the command immediately with no readiness
 * wait. Binding those ports takes a few tens of milliseconds, and a client that
 * reaches connect() first is refused outright rather than queued:
 *
 *   fatal: unable to access 'https://github.com/...': Failed to connect to
 *   localhost port 3128 after 0 ms: Couldn't connect to server
 *
 * git and curl both start fast enough to lose that race consistently, which
 * makes every network command in a sandboxed mode look like a network outage.
 *
 * Prefixing the command with a bounded connect-poll closes the window: it runs
 * inside the sandbox, after the listeners are spawned, and reads the ports out
 * of the proxy env the runtime itself sets. A sandbox with no bridge leaves
 * that env unset, and on macOS the env points straight at an already-listening
 * host proxy — so neither case pays for the wait.
 */

/**
 * Polling budget. `SECONDS` has 1-second granularity, so the real bound is
 * 1–2s: enough to absorb a loaded host, short enough that a proxy which is
 * never coming up still fails fast.
 */
const WAIT_SECONDS = 2;

/**
 * Poll every port the proxy env advertises until it accepts. Uses bash's
 * /dev/tcp so it needs no binary that might be missing inside the sandbox, and
 * treats `sleep` as optional — without it the loop spins, which is slower but
 * no less correct. `__pm_`-prefixed names keep the loop out of the command's
 * namespace.
 *
 * Nothing here may contain `!`. The runtime quotes the command for three
 * nested shells and escapes `!` for history expansion, which a non-interactive
 * shell never performs — so `*[!0-9]*` arrives as `*[\!0-9]*`, a bracket
 * expression that is no longer negated and quietly matches the opposite set.
 * Hence the arithmetic `-gt` test for "is this a port" rather than a pattern,
 * and `|| break` rather than `if ! …`.
 */
const WAIT_SNIPPET = [
  'for __pm_url in "$HTTP_PROXY" "$ALL_PROXY"; do',
  // biome-ignore lint/suspicious/noTemplateCurlyInString: shell parameter expansion, not a JS template
  "  __pm_port=${__pm_url##*:}; __pm_port=${__pm_port%%/*}",
  '  [ "$__pm_port" -gt 0 ] 2>/dev/null || continue',
  `  __pm_deadline=$((SECONDS+${WAIT_SECONDS}))`,
  "  while :; do",
  '    (exec 3<>/dev/tcp/127.0.0.1/"$__pm_port") 2>/dev/null && break',
  '    [ "$SECONDS" -lt "$__pm_deadline" ] || break',
  "    sleep 0.01 2>/dev/null || :",
  "  done",
  "done",
  "unset __pm_url __pm_port __pm_deadline",
].join("\n");

/** The command stays last so its exit status is the script's; it is not otherwise rewritten. */
export function withProxyReady(command: string): string {
  return `${WAIT_SNIPPET}\n${command}`;
}
