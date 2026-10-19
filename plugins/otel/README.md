# otel

Appends selected events to `$DATA/spans.jsonl`: turns, model calls, tool calls, `usage.recorded`. Optional `plugins.config.otel.endpoint` receives the same line as JSON.

This is a log the collector can tail. It does not speak OTLP protobuf yet.

Enable `otel` in `plugins.enabled`.
