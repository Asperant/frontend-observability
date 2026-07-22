import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// Regression guards for the pre-Stage-15 audit remediation: README/roadmap
// stage-status drift, and a doc claiming Stage 13 delivery controls that
// don't exist in source. Structured where practical (parses the actual
// status table / numbered roadmap lines) rather than matching arbitrary
// prose, so it survives wording edits that don't change the facts.

const repoRoot = fileURLToPath(new URL("../..", import.meta.url));
const readDoc = (relPath) => readFileSync(join(repoRoot, relPath), "utf8");

function parseReadmeStatusTable(readme) {
  const section = readme.split("## Mevcut Durum")[1]?.split(/\n## /)[0] ?? "";
  const rows = [...section.matchAll(/^\|\s*(.+?)\s*\|\s*(.+?)\s*\|$/gm)];
  const table = {};
  for (const [, stageCell, statusCell] of rows) {
    table[stageCell.trim()] = statusCell.trim();
  }
  return table;
}

function parseRoadmapStages(roadmap) {
  const stages = {};
  for (const match of roadmap.matchAll(/^(\d+)\.\s(.+)$/gm)) {
    stages[match[1]] = match[2];
  }
  return stages;
}

describe("README / roadmap stage-status consistency", () => {
  const readme = readDoc("README.md");
  const roadmap = readDoc("docs/roadmap.md");

  it("no longer shows the stale pre-Stage-11 status line", () => {
    // The exact regression the pre-Stage-15 audit found: README's top
    // status froze at "Stage 10" long after Stage 14 had shipped.
    expect(readme).not.toMatch(/Aşama\s*10\s*Implemented/i);
  });

  it("has a structured status table matching HEAD's actual accepted stages", () => {
    const table = parseReadmeStatusTable(readme);
    const rowFor = (needle) => Object.entries(table).find(([stage]) => stage.includes(needle))?.[1];

    expect(rowFor("0–10") ?? rowFor("0-10")).toMatch(/ACCEPTED/);
    expect(rowFor("11")).toMatch(/SECURITY BLOCKED|CLOSED BY DESIGN/);
    expect(rowFor("12")).toMatch(/ACCEPTED/);
    expect(rowFor("12")).not.toMatch(/BLOCKED/);
    expect(rowFor("13")).toMatch(/SECURITY BLOCKED|CLOSED BY DESIGN/);
    expect(rowFor("14")).toMatch(/ACCEPTED/);
    expect(rowFor("14")).not.toMatch(/BLOCKED/);
  });

  it("still documents Stage 12 and Stage 14 as their own sections, not just the status table", () => {
    // Guards against the sections being silently deleted again while the
    // status table row survives (or vice versa).
    expect(readme).toMatch(/## .*Aşama 12/);
    expect(readme).toMatch(/## .*Aşama 14/);
  });

  it("roadmap marks stage 11 and stage 13 as Security Blocked, and no other stage claims that status", () => {
    const stages = parseRoadmapStages(roadmap);

    expect(stages["11"]).toMatch(/Security Blocked/);
    expect(stages["13"]).toMatch(/Security Blocked/);

    for (const [number, text] of Object.entries(stages)) {
      if (number === "11" || number === "13") continue;
      expect(text).not.toMatch(/Security Blocked/);
    }
  });

  it("README's replay/delivery capability summary matches the blocked stages", () => {
    expect(readme).toMatch(/Session Replay desteklenmiyor/);
    expect(readme).toMatch(/Guaranteed delivery.*desteklenmiyor/);
    expect(readme).toMatch(/RUM Sessions ve Browser Logs destekleniyor/);
  });
});

describe("Stage 13 delivery doc makes no unimplemented-feature claims", () => {
  const behaviorDoc = readDoc("docs/openobserve-sdk-delivery-behavior.md");
  const decisionDoc = readDoc("docs/telemetry-delivery-security-decision.md");

  // The exact false bullets the pre-Stage-15 audit found in
  // docs/openobserve-sdk-delivery-behavior.md's old "Implementation
  // Decision" section -- none of these controls exist in
  // packages/browser-observability/src (verified separately by
  // native-delivery-limitation.test.js). Their presence here is a direct
  // fingerprint of the regression, so this checks their literal absence.
  const REMOVED_FALSE_CLAIMS = [
    "admission sampling before sanitized events are dispatched",
    "memory-only manual dispatch queue limits",
    "offline drop for new manual events",
    "consent revoke/shutdown purge and listener cleanup",
  ];

  it.each(REMOVED_FALSE_CLAIMS)("does not claim: %s", (claim) => {
    expect(behaviorDoc).not.toContain(claim);
  });

  it("states the blocked status and points at the decision doc", () => {
    expect(behaviorDoc).toMatch(/SECURITY BLOCKED/);
    expect(behaviorDoc).toMatch(/CLOSED BY DESIGN/);
    expect(behaviorDoc).toContain("telemetry-delivery-security-decision.md");
  });

  it("explicitly states revoke/shutdown does not purge the native retry queue", () => {
    expect(behaviorDoc.toLowerCase()).toMatch(/does not purge|cannot .*purge|neither .*purges/);
    expect(decisionDoc).toContain("no purge-on-revoke or purge-on-shutdown");
  });

  it("does not claim guaranteed delivery in either document", () => {
    for (const doc of [behaviorDoc, decisionDoc]) {
      expect(doc.toLowerCase()).not.toMatch(/\bguarantees? delivery\b/);
    }
  });
});

describe("README / roadmap stage-status consistency through Stage 20 (closeout)", () => {
  const readme = readDoc("README.md");
  const roadmap = readDoc("docs/roadmap.md");
  const dockerfile = readDoc("infrastructure/docker/openobserve/Dockerfile");

  it("has structured status rows for stages 17-20", () => {
    const table = parseReadmeStatusTable(readme);
    const rowFor = (needle) => Object.entries(table).find(([stage]) => stage.includes(needle))?.[1];

    expect(rowFor("17")).toMatch(/ACCEPTED/);
    expect(rowFor("18")).toMatch(/ACCEPTED/);
    expect(rowFor("19")).toMatch(/ACCEPTED/);
    expect(rowFor("19")).not.toMatch(/MEASURED LIMITATIONS/);
    expect(rowFor("20")).toMatch(/ACCEPTED/);
  });

  it("the exact pinned target OpenObserve image/digest matches the Dockerfile", () => {
    const targetLine = dockerfile
      .split("\n")
      .find((line) => line.includes("public.ecr.aws/zinclabs/openobserve:"));
    const digestMatch = targetLine?.match(/sha256:[0-9a-f]{64}/);
    expect(digestMatch).not.toBeNull();
    const [digest] = digestMatch;
    expect(digest).toBe("sha256:ece1116d39c00e6039094c8b3d07333f65ecfa7c881ca0a35476454825572e15");
    // README must positively state v0.91.2 as the current pinned target
    // (not just avoid mentioning v0.91.0 — that remains valid as
    // historical/source context for Stage 11/15/16's original audits and
    // Stage 20's upgrade fixture, as long as it's clearly dated as such).
    expect(readme).toMatch(/v0\.91\.2/);
    // Every remaining v0.91.0 mention must be explicitly dated to a past
    // stage/audit, not stated as the current pinned version bare.
    for (const match of readme.matchAll(/.{0,40}v0\.91\.0.{0,10}/gi)) {
      expect(match[0]).toMatch(/Aşama \d+|Stage \d+|audit/i);
    }
  });

  it("Stage 19 is described as accepted with a real, completed 60-minute soak — not deferred", () => {
    expect(readme).toMatch(/60 dakikalık soak.*(gerçek koşuldu|geçti)/);
    expect(readme).not.toMatch(/soak.*henüz canlı koşulmadı/);
    expect(roadmap).not.toMatch(/60 dakikalık standart soak.*çalıştırılmadı/);
  });

  it("does not claim a Version Regression starter alert exists", () => {
    for (const doc of [readme, roadmap]) {
      expect(doc).not.toMatch(/Version Regression/);
    }
  });

  it("Stage 17 documents exactly five starter alerts as the conscious final scope", () => {
    expect(readme).toMatch(/[Bb]eş starter alert/);
    const catalog = JSON.parse(
      readDoc("infrastructure/openobserve/alerts/alert-policy-catalog.json"),
    );
    expect(catalog.starterPolicyIds).toHaveLength(5);
    expect(catalog.starterPolicyIds).not.toContain("version-regression");
  });

  it("Session Replay is still described as closed by design everywhere it's mentioned", () => {
    for (const doc of [readme, roadmap]) {
      expect(doc).toMatch(/Session Replay.*(desteklenmiyor|Security Blocked)/i);
    }
  });
});

describe("local relative links in top-level docs resolve to real files", () => {
  const files = ["README.md", "docs/roadmap.md"];
  const linkPattern = /\]\((?!https?:\/\/)([^)#]+)(?:#[^)]*)?\)/g;

  it.each(files)("every local link in %s points at a file that exists", (relPath) => {
    const doc = readDoc(relPath);
    const baseDir = join(repoRoot, relPath, "..");
    const missing = [];
    for (const match of doc.matchAll(linkPattern)) {
      const target = match[1];
      if (target.startsWith("`") || target.includes(" ")) continue;
      const resolved = join(baseDir, target);
      try {
        readFileSync(resolved);
      } catch {
        missing.push(target);
      }
    }
    expect(missing).toEqual([]);
  });
});

describe("Stage 20 evidence files referenced by docs actually exist", () => {
  it("the committed Stage 20 recovery-results evidence file exists and is valid JSON", () => {
    const raw = readDoc("infrastructure/performance/stage20-recovery-results.json");
    const parsed = JSON.parse(raw);
    expect(parsed.stage).toBe(20);
    expect(["ACCEPTED", "BLOCKED"]).toContain(parsed.decision);
  });

  it("Stage 19 acceptance evidence files exist", () => {
    expect(() =>
      readDoc("infrastructure/performance/stage19-acceptance-results.json"),
    ).not.toThrow();
    expect(() => readDoc("docs/stage19-soak-report.md")).not.toThrow();
  });
});

describe("sanitization backstop doc matches the deployed pipeline graph", () => {
  const backstopDoc = readDoc("docs/openobserve-sanitization-backstop.md");
  const provisionScript = readDoc("scripts/lab/provision-sanitization.mjs");

  it("documents every node the provisioning script actually creates, in order", () => {
    const nodeNames = [...provisionScript.matchAll(/createPipelineNode\(\s*"([a-z-]+)"/g)].map(
      (match) => match[1],
    );
    expect(nodeNames.length).toBeGreaterThan(0);
    for (const nodeName of nodeNames) {
      expect(backstopDoc).toContain(nodeName);
    }
  });

  it("does not claim VRL abort is relied on as the fail-closed mechanism", () => {
    expect(backstopDoc).toMatch(/not (be )?treated as a fail-closed/);
  });
});
