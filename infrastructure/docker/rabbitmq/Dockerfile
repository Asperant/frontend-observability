FROM docker.io/library/rabbitmq:4.1.4-management-alpine@sha256:55c83be05396805ae6e3e5bcbfd7f55f4ddad09f833fec0c0d565ccf58ddf028

COPY rabbitmq.conf /etc/rabbitmq/rabbitmq.conf
COPY definitions.json /etc/rabbitmq/definitions.json
COPY entrypoint.sh /usr/local/bin/frontend-observability-rabbitmq-entrypoint.sh
RUN chmod 0755 /usr/local/bin/frontend-observability-rabbitmq-entrypoint.sh

ENTRYPOINT ["frontend-observability-rabbitmq-entrypoint.sh"]
CMD ["rabbitmq-server"]
