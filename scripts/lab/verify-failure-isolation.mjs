import { spawnSync } from "node:child_process";

import { COMPOSE_PROJECT_NAME, log, runDockerCompose, SERVICES } from "./common.mjs";
import { requestHttps } from "./verify-http.mjs";
import { waitForHealthy } from "./wait.mjs";

function restartCount(service) {
  const name = `${COMPOSE_PROJECT_NAME}-${service}-1`;
  const result = spawnSync("docker", ["inspect", name, "--format", "{{.RestartCount}}"], {
    encoding: "utf8",
  });
  return Number.parseInt(result.stdout.trim(), 10);
}

/**
 * Proves the demo app degrades gracefully rather than going down when a
 * dependency disappears, and that the lab returns to fully healthy
 * afterwards, without the restart policy looping unboundedly in the
 * process.
 */
export async function checkFailureIsolation() {
  const findings = [];

  log("  failure isolation: stopping openobserve...");
  runDockerCompose(["stop", "openobserve"]);
  const rootWithoutOpenobserve = await requestHttps("/");
  if (rootWithoutOpenobserve.statusCode !== 200) {
    findings.push(
      `With openobserve stopped, GET / returned ${rootWithoutOpenobserve.statusCode}, expected 200.`,
    );
  }
  runDockerCompose(["start", "openobserve"]);
  const openobserveBackHealthy = await waitForHealthy({
    services: ["openobserve"],
    timeoutMs: 120_000,
  });
  if (!openobserveBackHealthy.healthy)
    findings.push("openobserve did not return to healthy after restart.");

  log("  failure isolation: stopping mock-api...");
  runDockerCompose(["stop", "mock-api"]);
  const rootWithoutMockApi = await requestHttps("/");
  if (rootWithoutMockApi.statusCode !== 200) {
    findings.push(
      `With mock-api stopped, GET / returned ${rootWithoutMockApi.statusCode}, expected 200 (demo shell).`,
    );
  }
  const mockProxyWhileDown = await requestHttps("/mock/status/200");
  if (![502, 503, 504].includes(mockProxyWhileDown.statusCode)) {
    findings.push(
      `With mock-api stopped, GET /mock/status/200 returned ${mockProxyWhileDown.statusCode}, ` +
        "expected a graceful 502/503/504 (not a hang or crash).",
    );
  }
  runDockerCompose(["start", "mock-api"]);
  const mockApiBackHealthy = await waitForHealthy({ services: ["mock-api"], timeoutMs: 60_000 });
  if (!mockApiBackHealthy.healthy)
    findings.push("mock-api did not return to healthy after restart.");

  const finalHealth = await waitForHealthy({ timeoutMs: 90_000 });
  if (!finalHealth.healthy) {
    findings.push(
      `Not all services are healthy at the end of the failure-isolation test: ${finalHealth.stillWaiting?.join(", ")}`,
    );
  }

  for (const service of SERVICES) {
    const count = restartCount(service);
    if (count > 5) {
      findings.push(`${service}: RestartCount is ${count}, suggesting an unbounded restart loop.`);
    }
  }

  return { pass: findings.length === 0, findings };
}
