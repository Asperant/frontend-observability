export function createCorrelationCapabilities({
  epoch = false,
  nativeContext = false,
  logs = false,
} = {}) {
  return Object.freeze({
    epoch: Boolean(epoch),
    session: Boolean(nativeContext),
    view: Boolean(nativeContext),
    action: Boolean(nativeContext),
    crossStream: Boolean(epoch && logs),
  });
}
