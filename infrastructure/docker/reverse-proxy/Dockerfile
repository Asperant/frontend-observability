# Build context: infrastructure/docker/reverse-proxy (self-contained, no
# workspace source needed).
FROM nginxinc/nginx-unprivileged:1.30.4-alpine@sha256:dcb6a40a82e08e071f696805a23b45d5bb6582a7508509930d3035b16b441069

COPY --chown=nginx:nginx nginx.conf /etc/nginx/nginx.conf
COPY --chown=nginx:nginx conf.d/app.conf /etc/nginx/conf.d/app.conf
COPY --chown=nginx:nginx conf.d/security.conf /etc/nginx/conf.d/security.conf
COPY --chown=nginx:nginx conf.d/ingestion.conf /etc/nginx/conf.d/ingestion.conf
COPY --chown=nginx:nginx conf.d/ingestion-upstream-secret.conf.template /etc/chicek/templates/ingestion-upstream-secret.conf.template
COPY --chown=nginx:nginx docker-entrypoint.d/40-render-ingestion-secret.sh /docker-entrypoint.d/40-render-ingestion-secret.sh
RUN rm -f /etc/nginx/conf.d/default.conf

EXPOSE 8443
