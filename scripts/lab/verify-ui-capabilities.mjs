#!/usr/bin/env node
import { readdirSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = fileURLToPath(new URL("../../", import.meta.url));
const manifest = JSON.parse(
  readFileSync(join(repoRoot, "infrastructure/openobserve/ui-capabilities.json"), "utf8"),
);
const dashboards = readdirSync(
  join(repoRoot, "infrastructure/openobserve/analytics/dashboards"),
).filter((name) => name.endsWith(".dashboard.json"));
const alerts = readdirSync(join(repoRoot, "infrastructure/openobserve/alerts/alerts")).filter(
  (name) => name.endsWith(".alert.json"),
);
const productAlertIds = alerts
  .filter((name) => !name.startsWith("delivery-"))
  .map((name) => name.replace(/\.alert\.json$/, ""))
  .sort();
const expectedProductAlerts = [...manifest.starterAlerts.productIds].sort();
if (JSON.stringify(productAlertIds) !== JSON.stringify(expectedProductAlerts)) {
  throw new Error(`product starter alerts drifted: ${productAlertIds.join(", ")}`);
}
const report = {
  schemaVersion: "1.0.0",
  supported: manifest.supported,
  unsupported: manifest.unsupported,
  dashboardCount: dashboards.length,
  alertCount: alerts.length,
  productAlertCount: productAlertIds.length,
  deliveryAlertCount: alerts.length - productAlertIds.length,
};
mkdirSync(join(repoRoot, "evidence/acceptance"), { recursive: true });
writeFileSync(
  join(repoRoot, "evidence/acceptance/openobserve-ui-capabilities.json"),
  `${JSON.stringify(report, null, 2)}\n`,
);
console.log(JSON.stringify(report, null, 2));
