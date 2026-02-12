package observability.javaservice;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.http.MediaType;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RestController;

import java.util.Map;

/**
 * Health and legacy endpoints for Payment Service
 */
@RestController
public class HelloController {

    private static final Logger log = LoggerFactory.getLogger(HelloController.class);

    @GetMapping(path = "/health", produces = MediaType.APPLICATION_JSON_VALUE)
    public Map<String, String> health() {
        return Map.of("status", "ok", "service", "payment-service", "version", "1.0.0");
    }

    @GetMapping(path = "/ready", produces = MediaType.APPLICATION_JSON_VALUE)
    public Map<String, Object> ready() {
        // In production: check database, payment gateway connectivity
        return Map.of(
            "status", "ready",
            "checks", Map.of(
                "database", "up",
                "payment_gateway", "up"
            )
        );
    }

    @GetMapping(path = "/hello", produces = MediaType.APPLICATION_JSON_VALUE)
    public Map<String, String> hello() {
        log.info("Hello requested from Payment service");
        return Map.of(
            "message", "Hello from Java (Payment Service)",
            "docs", "/api/v1/payments"
        );
    }
}
