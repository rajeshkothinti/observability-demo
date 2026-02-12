"""
Pydantic models for the Order service API.
Following REST best practices: clear schemas, validation, serialization.
"""
from datetime import datetime
from enum import Enum
from typing import List, Optional
from pydantic import BaseModel, Field
import uuid


class OrderStatus(str, Enum):
    PENDING = "pending"
    INVENTORY_RESERVED = "inventory_reserved"
    PAYMENT_PROCESSED = "payment_processed"
    CONFIRMED = "confirmed"
    FAILED = "failed"
    CANCELLED = "cancelled"


class OrderItem(BaseModel):
    product_id: str = Field(..., description="Product identifier")
    quantity: int = Field(..., ge=1, description="Quantity ordered")
    unit_price: float = Field(..., gt=0, description="Price per unit")


class CustomerInfo(BaseModel):
    customer_id: str = Field(..., description="Customer identifier")
    email: str = Field(..., description="Customer email for notifications")
    name: str = Field(..., description="Customer name")


class CreateOrderRequest(BaseModel):
    """Request body for creating a new order."""
    customer: CustomerInfo
    items: List[OrderItem] = Field(..., min_length=1, description="Order items")
    
    class Config:
        json_schema_extra = {
            "example": {
                "customer": {
                    "customer_id": "cust-123",
                    "email": "john@example.com",
                    "name": "John Doe"
                },
                "items": [
                    {"product_id": "prod-001", "quantity": 2, "unit_price": 29.99}
                ]
            }
        }


class OrderResponse(BaseModel):
    """Response model for an order."""
    id: str = Field(..., description="Order identifier")
    customer: CustomerInfo
    items: List[OrderItem]
    total_amount: float = Field(..., description="Total order amount")
    status: OrderStatus
    created_at: datetime
    updated_at: datetime
    inventory_reservation_id: Optional[str] = None
    payment_id: Optional[str] = None
    notification_id: Optional[str] = None
    
    # HATEOAS links
    links: dict = Field(default_factory=dict, description="Related resource links")


class OrderListResponse(BaseModel):
    """Paginated list of orders."""
    data: List[OrderResponse]
    total: int
    page: int
    page_size: int
    links: dict = Field(default_factory=dict, description="Pagination links")


class ErrorDetail(BaseModel):
    """Standard error detail."""
    field: Optional[str] = None
    message: str


class ErrorResponse(BaseModel):
    """Standard error response following RFC 7807 (Problem Details)."""
    type: str = Field(..., description="Error type URI")
    title: str = Field(..., description="Short error title")
    status: int = Field(..., description="HTTP status code")
    detail: str = Field(..., description="Detailed error message")
    instance: Optional[str] = Field(None, description="Request path")
    errors: Optional[List[ErrorDetail]] = None
    trace_id: Optional[str] = Field(None, description="Trace ID for debugging")


# In-memory storage (would be database in production)
orders_db: dict[str, dict] = {}


def generate_order_id() -> str:
    return f"ord-{uuid.uuid4().hex[:12]}"
