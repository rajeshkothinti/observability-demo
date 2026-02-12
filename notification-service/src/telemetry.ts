/**
 * OpenTelemetry bootstrap - must run before importing express/app.
 * Sends traces to OTEL Collector at OTEL_EXPORTER_OTLP_ENDPOINT (default localhost:4317).
 */
import { NodeSDK } from '@opentelemetry/sdk-node';
import { getNodeAutoInstrumentations } from '@opentelemetry/auto-instrumentations-node';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-grpc';
import { Resource } from '@opentelemetry/resources';
import { SEMRESATTRS_SERVICE_NAME } from '@opentelemetry/semantic-conventions';

const endpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT || 'http://localhost:4317';
// gRPC wants host:port (no scheme)
const grpcEndpoint = endpoint.replace(/^https?:\/\//, '').replace(/\/$/, '') || 'localhost:4317';

const traceExporter = new OTLPTraceExporter({
  url: grpcEndpoint,
});

const sdk = new NodeSDK({
  resource: new Resource({
    [SEMRESATTRS_SERVICE_NAME]: 'node-service',
  }),
  traceExporter,
  instrumentations: [getNodeAutoInstrumentations()],
});

sdk.start();
