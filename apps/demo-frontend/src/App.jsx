import { useEffect, useState } from "react";
import { getObservabilityStatus, recordError } from "@chicek/browser-observability";

import * as scenarios from "./scenarios.js";

const SCENARIO_GROUPS = [
  {
    title: "Lifecycle",
    items: [
      { id: "initialize", label: "Initialize", run: scenarios.initializeScenario },
      {
        id: "duplicate-init",
        label: "Duplicate initialization",
        run: scenarios.duplicateInitializeScenario,
      },
      { id: "config-failure", label: "Config failure", run: scenarios.configFailureScenario },
      { id: "shutdown", label: "Shutdown", run: scenarios.shutdownScenario },
    ],
  },
  {
    title: "Consent",
    items: [
      { id: "consent-grant", label: "Grant consent", run: scenarios.grantConsentScenario },
      { id: "consent-revoke", label: "Revoke consent", run: scenarios.revokeConsentScenario },
    ],
  },
  {
    title: "Errors",
    items: [
      { id: "runtime-error", label: "Runtime error", run: scenarios.runtimeErrorScenario },
      {
        id: "unhandled-rejection",
        label: "Unhandled promise rejection",
        run: scenarios.unhandledRejectionScenario,
      },
      { id: "resource-error", label: "Resource error", run: scenarios.resourceErrorScenario },
      { id: "long-task", label: "Long task", run: scenarios.longTaskScenario },
    ],
  },
  {
    title: "Network",
    items: [
      {
        id: "success-request",
        label: "Successful request",
        run: scenarios.successfulRequestScenario,
      },
      { id: "client-error", label: "4xx response", run: scenarios.clientErrorScenario },
      { id: "server-error", label: "5xx response", run: scenarios.serverErrorScenario },
      { id: "timeout", label: "Timeout", run: scenarios.timeoutScenario },
      { id: "abort", label: "Abort", run: scenarios.abortScenario },
    ],
  },
  {
    title: "Telemetry edge cases",
    items: [
      {
        id: "telemetry-failure",
        label: "Telemetry failure (no-op)",
        run: scenarios.telemetryFailureScenario,
      },
    ],
  },
];

function StatusPanel({ status }) {
  return (
    <dl data-testid="status-panel">
      <dt>status</dt>
      <dd>{status.status}</dd>
      <dt>consent</dt>
      <dd>{status.consent}</dd>
      <dt>applicationId</dt>
      <dd>{status.applicationId ?? "—"}</dd>
      <dt>privacyProfile</dt>
      <dd>{status.privacyProfile ?? "—"}</dd>
      <dt>diagnosticsCount</dt>
      <dd>{status.diagnosticsCount}</dd>
    </dl>
  );
}

export default function App() {
  const [status, setStatus] = useState(() => getObservabilityStatus());
  const [log, setLog] = useState([]);

  useEffect(() => {
    function handleWindowError(event) {
      recordError(event.error ?? new Error(event.message), { scenario: "runtime-error" });
      setStatus(getObservabilityStatus());
    }
    function handleUnhandledRejection(event) {
      recordError(event.reason ?? new Error("Unhandled rejection"), {
        scenario: "unhandled-rejection",
      });
      setStatus(getObservabilityStatus());
    }
    window.addEventListener("error", handleWindowError);
    window.addEventListener("unhandledrejection", handleUnhandledRejection);
    return () => {
      window.removeEventListener("error", handleWindowError);
      window.removeEventListener("unhandledrejection", handleUnhandledRejection);
    };
  }, []);

  async function run(item) {
    const result = await item.run();
    setStatus(getObservabilityStatus());
    setLog((previous) =>
      [{ id: `${item.id}-${Date.now()}`, label: item.label, result }, ...previous].slice(0, 20),
    );
  }

  return (
    <main>
      <header>
        <h1>Chicek Frontend Observability — Demo Test Fixture</h1>
        <p role="note">
          Bu sayfa bir üretim uygulaması değildir. Yalnızca{" "}
          <code>@chicek/browser-observability</code> paketinin senaryo testleri için kullanılan bir
          test fixture&apos;ıdır. Gerçek şirket verisi veya gerçek OpenObserve bağlantısı içermez.
        </p>
      </header>

      <section aria-label="status">
        <h2>Status</h2>
        <StatusPanel status={status} />
      </section>

      {SCENARIO_GROUPS.map((group) => (
        <section key={group.title} aria-label={group.title}>
          <h2>{group.title}</h2>
          <div>
            {group.items.map((item) => (
              <button
                key={item.id}
                type="button"
                data-testid={`scenario-${item.id}`}
                onClick={() => run(item)}
              >
                {item.label}
              </button>
            ))}
          </div>
        </section>
      ))}

      <section aria-label="session-replay-fields">
        <h2>Session replay — mask/block field examples</h2>
        <p>
          Session replay bu aşamada devre dışıdır. Aşağıdaki alanlar yalnızca gelecekteki
          maskeleme/engelleme kurallarının hangi seçicilere uygulanacağını göstermek için örnektir;
          şu an herhangi bir replay mantığı çalışmaz.
        </p>
        <form>
          <label htmlFor="demo-full-name">
            Full name (mask)
            <input
              id="demo-full-name"
              type="text"
              name="fullName"
              data-chicek-privacy="mask"
              defaultValue="Jane Example"
            />
          </label>
          <label htmlFor="demo-password">
            Password (block)
            <input
              id="demo-password"
              type="password"
              name="password"
              data-chicek-privacy="block"
              defaultValue="not-a-real-secret"
            />
          </label>
        </form>
      </section>

      <section aria-label="activity-log">
        <h2>Activity log</h2>
        <ul data-testid="activity-log">
          {log.map((entry) => (
            <li key={entry.id}>
              {entry.label}: {JSON.stringify(entry.result)}
            </li>
          ))}
        </ul>
      </section>
    </main>
  );
}
