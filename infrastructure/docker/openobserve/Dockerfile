# Thin, non-modifying wrapper around the official stable OpenObserve OSS
# image. It adds nothing but: a minimal statically-linked shell (the upstream
# image ships a single static binary with no shell/coreutils at all, which is
# required to run entrypoint.sh/healthcheck.sh), a non-root user, and our two
# wrapper scripts. The upstream /openobserve binary itself is never modified
# and is always exec'd as PID 1 with its original, unmodified arguments.
FROM docker.io/library/busybox:1.38.0-musl@sha256:ffcc8d72c1b3749dd2240e27f79b987eb227538835a2675b1d5849b053a39195 AS shell

FROM public.ecr.aws/zinclabs/openobserve:v0.91.2@sha256:ece1116d39c00e6039094c8b3d07333f65ecfa7c881ca0a35476454825572e15

COPY --from=shell /bin/busybox /bin/busybox
RUN ["/bin/busybox", "sh", "-c", "\
  /bin/busybox --install -s /bin && \
  addgroup -g 10001 openobserve && \
  adduser -D -H -u 10001 -G openobserve openobserve && \
  mkdir -p /data && \
  chown -R openobserve:openobserve /data \
"]

COPY --chmod=0755 entrypoint.sh /entrypoint.sh
COPY --chmod=0755 healthcheck.sh /healthcheck.sh

ENV ZO_DATA_DIR=/data
USER openobserve:openobserve

ENTRYPOINT ["/entrypoint.sh"]
HEALTHCHECK --interval=10s --timeout=5s --start-period=30s --retries=6 \
  CMD ["/healthcheck.sh"]
