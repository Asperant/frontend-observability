export function fingerprintOptions(options) {
  return JSON.stringify({
    configUrl: options.configUrl,
    service: options.service,
    environment: options.environment,
    version: options.version,
  });
}
