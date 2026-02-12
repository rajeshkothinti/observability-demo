"""
OpenTelemetry setup for Python service: traces, metrics, logs.
Export to OTEL Collector at OTEL_EXPORTER_OTLP_ENDPOINT (default localhost:4317).
"""
import logging
from opentelemetry import trace, metrics
from opentelemetry.sdk.trace import TracerProvider
from opentelemetry.sdk.trace.export import BatchSpanProcessor
from opentelemetry.sdk.metrics import MeterProvider
from opentelemetry.sdk.metrics.export import PeriodicExportingMetricReader
from opentelemetry.sdk.resources import Resource, SERVICE_NAME
from opentelemetry.exporter.otlp.proto.grpc.trace_exporter import OTLPSpanExporter
from opentelemetry.exporter.otlp.proto.grpc.metric_exporter import OTLPMetricExporter
from opentelemetry.instrumentation.fastapi import FastAPIInstrumentor
from opentelemetry.instrumentation.httpx import HTTPXClientInstrumentor
from opentelemetry.instrumentation.logging import LoggingInstrumentor

import os

OTEL_ENDPOINT = os.getenv("OTEL_EXPORTER_OTLP_ENDPOINT", "http://localhost:4317").replace("http://", "").replace("https://", "")


def _resource():
    return Resource(attributes={SERVICE_NAME: "python-service"})


def setup_tracing(app=None):
    provider = TracerProvider(resource=_resource())
    provider.add_span_processor(BatchSpanProcessor(OTLPSpanExporter(endpoint=OTEL_ENDPOINT, insecure=True)))
    trace.set_tracer_provider(provider)
    if app:
        FastAPIInstrumentor.instrument_app(app)
    HTTPXClientInstrumentor().instrument()
    return trace.get_tracer("python-service", "1.0.0")


def setup_metrics():
    reader = PeriodicExportingMetricReader(
        OTLPMetricExporter(endpoint=OTEL_ENDPOINT, insecure=True),
        export_interval_millis=10_000,
    )
    provider = MeterProvider(resource=_resource(), metric_readers=[reader])
    metrics.set_meter_provider(provider)
    return metrics.get_meter("python-service", "1.0.0")


def setup_logging():
    """Add trace context to log records; optional OTLP log export if SDK logs available."""
    LoggingInstrumentor().instrument(set_logging_format=True)
    try:
        from opentelemetry.sdk._logs import LoggerProvider, LoggingHandler
        from opentelemetry.sdk._logs.export import BatchLogRecordProcessor
        from opentelemetry.exporter.otlp.proto.grpc.log_exporter import OTLPLogExporter
        logger_provider = LoggerProvider(resource=_resource())
        logger_provider.add_log_record_processor(
            BatchLogRecordProcessor(OTLPLogExporter(endpoint=OTEL_ENDPOINT, insecure=True))
        )
        handler = LoggingHandler(level=logging.INFO, logger_provider=logger_provider)
        logging.getLogger().addHandler(handler)
    except ImportError:
        pass  # logs still get trace context via LoggingInstrumentor
    logging.getLogger().setLevel(logging.INFO)


def init_telemetry(app=None):
    setup_logging()
    tracer = setup_tracing(app)
    meter = setup_metrics()
    return tracer, meter
