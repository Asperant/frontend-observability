// Pure parser for OpenObserve's own scheduler log lines
// (`openobserve::service::alerts::scheduler::handlers`), used by
// scripts/lab/alerts-history-shim.mjs — a fallback for reconstructing alert
// evaluation history when usage self-reporting isn't enabled (see that
// file's own header and the "Alert history" row in
// docs/openobserve-v0.91-alert-capabilities.md for why the native History
// drawer normally covers this now). Kept separate from that I/O runner so
// this line-format contract can be unit-tested without a running container.

const SCHEDULER_LINE =
  /^(\S+)\s+INFO openobserve::service::alerts::scheduler::handlers: \[SCHEDULER trace_id ([^\]]+)\] (.+)$/;
const SKIP_LINE = /^alert (\S+) skipped due to delay: (\d+)$/;
const MODULE_KEY = /module_key: (\S+)$/;

export function parseSchedulerLine(line) {
  const lineMatch = SCHEDULER_LINE.exec(line);
  if (!lineMatch) return null;
  const [, timestampRaw, traceId, rest] = lineMatch;

  const timestamp = new Date(timestampRaw);
  if (Number.isNaN(timestamp.getTime())) return null;

  const skipMatch = SKIP_LINE.exec(rest);
  if (skipMatch) {
    return {
      _timestamp: timestamp.getTime() * 1000,
      trace_id: traceId,
      alert_id: skipMatch[1],
      status: "skipped",
      skip_delay_us: Number(skipMatch[2]),
      message: rest,
    };
  }

  const moduleMatch = MODULE_KEY.exec(rest);
  if (!moduleMatch) return null;

  let status = "other";
  if (rest.startsWith("Alert conditions not satisfied")) status = "not_satisfied";
  else if (rest.startsWith("Alert conditions satisfied")) status = "satisfied";
  else if (rest.startsWith("Alert notification sent")) status = "notification_sent";
  else if (rest.toLowerCase().includes("error")) status = "error";

  return {
    _timestamp: timestamp.getTime() * 1000,
    trace_id: traceId,
    alert_id: moduleMatch[1],
    status,
    skip_delay_us: null,
    message: rest,
  };
}
