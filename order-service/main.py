"""
Python Order Service (FastAPI) - API Gateway / Orchestrator
Coordinates order processing across Inventory (Go), Payment (Java), and Notification (Node) services.

RESTful best practices:
- Resource-based URLs with API versioning (/api/v1/orders)
- Proper HTTP methods (GET, POST, PUT, DELETE)
- Standard status codes (200, 201, 400, 404, 500)
- Consistent error responses (RFC 7807)
- Request validation (Pydantic)
- Pagination for list endpoints
- HATEOAS links

Run: python main.py -> http://localhost:8000
"""
import logging
import os
from datetime import datetime
from typing import Optional

import httpx
from fastapi import FastAPI, HTTPException, Query, Request, status
from fastapi.responses import JSONResponse
from opentelemetry import trace

from models import (
    CreateOrderRequest, ErrorResponse, OrderListResponse,
    OrderResponse, OrderStatus, generate_order_id,
)
from telemetry import init_telemetry
from database import init_db, order_save, order_get, order_list, order_count

# FastAPI app with metadata for OpenAPI docs
app = FastAPI(
    title="Order Service API",
    description="E-Commerce Order Orchestration Service",
    version="1.0.0",
    docs_url="/api/docs",
    redoc_url="/api/redoc",
    openapi_url="/api/openapi.json",
)

tracer, meter = init_telemetry(app)
logger = logging.getLogger(__name__)


@app.on_event("startup")
def startup():
    """Initialize DB table when DATABASE_URL is set (kind-local)."""
    init_db()


# Service URLs
GO_SERVICE_URL = os.getenv("INVENTORY_SERVICE_URL", os.getenv("GO_SERVICE_URL", "http://localhost:8080"))
JAVA_SERVICE_URL = os.getenv("PAYMENT_SERVICE_URL", os.getenv("JAVA_SERVICE_URL", "http://localhost:8081"))
NODE_SERVICE_URL = os.getenv("NOTIFICATION_SERVICE_URL", os.getenv("NODE_SERVICE_URL", "http://localhost:8082"))

# Metrics
request_counter = meter.create_counter("orders_requests_total", description="Total API requests", unit="1")
order_counter = meter.create_counter("orders_created_total", description="Total orders created", unit="1")
order_histogram = meter.create_histogram("order_processing_duration_ms", description="Order processing duration", unit="ms")


# --- Error Handling ---

def get_trace_id() -> Optional[str]:
    """Get current trace ID for error responses."""
    span = trace.get_current_span()
    if span and span.get_span_context().is_valid:
        return span.get_span_context().trace_id.to_bytes(16, "big").hex()
    return None


def create_error_response(status_code: int, title: str, detail: str, request: Request, errors=None) -> ErrorResponse:
    return ErrorResponse(
        type=f"https://api.example.com/errors/{title.lower().replace(' ', '-')}",
        title=title,
        status=status_code,
        detail=detail,
        instance=str(request.url.path),
        errors=errors,
        trace_id=get_trace_id(),
    )


@app.exception_handler(HTTPException)
async def http_exception_handler(request: Request, exc: HTTPException):
    error = create_error_response(exc.status_code, "Request Error", exc.detail, request)
    return JSONResponse(status_code=exc.status_code, content=error.model_dump())


@app.exception_handler(Exception)
async def general_exception_handler(request: Request, exc: Exception):
    logger.exception("Unhandled exception")
    error = create_error_response(500, "Internal Server Error", str(exc), request)
    return JSONResponse(status_code=500, content=error.model_dump())


# --- Health & Readiness ---

@app.get("/health", tags=["Health"])
def health():
    """Liveness probe - is the service running?"""
    return {"status": "ok", "service": "order-service", "version": "1.0.0"}


@app.get("/ready", tags=["Health"])
async def readiness():
    """Readiness probe - can the service handle requests? Checks downstream services."""
    checks = {}
    async with httpx.AsyncClient(timeout=2.0) as client:
        for name, url in [("inventory", GO_SERVICE_URL), ("payment", JAVA_SERVICE_URL), ("notification", NODE_SERVICE_URL)]:
            try:
                r = await client.get(f"{url}/health")
                checks[name] = "up" if r.status_code == 200 else "degraded"
            except Exception:
                checks[name] = "down"
    
    all_up = all(v == "up" for v in checks.values())
    return {"status": "ready" if all_up else "degraded", "checks": checks}


# --- Orders API (v1) ---

@app.post(
    "/api/v1/orders",
    response_model=OrderResponse,
    status_code=status.HTTP_201_CREATED,
    tags=["Orders"],
    summary="Create a new order",
    description="Creates an order, reserves inventory, processes payment, and sends confirmation.",
)
async def create_order(order_request: CreateOrderRequest, request: Request):
    """
    Create a new order with full orchestration:
    1. Validate and save order
    2. Reserve inventory (Go service)
    3. Process payment (Java service)
    4. Send notification (Node service)
    """
    request_counter.add(1, {"endpoint": "create_order", "method": "POST"})
    start_time = datetime.utcnow()
    
    with tracer.start_as_current_span("create_order") as span:
        order_id = generate_order_id()
        span.set_attribute("order.id", order_id)
        span.set_attribute("customer.id", order_request.customer.customer_id)
        
        total_amount = sum(item.quantity * item.unit_price for item in order_request.items)
        now = datetime.utcnow()
        
        order = {
            "id": order_id,
            "customer": order_request.customer.model_dump(),
            "items": [item.model_dump() for item in order_request.items],
            "total_amount": round(total_amount, 2),
            "status": OrderStatus.PENDING,
            "created_at": now,
            "updated_at": now,
            "inventory_reservation_id": None,
            "payment_id": None,
            "notification_id": None,
        }
        order_save(order)
        logger.info(f"Order {order_id} created, total: ${total_amount:.2f}")
        
        # Step 1: Reserve Inventory
        with tracer.start_as_current_span("reserve_inventory") as inv_span:
            try:
                async with httpx.AsyncClient(timeout=10.0) as client:
                    reserve_payload = {
                        "order_id": order_id,
                        "items": [{"product_id": i.product_id, "quantity": i.quantity} for i in order_request.items],
                    }
                    r = await client.post(f"{GO_SERVICE_URL}/api/v1/inventory/reserve", json=reserve_payload)
                    inv_span.set_attribute("http.status_code", r.status_code)
                    
                    if r.status_code == 201:
                        reservation = r.json()
                        order["inventory_reservation_id"] = reservation.get("id")
                        order["status"] = OrderStatus.INVENTORY_RESERVED
                        logger.info(f"Inventory reserved: {reservation.get('id')}")
                    else:
                        inv_span.set_attribute("error", True)
                        order["status"] = OrderStatus.FAILED
                        order_save(order)
                        raise HTTPException(status_code=400, detail=f"Inventory reservation failed: {r.text}")
            except httpx.RequestError as e:
                inv_span.record_exception(e)
                logger.warning(f"Inventory service unavailable: {e}")
                # Continue with mock reservation for demo
                order["inventory_reservation_id"] = f"mock-res-{order_id}"
                order["status"] = OrderStatus.INVENTORY_RESERVED
        
        # Step 2: Process Payment
        with tracer.start_as_current_span("process_payment") as pay_span:
            try:
                async with httpx.AsyncClient(timeout=10.0) as client:
                    payment_payload = {
                        "order_id": order_id,
                        "customer_id": order_request.customer.customer_id,
                        "amount": total_amount,
                        "currency": "USD",
                    }
                    r = await client.post(f"{JAVA_SERVICE_URL}/api/v1/payments", json=payment_payload)
                    pay_span.set_attribute("http.status_code", r.status_code)
                    
                    if r.status_code == 201:
                        payment = r.json()
                        order["payment_id"] = payment.get("id")
                        order["status"] = OrderStatus.PAYMENT_PROCESSED
                        logger.info(f"Payment processed: {payment.get('id')}")
                    else:
                        pay_span.set_attribute("error", True)
                        # Rollback: release inventory
                        order["status"] = OrderStatus.FAILED
                        order_save(order)
                        raise HTTPException(status_code=400, detail=f"Payment failed: {r.text}")
            except httpx.RequestError as e:
                pay_span.record_exception(e)
                logger.warning(f"Payment service unavailable: {e}")
                # Continue with mock payment for demo
                order["payment_id"] = f"mock-pay-{order_id}"
                order["status"] = OrderStatus.PAYMENT_PROCESSED
        
        # Step 3: Send Notification
        with tracer.start_as_current_span("send_notification") as notif_span:
            try:
                async with httpx.AsyncClient(timeout=10.0) as client:
                    notif_payload = {
                        "order_id": order_id,
                        "customer_email": order_request.customer.email,
                        "customer_name": order_request.customer.name,
                        "type": "order_confirmation",
                        "message": f"Your order {order_id} has been confirmed. Total: ${total_amount:.2f}",
                    }
                    r = await client.post(f"{NODE_SERVICE_URL}/api/v1/notifications", json=notif_payload)
                    notif_span.set_attribute("http.status_code", r.status_code)
                    
                    if r.status_code == 201:
                        notification = r.json()
                        order["notification_id"] = notification.get("id")
                        logger.info(f"Notification sent: {notification.get('id')}")
            except httpx.RequestError as e:
                notif_span.record_exception(e)
                logger.warning(f"Notification service unavailable: {e}")
                order["notification_id"] = f"mock-notif-{order_id}"
        
        # Finalize order
        order["status"] = OrderStatus.CONFIRMED
        order["updated_at"] = datetime.utcnow()
        order_save(order)
        
        order_counter.add(1, {"status": "confirmed"})
        duration_ms = (datetime.utcnow() - start_time).total_seconds() * 1000
        order_histogram.record(duration_ms, {"status": "confirmed"})
        
        # Add HATEOAS links
        base_url = str(request.base_url).rstrip("/")
        order["links"] = {
            "self": f"{base_url}/api/v1/orders/{order_id}",
            "cancel": f"{base_url}/api/v1/orders/{order_id}/cancel",
            "customer_orders": f"{base_url}/api/v1/orders?customer_id={order_request.customer.customer_id}",
        }
        
        return OrderResponse(**order)


@app.get(
    "/api/v1/orders",
    response_model=OrderListResponse,
    tags=["Orders"],
    summary="List orders",
    description="Get a paginated list of orders with optional filtering.",
)
async def list_orders(
    request: Request,
    page: int = Query(1, ge=1, description="Page number"),
    page_size: int = Query(10, ge=1, le=100, description="Items per page"),
    customer_id: Optional[str] = Query(None, description="Filter by customer ID"),
    status: Optional[OrderStatus] = Query(None, description="Filter by order status"),
):
    """List orders with pagination and filtering."""
    request_counter.add(1, {"endpoint": "list_orders", "method": "GET"})
    
    total = order_count(customer_id=customer_id, status=status)
    start = (page - 1) * page_size
    page_data = order_list(customer_id=customer_id, status=status, limit=page_size, offset=start)
    
    # Add links to each order
    base_url = str(request.base_url).rstrip("/")
    for order in page_data:
        order["links"] = {"self": f"{base_url}/api/v1/orders/{order['id']}"}
    
    # Pagination links
    links = {"self": f"{base_url}/api/v1/orders?page={page}&page_size={page_size}"}
    if page > 1:
        links["prev"] = f"{base_url}/api/v1/orders?page={page-1}&page_size={page_size}"
    if start + len(page_data) < total:
        links["next"] = f"{base_url}/api/v1/orders?page={page+1}&page_size={page_size}"
    
    return OrderListResponse(
        data=[OrderResponse(**o) for o in page_data],
        total=total,
        page=page,
        page_size=page_size,
        links=links,
    )


@app.get(
    "/api/v1/orders/{order_id}",
    response_model=OrderResponse,
    tags=["Orders"],
    summary="Get order by ID",
    description="Retrieve a specific order by its identifier.",
)
async def get_order(order_id: str, request: Request):
    """Get a specific order by ID."""
    request_counter.add(1, {"endpoint": "get_order", "method": "GET"})
    
    order = order_get(order_id)
    if not order:
        raise HTTPException(status_code=404, detail=f"Order {order_id} not found")
    order = order.copy()
    base_url = str(request.base_url).rstrip("/")
    order["links"] = {
        "self": f"{base_url}/api/v1/orders/{order_id}",
        "cancel": f"{base_url}/api/v1/orders/{order_id}/cancel",
    }
    return OrderResponse(**order)


@app.post(
    "/api/v1/orders/{order_id}/cancel",
    response_model=OrderResponse,
    tags=["Orders"],
    summary="Cancel an order",
    description="Cancel an existing order (if not already shipped).",
)
async def cancel_order(order_id: str, request: Request):
    """Cancel an order."""
    request_counter.add(1, {"endpoint": "cancel_order", "method": "POST"})
    
    order = order_get(order_id)
    if not order:
        raise HTTPException(status_code=404, detail=f"Order {order_id} not found")
    if order["status"] == OrderStatus.CANCELLED:
        raise HTTPException(status_code=400, detail="Order already cancelled")
    
    with tracer.start_as_current_span("cancel_order") as span:
        span.set_attribute("order.id", order_id)
        
        # In production: release inventory, refund payment
        order["status"] = OrderStatus.CANCELLED
        order["updated_at"] = datetime.utcnow()
        order_save(order)
        logger.info(f"Order {order_id} cancelled")
    
    base_url = str(request.base_url).rstrip("/")
    order["links"] = {"self": f"{base_url}/api/v1/orders/{order_id}"}
    return OrderResponse(**order)


# --- Legacy endpoints (backward compatibility) ---

@app.get("/hello", tags=["Legacy"], include_in_schema=False)
async def hello_legacy():
    """Legacy endpoint - redirects to health."""
    return {"message": "Use /api/v1/orders instead", "docs": "/api/docs"}


@app.get("/all", tags=["Legacy"], include_in_schema=False)
async def all_services():
    """Legacy: Call all services for connectivity test."""
    request_counter.add(1, {"endpoint": "/all", "method": "GET"})
    result = {}
    async with httpx.AsyncClient(timeout=5.0) as client:
        for name, url in [("inventory", GO_SERVICE_URL), ("payment", JAVA_SERVICE_URL), ("notification", NODE_SERVICE_URL)]:
            try:
                r = await client.get(f"{url}/health")
                result[name] = r.json() if r.status_code == 200 else {"error": r.text}
            except Exception as e:
                result[name] = {"error": str(e)}
    return {"message": "Service connectivity check", "services": result}


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8000)
