import { describe, expect, it } from "vitest";

import { parseSchedulerLine } from "../../../scripts/lab/alerts/history-shim-parser.js";

const TRACE = "019f84459a3d70d2803e6760475a942a/019f84459a3e7a32a1a958625de7aa96";
const ALERT_ID = "3GoE4qsCHFZsLLZd2bLU0mX82nt";

function line(rest) {
  return `2026-07-21T10:43:01.822392559+00:00 INFO openobserve::service::alerts::scheduler::handlers: [SCHEDULER trace_id ${TRACE}] ${rest}`;
}

describe("parseSchedulerLine", () => {
  it("returns null for a line that isn't a scheduler log line at all", () => {
    expect(
      parseSchedulerLine("2026-07-21T10:43:01 INFO some::other::module: unrelated"),
    ).toBeNull();
  });

  it("returns null when the timestamp segment doesn't parse as a date", () => {
    const malformed = `not-a-timestamp INFO openobserve::service::alerts::scheduler::handlers: [SCHEDULER trace_id ${TRACE}] alert ${ALERT_ID} skipped due to delay: 100`;
    expect(parseSchedulerLine(malformed)).toBeNull();
  });

  it("parses a 'skipped due to delay' line", () => {
    const result = parseSchedulerLine(line(`alert ${ALERT_ID} skipped due to delay: 1822662`));
    expect(result).toMatchObject({
      trace_id: TRACE,
      alert_id: ALERT_ID,
      status: "skipped",
      skip_delay_us: 1822662,
    });
    expect(result._timestamp).toBe(
      new Date("2026-07-21T10:43:01.822392559+00:00").getTime() * 1000,
    );
  });

  it("parses a 'conditions not satisfied' line", () => {
    const result = parseSchedulerLine(
      line(`Alert conditions not satisfied, org: default, module_key: ${ALERT_ID}`),
    );
    expect(result).toMatchObject({
      alert_id: ALERT_ID,
      status: "not_satisfied",
      skip_delay_us: null,
    });
  });

  it("parses a 'conditions satisfied' line", () => {
    const result = parseSchedulerLine(
      line(`Alert conditions satisfied, org: default, module_key: ${ALERT_ID}`),
    );
    expect(result).toMatchObject({ alert_id: ALERT_ID, status: "satisfied" });
  });

  it("parses a 'notification sent' line", () => {
    const result = parseSchedulerLine(
      line(`Alert notification sent, org: default, module_key: ${ALERT_ID}`),
    );
    expect(result).toMatchObject({ alert_id: ALERT_ID, status: "notification_sent" });
  });

  it("classifies an unrecognized message mentioning 'error' as status error", () => {
    const result = parseSchedulerLine(
      line(`Alert notification error: boom, org: default, module_key: ${ALERT_ID}`),
    );
    expect(result).toMatchObject({ alert_id: ALERT_ID, status: "error" });
  });

  it("classifies any other module_key-bearing message as status other", () => {
    const result = parseSchedulerLine(
      line(`Alert something else entirely, org: default, module_key: ${ALERT_ID}`),
    );
    expect(result).toMatchObject({ alert_id: ALERT_ID, status: "other" });
  });

  it("returns null when the message has neither a skip pattern nor a module_key", () => {
    expect(parseSchedulerLine(line("nothing useful here"))).toBeNull();
  });
});
