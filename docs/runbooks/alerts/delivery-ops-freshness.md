# Durable Delivery Ops Freshness

Check `delivery-worker` health/logs and RabbitMQ queue state. This alert is based only on aggregate
`_chicek_delivery_ops` events and does not inspect queued RUM/log payloads.
