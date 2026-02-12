# E-Commerce Order Processing System

A distributed microservices demo showcasing **observability** (traces, metrics, logs)

---

## Use Case: Order Processing

When a customer places an order, the system orchestrates across four services:

```
┌─────────────────────────────────────────────────────────────────────────────────┐
│                              ORDER FLOW                                          │
│                                                                                  │
│  Customer                                                                        │
│     │                                                                            │
│     ▼                                                                            │
│  ┌─────────────────┐                                                             │
│  │  Order Service  │  Python (FastAPI) - API Gateway / Orchestrator              │
│  │  :8000          │  POST /api/v1/orders                                        │
│  └────────┬────────┘                                                             │
│           │                                                                      │
│           ├──────────────────┬──────────────────┬──────────────────┐             │
│           ▼                  ▼                  ▼                  ▼             │
│  ┌─────────────────┐ ┌─────────────────┐ ┌─────────────────┐ ┌─────────────────┐ │
│  │ Inventory Svc   │ │ Payment Svc     │ │ Notification Svc│ │   (Future)      │ │
│  │ Go :8080        │ │ Java :8081      │ │ Node :8082      │ │   Shipping      │ │
│  │ Reserve stock   │ │ Charge card     │ │ Send email/SMS  │ │                 │ │
│  └─────────────────┘ └─────────────────┘ └─────────────────┘ └─────────────────┘ │
└─────────────────────────────────────────────────────────────────────────────────┘
```

### How Observability Helps

| Challenge | Solution |
|-----------|----------|
| **"Where is the bottleneck?"** | One trace shows latency per service in Jaeger |
| **"Why did order fail?"** | Trace shows which service failed + stack trace |
| **"Which service is overloaded?"** | Prometheus metrics: request rate, latency, error rate |
| **"What happened before crash?"** | Logs with trace_id correlate to the exact request |

---

## Services & API Documentation

### 1. Order Service (Python/FastAPI) - Port 8000

**Role:** API Gateway that orchestrates order processing.

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/health` | GET | Liveness probe |
| `/ready` | GET | Readiness probe (checks downstream services) |
| `/api/v1/orders` | POST | Create order (reserves inventory → processes payment → sends notification) |
| `/api/v1/orders` | GET | List orders (pagination, filtering) |
| `/api/v1/orders/{id}` | GET | Get order by ID |
| `/api/v1/orders/{id}/cancel` | POST | Cancel an order |
| `/api/docs` | GET | OpenAPI/Swagger documentation |

**Example: Create Order**
```bash
curl -X POST http://localhost:8000/api/v1/orders \
  -H "Content-Type: application/json" \
  -d '{
    "customer": {
      "customer_id": "cust-123",
      "email": "john@example.com",
      "name": "John Doe"
    },
    "items": [
      {"product_id": "prod-001", "quantity": 2, "unit_price": 29.99},
      {"product_id": "prod-002", "quantity": 1, "unit_price": 79.99}
    ]
  }'
```

---

### 2. Inventory Service (Go) - Port 8080

**Role:** Manages products and inventory reservations.

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/health` | GET | Liveness probe |
| `/ready` | GET | Readiness probe |
| `/api/v1/products` | GET | List products (pagination) |
| `/api/v1/products` | POST | Create product |
| `/api/v1/products/{id}` | GET | Get product by ID |
| `/api/v1/products/{id}` | PUT | Update product |
| `/api/v1/products/{id}` | DELETE | Delete product |
| `/api/v1/inventory/reserve` | POST | Reserve inventory for an order |
| `/api/v1/inventory/release` | POST | Release a reservation |

**Example: List Products**
```bash
curl http://localhost:8080/api/v1/products?page=1&page_size=10
```

**Example: Reserve Inventory**
```bash
curl -X POST http://localhost:8080/api/v1/inventory/reserve \
  -H "Content-Type: application/json" \
  -d '{
    "order_id": "ord-123",
    "items": [
      {"product_id": "prod-001", "quantity": 2}
    ]
  }'
```

---

### 3. Payment Service (Java/Spring Boot) - Port 8081

**Role:** Processes payments and refunds.

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/health` | GET | Liveness probe |
| `/ready` | GET | Readiness probe |

# Observability Demo

Minimal demo showing observability (traces, metrics, logs).

# Quick start:

- Start observability backends:

  docker-compose up -d

- Start services (or use  Docker Compose).

Useful URLs:

- Jaeger: http://localhost:16686
- Prometheus: http://localhost:9090
- Grafana: http://localhost:3000
- Elasticsearch: http://localhost:9200

