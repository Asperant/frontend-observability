import { assertExactLabToolchain, log, runDockerCompose } from "./common.mjs";

/**
 * Removes containers and networks but deliberately never passes `-v`, so
 * the `openobserve-data` volume and everything under `.runtime/` (secrets,
 * certs, generated runtime config) survive.
 */
export function labDown() {
  log("lab:down — stopping and removing containers/networks (volume and .runtime/ preserved)...");
  runDockerCompose(["down"]);
  log("lab:down complete.");
}

const isMainModule = process.argv[1] === new URL(import.meta.url).pathname;
if (isMainModule) {
  try {
    assertExactLabToolchain("lab:down");
    labDown();
  } catch (error) {
    process.stderr.write(`lab:down FAILED: ${error.message}\n`);
    process.exit(1);
  }
}
