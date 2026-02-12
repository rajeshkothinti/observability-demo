/**
 * Node/TypeScript Notification Service - Sends email/SMS confirmations
 * 
 * RESTful API with proper endpoints:
 *   GET  /health                     - Health check
 *   GET  /ready                      - Readiness probe
 *   POST /api/v1/notifications       - Send a notification
 *   GET  /api/v1/notifications       - List notifications (with pagination)
 *   GET  /api/v1/notifications/:id   - Get notification by ID
 *
 * Run: npm run dev -> http://localhost:8082
 */
import './telemetry';

import express, { Request, Response, NextFunction } from 'express';
import { trace, SpanStatusCode } from '@opentelemetry/api';
import { v4 as uuidv4 } from 'uuid';

const app = express();
const PORT = process.env.PORT || 8082;

app.use(express.json());

// --- Types ---

interface Notification {
  id: string;
  order_id: string;
  customer_email: string;
  customer_name: string;
  type: NotificationType;
  channel: NotificationChannel;
  message: string;
  status: NotificationStatus;
  created_at: string;
  sent_at: string | null;
  links: Record<string, string>;
}

type NotificationType = 'order_confirmation' | 'order_shipped' | 'order_delivered' | 'payment_received' | 'refund_processed';
type NotificationChannel = 'email' | 'sms' | 'push';
type NotificationStatus = 'pending' | 'sent' | 'failed' | 'delivered';

interface CreateNotificationRequest {
  order_id: string;
  customer_email: string;
  customer_name: string;
  type: NotificationType;
  message: string;
  channel?: NotificationChannel;
}

interface ErrorResponse {
  type: string;
  title: string;
  status: number;
  detail: string;
  instance?: string;
  errors?: string[];
  trace_id?: string;
}

interface PaginatedResponse<T> {
  data: T[];
  total: number;
  page: number;
  page_size: number;
  links: Record<string, string>;
}

// --- In-memory storage (would be database + message queue in production) ---

const notifications: Map<string, Notification> = new Map();

// --- Helper functions ---

function getTraceId(): string | undefined {
  const span = trace.getActiveSpan();
  if (span) {
    return span.spanContext().traceId;
  }
  return undefined;
}

function sendError(res: Response, status: number, title: string, detail: string, errors?: string[]): void {
  const errorResponse: ErrorResponse = {
    type: `https://api.example.com/errors/${title.toLowerCase().replace(/\s+/g, '-')}`,
    title,
    status,
    detail,
    errors,
    trace_id: getTraceId(),
  };
  res.status(status).json(errorResponse);
}

function simulateSendNotification(notification: Notification): NotificationStatus {
  // Simulate sending - 98% success rate
  if (Math.random() > 0.02) {
    console.info(`Notification ${notification.id} sent to ${notification.customer_email}`);
    return 'sent';
  }
  console.warn(`Notification ${notification.id} failed to send`);
  return 'failed';
}

// --- Middleware ---

// Request logging middleware
app.use((req: Request, res: Response, next: NextFunction) => {
  const tracer = trace.getTracer('notification-service');
  const span = tracer.startSpan(`${req.method} ${req.path}`);
  
  res.on('finish', () => {
    span.setAttribute('http.status_code', res.statusCode);
    span.setStatus({ code: res.statusCode < 400 ? SpanStatusCode.OK : SpanStatusCode.ERROR });
    span.end();
  });
  
  next();
});

// --- Health endpoints ---

app.get('/health', (_req: Request, res: Response) => {
  res.json({ status: 'ok', service: 'notification-service', version: '1.0.0' });
});

app.get('/ready', (_req: Request, res: Response) => {
  // In production: check email provider, SMS gateway, etc.
  res.json({
    status: 'ready',
    checks: {
      email_provider: 'up',
      sms_gateway: 'up',
      push_service: 'up',
    },
  });
});

// --- Notifications API ---

/**
 * POST /api/v1/notifications - Send a notification
 */
app.post('/api/v1/notifications', (req: Request, res: Response) => {
  const tracer = trace.getTracer('notification-service');
  const span = tracer.startSpan('create_notification');

  try {
    const body: CreateNotificationRequest = req.body;

    // Validation
    const errors: string[] = [];
    if (!body.order_id) errors.push('order_id is required');
    if (!body.customer_email) errors.push('customer_email is required');
    if (!body.customer_name) errors.push('customer_name is required');
    if (!body.type) errors.push('type is required');
    if (!body.message) errors.push('message is required');

    if (errors.length > 0) {
      sendError(res, 400, 'Validation Error', 'Request validation failed', errors);
      span.setStatus({ code: SpanStatusCode.ERROR, message: 'Validation failed' });
      span.end();
      return;
    }

    const notificationId = `notif-${uuidv4().substring(0, 8)}`;
    const now = new Date().toISOString();

    const notification: Notification = {
      id: notificationId,
      order_id: body.order_id,
      customer_email: body.customer_email,
      customer_name: body.customer_name,
      type: body.type,
      channel: body.channel || 'email',
      message: body.message,
      status: 'pending',
      created_at: now,
      sent_at: null,
      links: {
        self: `/api/v1/notifications/${notificationId}`,
      },
    };

    span.setAttribute('notification.id', notificationId);
    span.setAttribute('order.id', body.order_id);
    span.setAttribute('notification.type', body.type);

    // Simulate sending notification
    notification.status = simulateSendNotification(notification);
    if (notification.status === 'sent') {
      notification.sent_at = new Date().toISOString();
    }

    notifications.set(notificationId, notification);

    console.info(`Notification ${notificationId} created for order ${body.order_id}: ${notification.status}`);

    span.setStatus({ code: SpanStatusCode.OK });
    span.end();

    res.status(201).json(notification);
  } catch (error) {
    span.setStatus({ code: SpanStatusCode.ERROR, message: String(error) });
    span.end();
    sendError(res, 500, 'Internal Error', String(error));
  }
});

/**
 * GET /api/v1/notifications - List notifications
 */
app.get('/api/v1/notifications', (req: Request, res: Response) => {
  const page = Math.max(1, parseInt(req.query.page as string) || 1);
  const pageSize = Math.min(100, Math.max(1, parseInt(req.query.page_size as string) || 10));
  const orderId = req.query.order_id as string | undefined;
  const status = req.query.status as NotificationStatus | undefined;

  let filtered = Array.from(notifications.values());

  // Apply filters
  if (orderId) {
    filtered = filtered.filter((n) => n.order_id === orderId);
  }
  if (status) {
    filtered = filtered.filter((n) => n.status === status);
  }

  // Sort by created_at descending
  filtered.sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());

  // Paginate
  const total = filtered.length;
  const start = (page - 1) * pageSize;
  const end = Math.min(start + pageSize, total);
  const pageData = filtered.slice(start, end);

  const links: Record<string, string> = {
    self: `/api/v1/notifications?page=${page}&page_size=${pageSize}`,
  };
  if (page > 1) {
    links.prev = `/api/v1/notifications?page=${page - 1}&page_size=${pageSize}`;
  }
  if (end < total) {
    links.next = `/api/v1/notifications?page=${page + 1}&page_size=${pageSize}`;
  }

  const response: PaginatedResponse<Notification> = {
    data: pageData,
    total,
    page,
    page_size: pageSize,
    links,
  };

  res.json(response);
});

/**
 * GET /api/v1/notifications/:id - Get notification by ID
 */
app.get('/api/v1/notifications/:id', (req: Request, res: Response) => {
  const { id } = req.params;

  const notification = notifications.get(id);
  if (!notification) {
    sendError(res, 404, 'Not Found', `Notification ${id} not found`);
    return;
  }

  res.json(notification);
});

/**
 * POST /api/v1/notifications/:id/resend - Resend a failed notification
 */
app.post('/api/v1/notifications/:id/resend', (req: Request, res: Response) => {
  const { id } = req.params;

  const notification = notifications.get(id);
  if (!notification) {
    sendError(res, 404, 'Not Found', `Notification ${id} not found`);
    return;
  }

  if (notification.status === 'sent' || notification.status === 'delivered') {
    sendError(res, 400, 'Invalid State', `Notification already ${notification.status}`);
    return;
  }

  // Resend
  notification.status = simulateSendNotification(notification);
  if (notification.status === 'sent') {
    notification.sent_at = new Date().toISOString();
  }

  console.info(`Notification ${id} resent: ${notification.status}`);
  res.json(notification);
});

// --- Legacy endpoints ---

app.get('/hello', (_req: Request, res: Response) => {
  res.json({ message: 'Hello from Node (Notification Service)', docs: '/api/v1/notifications' });
});

// --- Error handling ---

app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
  console.error('Unhandled error:', err);
  sendError(res, 500, 'Internal Server Error', err.message);
});

// --- Start server ---

app.listen(PORT, () => {
  console.info(`Notification service listening on port ${PORT}`);
});
