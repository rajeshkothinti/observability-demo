// Go Inventory Service - Manages products and inventory reservations.
// RESTful API with proper HTTP methods, status codes, and JSON responses.
//
// Endpoints:
//   GET  /health                    - Health check
//   GET  /ready                     - Readiness probe
//   GET  /api/v1/products           - List products (with pagination)
//   GET  /api/v1/products/{id}      - Get product by ID
//   POST /api/v1/products           - Create product
//   PUT  /api/v1/products/{id}      - Update product
//   POST /api/v1/inventory/reserve  - Reserve inventory for an order
//   POST /api/v1/inventory/release  - Release inventory reservation
//
// Run: go run . -> http://localhost:8080
package main

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"os"
	"os/signal"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"

	"github.com/google/uuid"
	"go.opentelemetry.io/contrib/instrumentation/net/http/otelhttp"
	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/exporters/otlp/otlplog/otlploggrpc"
	"go.opentelemetry.io/otel/exporters/otlp/otlpmetric/otlpmetricgrpc"
	"go.opentelemetry.io/otel/exporters/otlp/otlptrace/otlptracegrpc"
	otellog "go.opentelemetry.io/otel/log"
	"go.opentelemetry.io/otel/propagation"
	sdklog "go.opentelemetry.io/otel/sdk/log"
	sdkmetric "go.opentelemetry.io/otel/sdk/metric"
	"go.opentelemetry.io/otel/sdk/resource"
	sdktrace "go.opentelemetry.io/otel/sdk/trace"
	semconv "go.opentelemetry.io/otel/semconv/v1.24.0"
	"go.opentelemetry.io/otel/trace"
)

const serviceName = "inventory-service"

var appLogger otellog.Logger

// --- Models ---

type Product struct {
	ID          string    `json:"id"`
	Name        string    `json:"name"`
	Description string    `json:"description"`
	Price       float64   `json:"price"`
	Stock       int       `json:"stock"`
	CreatedAt   time.Time `json:"created_at"`
	UpdatedAt   time.Time `json:"updated_at"`
	Links       Links     `json:"links,omitempty"`
}

type ReservationItem struct {
	ProductID string `json:"product_id"`
	Quantity  int    `json:"quantity"`
}

type ReserveRequest struct {
	OrderID string            `json:"order_id"`
	Items   []ReservationItem `json:"items"`
}

type Reservation struct {
	ID        string            `json:"id"`
	OrderID   string            `json:"order_id"`
	Items     []ReservationItem `json:"items"`
	Status    string            `json:"status"` // reserved, released, committed
	CreatedAt time.Time         `json:"created_at"`
	ExpiresAt time.Time         `json:"expires_at"`
	Links     Links             `json:"links,omitempty"`
}

type Links map[string]string

type ErrorResponse struct {
	Type     string `json:"type"`
	Title    string `json:"title"`
	Status   int    `json:"status"`
	Detail   string `json:"detail"`
	Instance string `json:"instance,omitempty"`
	TraceID  string `json:"trace_id,omitempty"`
}

type PaginatedResponse struct {
	Data     interface{} `json:"data"`
	Total    int         `json:"total"`
	Page     int         `json:"page"`
	PageSize int         `json:"page_size"`
	Links    Links       `json:"links"`
}

// --- In-memory storage (would be database in production) ---

var (
	products     = make(map[string]*Product)
	reservations = make(map[string]*Reservation)
	mu           sync.RWMutex
)

func init() {
	// Seed sample products
	now := time.Now()
	sampleProducts := []*Product{
		{ID: "prod-001", Name: "Laptop", Description: "15-inch laptop", Price: 999.99, Stock: 50, CreatedAt: now, UpdatedAt: now},
		{ID: "prod-002", Name: "Mouse", Description: "Wireless mouse", Price: 29.99, Stock: 200, CreatedAt: now, UpdatedAt: now},
		{ID: "prod-003", Name: "Keyboard", Description: "Mechanical keyboard", Price: 79.99, Stock: 100, CreatedAt: now, UpdatedAt: now},
		{ID: "prod-004", Name: "Monitor", Description: "27-inch 4K monitor", Price: 399.99, Stock: 30, CreatedAt: now, UpdatedAt: now},
		{ID: "prod-005", Name: "Headphones", Description: "Noise-canceling headphones", Price: 199.99, Stock: 75, CreatedAt: now, UpdatedAt: now},
	}
	for _, p := range sampleProducts {
		products[p.ID] = p
	}
}

// --- Main ---

func main() {
	ctx := context.Background()
	endpoint := os.Getenv("OTEL_EXPORTER_OTLP_ENDPOINT")
	if endpoint == "" {
		endpoint = "localhost:4317"
	}
	endpoint = strings.TrimPrefix(strings.TrimPrefix(endpoint, "http://"), "https://")

	tp, err := initTracer(ctx, endpoint)
	if err != nil {
		log.Fatalf("init tracer: %v", err)
	}
	defer func() { _ = tp.Shutdown(ctx) }()

	mp, err := initMeter(ctx, endpoint)
	if err != nil {
		log.Fatalf("init meter: %v", err)
	}
	defer func() { _ = mp.Shutdown(ctx) }()

	lp, logger, err := initLogger(ctx, endpoint)
	if err != nil {
		log.Fatalf("init logger: %v", err)
	}
	defer func() { _ = lp.Shutdown(ctx) }()
	appLogger = logger

	otel.SetTextMapPropagator(propagation.NewCompositeTextMapPropagator(
		propagation.TraceContext{},
		propagation.Baggage{},
	))

	mux := http.NewServeMux()

	// Health endpoints
	mux.HandleFunc("/health", healthHandler)
	mux.HandleFunc("/ready", readyHandler)

	// Products API
	mux.HandleFunc("/api/v1/products", productsHandler)
	mux.HandleFunc("/api/v1/products/", productByIDHandler)

	// Inventory API
	mux.HandleFunc("/api/v1/inventory/reserve", reserveHandler)
	mux.HandleFunc("/api/v1/inventory/release", releaseHandler)

	// Legacy endpoints (backward compatibility)
	mux.HandleFunc("/hello", legacyHelloHandler)
	mux.HandleFunc("/data", legacyDataHandler)

	handler := otelhttp.NewHandler(mux, serviceName,
		otelhttp.WithMessageEvents(otelhttp.ReadEvents, otelhttp.WriteEvents),
	)

	srv := &http.Server{Addr: ":8080", Handler: handler}
	go func() {
		log.Println("Inventory service listening on :8080")
		if err := srv.ListenAndServe(); err != nil && err != http.ErrServerClosed {
			log.Fatalf("server: %v", err)
		}
	}()

	quit := make(chan os.Signal, 1)
	signal.Notify(quit, syscall.SIGINT, syscall.SIGTERM)
	<-quit
	_ = srv.Shutdown(ctx)
}

// --- HTTP Handlers ---

func healthHandler(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, map[string]string{"status": "ok", "service": serviceName, "version": "1.0.0"})
}

func readyHandler(w http.ResponseWriter, r *http.Request) {
	// Check database connectivity (mock)
	writeJSON(w, http.StatusOK, map[string]interface{}{
		"status": "ready",
		"checks": map[string]string{"database": "up", "cache": "up"},
	})
}

func productsHandler(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	_, span := otel.Tracer(serviceName).Start(ctx, "products_handler")
	defer span.End()

	switch r.Method {
	case http.MethodGet:
		listProducts(w, r, span)
	case http.MethodPost:
		createProduct(w, r, span)
	default:
		writeError(w, r, http.StatusMethodNotAllowed, "Method Not Allowed", "Use GET or POST")
	}
}

func listProducts(w http.ResponseWriter, r *http.Request, span trace.Span) {
	mu.RLock()
	defer mu.RUnlock()

	// Pagination
	page, _ := strconv.Atoi(r.URL.Query().Get("page"))
	if page < 1 {
		page = 1
	}
	pageSize, _ := strconv.Atoi(r.URL.Query().Get("page_size"))
	if pageSize < 1 || pageSize > 100 {
		pageSize = 10
	}

	// Convert to slice and sort
	all := make([]*Product, 0, len(products))
	for _, p := range products {
		p.Links = Links{"self": fmt.Sprintf("/api/v1/products/%s", p.ID)}
		all = append(all, p)
	}

	total := len(all)
	start := (page - 1) * pageSize
	end := start + pageSize
	if start > total {
		start = total
	}
	if end > total {
		end = total
	}
	pageData := all[start:end]

	span.SetAttributes(attribute.Int("products.count", len(pageData)))
	emitLog(r.Context(), appLogger, otellog.SeverityInfo, fmt.Sprintf("Listed %d products", len(pageData)))

	links := Links{"self": fmt.Sprintf("/api/v1/products?page=%d&page_size=%d", page, pageSize)}
	if page > 1 {
		links["prev"] = fmt.Sprintf("/api/v1/products?page=%d&page_size=%d", page-1, pageSize)
	}
	if end < total {
		links["next"] = fmt.Sprintf("/api/v1/products?page=%d&page_size=%d", page+1, pageSize)
	}

	writeJSON(w, http.StatusOK, PaginatedResponse{
		Data:     pageData,
		Total:    total,
		Page:     page,
		PageSize: pageSize,
		Links:    links,
	})
}

func createProduct(w http.ResponseWriter, r *http.Request, span trace.Span) {
	var p Product
	if err := json.NewDecoder(r.Body).Decode(&p); err != nil {
		writeError(w, r, http.StatusBadRequest, "Invalid JSON", err.Error())
		return
	}

	if p.Name == "" {
		writeError(w, r, http.StatusBadRequest, "Validation Error", "name is required")
		return
	}

	mu.Lock()
	defer mu.Unlock()

	p.ID = "prod-" + uuid.New().String()[:8]
	p.CreatedAt = time.Now()
	p.UpdatedAt = time.Now()
	p.Links = Links{"self": fmt.Sprintf("/api/v1/products/%s", p.ID)}
	products[p.ID] = &p

	span.SetAttributes(attribute.String("product.id", p.ID))
	emitLog(r.Context(), appLogger, otellog.SeverityInfo, fmt.Sprintf("Created product %s", p.ID))

	writeJSON(w, http.StatusCreated, p)
}

func productByIDHandler(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	_, span := otel.Tracer(serviceName).Start(ctx, "product_by_id_handler")
	defer span.End()

	// Extract ID from path: /api/v1/products/{id}
	id := strings.TrimPrefix(r.URL.Path, "/api/v1/products/")
	if id == "" {
		writeError(w, r, http.StatusBadRequest, "Missing ID", "Product ID is required")
		return
	}
	span.SetAttributes(attribute.String("product.id", id))

	switch r.Method {
	case http.MethodGet:
		getProduct(w, r, id, span)
	case http.MethodPut:
		updateProduct(w, r, id, span)
	case http.MethodDelete:
		deleteProduct(w, r, id, span)
	default:
		writeError(w, r, http.StatusMethodNotAllowed, "Method Not Allowed", "Use GET, PUT, or DELETE")
	}
}

func getProduct(w http.ResponseWriter, r *http.Request, id string, span trace.Span) {
	mu.RLock()
	defer mu.RUnlock()

	p, ok := products[id]
	if !ok {
		writeError(w, r, http.StatusNotFound, "Not Found", fmt.Sprintf("Product %s not found", id))
		return
	}
	p.Links = Links{"self": fmt.Sprintf("/api/v1/products/%s", p.ID)}
	writeJSON(w, http.StatusOK, p)
}

func updateProduct(w http.ResponseWriter, r *http.Request, id string, span trace.Span) {
	var update Product
	if err := json.NewDecoder(r.Body).Decode(&update); err != nil {
		writeError(w, r, http.StatusBadRequest, "Invalid JSON", err.Error())
		return
	}

	mu.Lock()
	defer mu.Unlock()

	p, ok := products[id]
	if !ok {
		writeError(w, r, http.StatusNotFound, "Not Found", fmt.Sprintf("Product %s not found", id))
		return
	}

	if update.Name != "" {
		p.Name = update.Name
	}
	if update.Description != "" {
		p.Description = update.Description
	}
	if update.Price > 0 {
		p.Price = update.Price
	}
	if update.Stock >= 0 {
		p.Stock = update.Stock
	}
	p.UpdatedAt = time.Now()
	p.Links = Links{"self": fmt.Sprintf("/api/v1/products/%s", p.ID)}

	emitLog(r.Context(), appLogger, otellog.SeverityInfo, fmt.Sprintf("Updated product %s", id))
	writeJSON(w, http.StatusOK, p)
}

func deleteProduct(w http.ResponseWriter, r *http.Request, id string, span trace.Span) {
	mu.Lock()
	defer mu.Unlock()

	if _, ok := products[id]; !ok {
		writeError(w, r, http.StatusNotFound, "Not Found", fmt.Sprintf("Product %s not found", id))
		return
	}
	delete(products, id)
	emitLog(r.Context(), appLogger, otellog.SeverityInfo, fmt.Sprintf("Deleted product %s", id))
	w.WriteHeader(http.StatusNoContent)
}

func reserveHandler(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeError(w, r, http.StatusMethodNotAllowed, "Method Not Allowed", "Use POST")
		return
	}

	ctx := r.Context()
	_, span := otel.Tracer(serviceName).Start(ctx, "reserve_inventory")
	defer span.End()

	var req ReserveRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, r, http.StatusBadRequest, "Invalid JSON", err.Error())
		return
	}

	if req.OrderID == "" || len(req.Items) == 0 {
		writeError(w, r, http.StatusBadRequest, "Validation Error", "order_id and items are required")
		return
	}

	mu.Lock()
	defer mu.Unlock()

	// Check stock availability
	for _, item := range req.Items {
		p, ok := products[item.ProductID]
		if !ok {
			writeError(w, r, http.StatusBadRequest, "Invalid Product", fmt.Sprintf("Product %s not found", item.ProductID))
			return
		}
		if p.Stock < item.Quantity {
			writeError(w, r, http.StatusConflict, "Insufficient Stock", fmt.Sprintf("Product %s: requested %d, available %d", item.ProductID, item.Quantity, p.Stock))
			return
		}
	}

	// Reserve stock
	for _, item := range req.Items {
		products[item.ProductID].Stock -= item.Quantity
	}

	reservation := &Reservation{
		ID:        "res-" + uuid.New().String()[:8],
		OrderID:   req.OrderID,
		Items:     req.Items,
		Status:    "reserved",
		CreatedAt: time.Now(),
		ExpiresAt: time.Now().Add(15 * time.Minute),
		Links:     Links{"self": fmt.Sprintf("/api/v1/inventory/reservations/%s", "res-"+uuid.New().String()[:8])},
	}
	reservations[reservation.ID] = reservation

	span.SetAttributes(
		attribute.String("reservation.id", reservation.ID),
		attribute.String("order.id", req.OrderID),
	)
	emitLog(ctx, appLogger, otellog.SeverityInfo, fmt.Sprintf("Reserved inventory for order %s", req.OrderID))

	writeJSON(w, http.StatusCreated, reservation)
}

func releaseHandler(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeError(w, r, http.StatusMethodNotAllowed, "Method Not Allowed", "Use POST")
		return
	}

	ctx := r.Context()
	_, span := otel.Tracer(serviceName).Start(ctx, "release_inventory")
	defer span.End()

	var req struct {
		ReservationID string `json:"reservation_id"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, r, http.StatusBadRequest, "Invalid JSON", err.Error())
		return
	}

	mu.Lock()
	defer mu.Unlock()

	res, ok := reservations[req.ReservationID]
	if !ok {
		writeError(w, r, http.StatusNotFound, "Not Found", fmt.Sprintf("Reservation %s not found", req.ReservationID))
		return
	}

	// Release stock
	for _, item := range res.Items {
		if p, ok := products[item.ProductID]; ok {
			p.Stock += item.Quantity
		}
	}
	res.Status = "released"

	span.SetAttributes(attribute.String("reservation.id", req.ReservationID))
	emitLog(ctx, appLogger, otellog.SeverityInfo, fmt.Sprintf("Released reservation %s", req.ReservationID))

	writeJSON(w, http.StatusOK, res)
}

// Legacy handlers for backward compatibility
func legacyHelloHandler(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, map[string]string{"message": "Hello from Go (Inventory Service)", "docs": "/api/v1/products"})
}

func legacyDataHandler(w http.ResponseWriter, r *http.Request) {
	mu.RLock()
	defer mu.RUnlock()
	writeJSON(w, http.StatusOK, map[string]interface{}{"message": "Use /api/v1/products", "product_count": len(products)})
}

// --- Helpers ---

func writeJSON(w http.ResponseWriter, status int, data interface{}) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(data)
}

func writeError(w http.ResponseWriter, r *http.Request, status int, title, detail string) {
	traceID := ""
	if span := trace.SpanFromContext(r.Context()); span.SpanContext().IsValid() {
		traceID = span.SpanContext().TraceID().String()
	}
	w.Header().Set("Content-Type", "application/problem+json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(ErrorResponse{
		Type:     fmt.Sprintf("https://api.example.com/errors/%s", strings.ToLower(strings.ReplaceAll(title, " ", "-"))),
		Title:    title,
		Status:   status,
		Detail:   detail,
		Instance: r.URL.Path,
		TraceID:  traceID,
	})
}

// --- OpenTelemetry Init ---

func initTracer(ctx context.Context, endpoint string) (*sdktrace.TracerProvider, error) {
	exp, err := otlptracegrpc.New(ctx,
		otlptracegrpc.WithEndpoint(endpoint),
		otlptracegrpc.WithInsecure(),
	)
	if err != nil {
		return nil, err
	}
	res, _ := resource.Merge(
		resource.Default(),
		resource.NewWithAttributes(semconv.SchemaURL, semconv.ServiceName(serviceName)),
	)
	tp := sdktrace.NewTracerProvider(
		sdktrace.WithBatcher(exp),
		sdktrace.WithResource(res),
	)
	otel.SetTracerProvider(tp)
	return tp, nil
}

func initMeter(ctx context.Context, endpoint string) (*sdkmetric.MeterProvider, error) {
	exp, err := otlpmetricgrpc.New(ctx,
		otlpmetricgrpc.WithEndpoint(endpoint),
		otlpmetricgrpc.WithInsecure(),
	)
	if err != nil {
		return nil, err
	}
	res, _ := resource.Merge(
		resource.Default(),
		resource.NewWithAttributes(semconv.SchemaURL, semconv.ServiceName(serviceName)),
	)
	mp := sdkmetric.NewMeterProvider(
		sdkmetric.WithResource(res),
		sdkmetric.WithReader(sdkmetric.NewPeriodicReader(exp)),
	)
	otel.SetMeterProvider(mp)
	return mp, nil
}

func initLogger(ctx context.Context, endpoint string) (*sdklog.LoggerProvider, otellog.Logger, error) {
	exp, err := otlploggrpc.New(ctx,
		otlploggrpc.WithEndpoint(endpoint),
		otlploggrpc.WithInsecure(),
	)
	if err != nil {
		return nil, nil, err
	}
	res, _ := resource.Merge(
		resource.Default(),
		resource.NewWithAttributes(semconv.SchemaURL, semconv.ServiceName(serviceName)),
	)
	processor := sdklog.NewBatchProcessor(exp)
	lp := sdklog.NewLoggerProvider(
		sdklog.WithProcessor(processor),
		sdklog.WithResource(res),
	)
	logger := lp.Logger(serviceName, otellog.WithInstrumentationVersion("1.0.0"))
	return lp, logger, nil
}

func emitLog(ctx context.Context, logger otellog.Logger, severity otellog.Severity, msg string, attrs ...otellog.KeyValue) {
	var rec otellog.Record
	rec.SetTimestamp(time.Now())
	rec.SetBody(otellog.StringValue(msg))
	rec.SetSeverity(severity)
	rec.SetSeverityText(severity.String())
	for _, kv := range attrs {
		rec.AddAttributes(kv)
	}
	if span := trace.SpanFromContext(ctx); span.SpanContext().IsValid() {
		rec.AddAttributes(
			otellog.String("trace_id", span.SpanContext().TraceID().String()),
			otellog.String("span_id", span.SpanContext().SpanID().String()),
		)
	}
	logger.Emit(ctx, rec)
}
