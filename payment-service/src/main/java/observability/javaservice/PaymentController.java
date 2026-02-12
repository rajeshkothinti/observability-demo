package observability.javaservice;

import io.micrometer.tracing.Span;
import io.micrometer.tracing.Tracer;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.http.HttpStatus;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.*;

import java.time.Instant;
import java.util.*;
import java.util.concurrent.ConcurrentHashMap;

/**
 * Payment Service REST Controller
 * 
 * RESTful best practices:
 * - Resource-based URLs (/api/v1/payments)
 * - Proper HTTP methods (GET, POST)
 * - Standard status codes (200, 201, 400, 404)
 * - Consistent JSON responses
 * - Validation and error handling
 */
@RestController
@RequestMapping("/api/v1/payments")
public class PaymentController {

    private static final Logger log = LoggerFactory.getLogger(PaymentController.class);
    private final Tracer tracer;

    // In-memory storage (would be database in production)
    private final Map<String, Payment> payments = new ConcurrentHashMap<>();

    public PaymentController(Tracer tracer) {
        this.tracer = tracer;
    }

    /**
     * Process a new payment
     */
    @PostMapping(produces = MediaType.APPLICATION_JSON_VALUE, consumes = MediaType.APPLICATION_JSON_VALUE)
    public ResponseEntity<?> processPayment(@RequestBody PaymentRequest request) {
        Span span = tracer.currentSpan();
        if (span != null) {
            span.tag("order.id", request.orderId());
            span.tag("payment.amount", String.valueOf(request.amount()));
        }

        // Validation
        List<String> errors = validatePaymentRequest(request);
        if (!errors.isEmpty()) {
            log.warn("Payment validation failed for order {}: {}", request.orderId(), errors);
            return ResponseEntity.badRequest().body(new ErrorResponse(
                "https://api.example.com/errors/validation-error",
                "Validation Error",
                400,
                "Request validation failed",
                errors,
                getTraceId()
            ));
        }

        // Simulate payment processing
        String paymentId = "pay-" + UUID.randomUUID().toString().substring(0, 8);
        PaymentStatus status = simulatePaymentGateway(request);

        Payment payment = new Payment(
            paymentId,
            request.orderId(),
            request.customerId(),
            request.amount(),
            request.currency() != null ? request.currency() : "USD",
            status,
            status == PaymentStatus.COMPLETED ? "Payment processed successfully" : "Payment declined",
            Instant.now(),
            Instant.now(),
            Map.of(
                "self", "/api/v1/payments/" + paymentId,
                "refund", "/api/v1/payments/" + paymentId + "/refund"
            )
        );

        payments.put(paymentId, payment);
        log.info("Payment {} processed for order {}: {}", paymentId, request.orderId(), status);

        if (span != null) {
            span.tag("payment.id", paymentId);
            span.tag("payment.status", status.name());
        }

        if (status == PaymentStatus.DECLINED) {
            return ResponseEntity.status(HttpStatus.PAYMENT_REQUIRED).body(payment);
        }

        return ResponseEntity.status(HttpStatus.CREATED).body(payment);
    }

    /**
     * List all payments with optional filtering
     */
    @GetMapping(produces = MediaType.APPLICATION_JSON_VALUE)
    public ResponseEntity<PaginatedResponse<Payment>> listPayments(
            @RequestParam(defaultValue = "1") int page,
            @RequestParam(name = "page_size", defaultValue = "10") int pageSize,
            @RequestParam(name = "order_id", required = false) String orderId,
            @RequestParam(required = false) PaymentStatus status) {

        List<Payment> filtered = new ArrayList<>(payments.values());

        // Apply filters
        if (orderId != null) {
            filtered = filtered.stream()
                .filter(p -> p.orderId().equals(orderId))
                .toList();
        }
        if (status != null) {
            filtered = filtered.stream()
                .filter(p -> p.status() == status)
                .toList();
        }

        // Sort by createdAt descending
        filtered = filtered.stream()
            .sorted((a, b) -> b.createdAt().compareTo(a.createdAt()))
            .toList();

        // Paginate
        int total = filtered.size();
        int start = (page - 1) * pageSize;
        int end = Math.min(start + pageSize, total);
        List<Payment> pageData = start < total ? filtered.subList(start, end) : List.of();

        Map<String, String> links = new LinkedHashMap<>();
        links.put("self", String.format("/api/v1/payments?page=%d&page_size=%d", page, pageSize));
        if (page > 1) {
            links.put("prev", String.format("/api/v1/payments?page=%d&page_size=%d", page - 1, pageSize));
        }
        if (end < total) {
            links.put("next", String.format("/api/v1/payments?page=%d&page_size=%d", page + 1, pageSize));
        }

        return ResponseEntity.ok(new PaginatedResponse<>(pageData, total, page, pageSize, links));
    }

    /**
     * Get payment by ID
     */
    @GetMapping(path = "/{paymentId}", produces = MediaType.APPLICATION_JSON_VALUE)
    public ResponseEntity<?> getPayment(@PathVariable String paymentId) {
        Payment payment = payments.get(paymentId);
        if (payment == null) {
            return ResponseEntity.status(HttpStatus.NOT_FOUND).body(new ErrorResponse(
                "https://api.example.com/errors/not-found",
                "Not Found",
                404,
                "Payment " + paymentId + " not found",
                null,
                getTraceId()
            ));
        }
        return ResponseEntity.ok(payment);
    }

    /**
     * Process a refund
     */
    @PostMapping(path = "/{paymentId}/refund", produces = MediaType.APPLICATION_JSON_VALUE)
    public ResponseEntity<?> refundPayment(@PathVariable String paymentId, @RequestBody(required = false) RefundRequest request) {
        Payment payment = payments.get(paymentId);
        if (payment == null) {
            return ResponseEntity.status(HttpStatus.NOT_FOUND).body(new ErrorResponse(
                "https://api.example.com/errors/not-found",
                "Not Found",
                404,
                "Payment " + paymentId + " not found",
                null,
                getTraceId()
            ));
        }

        if (payment.status() != PaymentStatus.COMPLETED) {
            return ResponseEntity.badRequest().body(new ErrorResponse(
                "https://api.example.com/errors/invalid-state",
                "Invalid State",
                400,
                "Cannot refund payment with status: " + payment.status(),
                null,
                getTraceId()
            ));
        }

        double refundAmount = (request != null && request.amount() > 0) ? request.amount() : payment.amount();
        if (refundAmount > payment.amount()) {
            return ResponseEntity.badRequest().body(new ErrorResponse(
                "https://api.example.com/errors/invalid-amount",
                "Invalid Amount",
                400,
                "Refund amount cannot exceed payment amount",
                null,
                getTraceId()
            ));
        }

        // Create refunded payment
        Payment refunded = new Payment(
            payment.id(),
            payment.orderId(),
            payment.customerId(),
            payment.amount(),
            payment.currency(),
            PaymentStatus.REFUNDED,
            "Refunded $" + refundAmount,
            payment.createdAt(),
            Instant.now(),
            payment.links()
        );
        payments.put(paymentId, refunded);

        log.info("Payment {} refunded: ${}", paymentId, refundAmount);
        return ResponseEntity.ok(refunded);
    }

    // --- Helper methods ---

    private List<String> validatePaymentRequest(PaymentRequest request) {
        List<String> errors = new ArrayList<>();
        if (request.orderId() == null || request.orderId().isBlank()) {
            errors.add("order_id is required");
        }
        if (request.customerId() == null || request.customerId().isBlank()) {
            errors.add("customer_id is required");
        }
        if (request.amount() <= 0) {
            errors.add("amount must be greater than 0");
        }
        return errors;
    }

    private PaymentStatus simulatePaymentGateway(PaymentRequest request) {
        // Simulate: decline payments over $10,000 or for specific test card
        if (request.amount() > 10000) {
            return PaymentStatus.DECLINED;
        }
        // Random success/decline for demo (95% success rate)
        return Math.random() > 0.05 ? PaymentStatus.COMPLETED : PaymentStatus.DECLINED;
    }

    private String getTraceId() {
        Span span = tracer.currentSpan();
        if (span != null && span.context() != null) {
            return span.context().traceId();
        }
        return null;
    }

    // --- Records (DTOs) ---

    public record PaymentRequest(
        String orderId,
        String customerId,
        double amount,
        String currency
    ) {}

    public record RefundRequest(double amount) {}

    public enum PaymentStatus {
        PENDING, COMPLETED, DECLINED, REFUNDED
    }

    public record Payment(
        String id,
        String orderId,
        String customerId,
        double amount,
        String currency,
        PaymentStatus status,
        String message,
        Instant createdAt,
        Instant updatedAt,
        Map<String, String> links
    ) {}

    public record ErrorResponse(
        String type,
        String title,
        int status,
        String detail,
        List<String> errors,
        String traceId
    ) {}

    public record PaginatedResponse<T>(
        List<T> data,
        int total,
        int page,
        int pageSize,
        Map<String, String> links
    ) {}
}
