"""
Postgres persistence for orders (kind-local branch).
Uses DATABASE_URL env; falls back to in-memory dict if not set.
"""
import json
import logging
import os
from contextlib import contextmanager
from datetime import datetime
from typing import Any, Generator, List, Optional

logger = logging.getLogger(__name__)

DATABASE_URL = os.getenv("DATABASE_URL")

# In-memory fallback when DATABASE_URL is not set (e.g. tests)
_memory: dict[str, dict] = {}


def _get_conn():
    import psycopg2
    return psycopg2.connect(DATABASE_URL)


def init_db() -> None:
    """Create orders table if not exists."""
    if not DATABASE_URL:
        logger.warning("DATABASE_URL not set; using in-memory storage")
        return
    try:
        with _get_conn() as conn:
            with conn.cursor() as cur:
                cur.execute("""
                    CREATE TABLE IF NOT EXISTS orders (
                        id TEXT PRIMARY KEY,
                        customer JSONB NOT NULL,
                        items JSONB NOT NULL,
                        total_amount NUMERIC(12,2) NOT NULL,
                        status TEXT NOT NULL,
                        created_at TIMESTAMPTZ NOT NULL,
                        updated_at TIMESTAMPTZ NOT NULL,
                        inventory_reservation_id TEXT,
                        payment_id TEXT,
                        notification_id TEXT
                    )
                """)
            conn.commit()
        logger.info("Orders table ready")
    except Exception as e:
        logger.exception("Failed to init orders table: %s", e)
        raise


def order_save(order: dict) -> None:
    if not DATABASE_URL:
        _memory[order["id"]] = order
        return
    with _get_conn() as conn:
        with conn.cursor() as cur:
            cur.execute(
                """
                INSERT INTO orders (id, customer, items, total_amount, status, created_at, updated_at,
                                   inventory_reservation_id, payment_id, notification_id)
                VALUES (%s, %s::jsonb, %s::jsonb, %s, %s, %s, %s, %s, %s, %s)
                ON CONFLICT (id) DO UPDATE SET
                    customer = EXCLUDED.customer, items = EXCLUDED.items, total_amount = EXCLUDED.total_amount,
                    status = EXCLUDED.status, updated_at = EXCLUDED.updated_at,
                    inventory_reservation_id = EXCLUDED.inventory_reservation_id,
                    payment_id = EXCLUDED.payment_id, notification_id = EXCLUDED.notification_id
                """,
                (
                    order["id"],
                    json.dumps(order["customer"]),
                    json.dumps(order["items"]),
                    order["total_amount"],
                    order["status"],
                    order["created_at"],
                    order["updated_at"],
                    order.get("inventory_reservation_id"),
                    order.get("payment_id"),
                    order.get("notification_id"),
                ),
            )
        conn.commit()


def order_get(order_id: str) -> Optional[dict]:
    if not DATABASE_URL:
        return _memory.get(order_id)
    with _get_conn() as conn:
        with conn.cursor() as cur:
            cur.execute(
                "SELECT id, customer, items, total_amount, status, created_at, updated_at, "
                "inventory_reservation_id, payment_id, notification_id FROM orders WHERE id = %s",
                (order_id,),
            )
            row = cur.fetchone()
    if not row:
        return None
    return {
        "id": row[0],
        "customer": row[1] if isinstance(row[1], dict) else json.loads(row[1]),
        "items": row[2] if isinstance(row[2], list) else json.loads(row[2]),
        "total_amount": float(row[3]),
        "status": row[4],
        "created_at": row[5],
        "updated_at": row[6],
        "inventory_reservation_id": row[7],
        "payment_id": row[8],
        "notification_id": row[9],
    }


def order_list(
    customer_id: Optional[str] = None,
    status: Optional[str] = None,
    limit: int = 1000,
    offset: int = 0,
) -> List[dict]:
    if not DATABASE_URL:
        filtered = list(_memory.values())
        if customer_id:
            filtered = [o for o in filtered if o.get("customer", {}).get("customer_id") == customer_id]
        if status:
            filtered = [o for o in filtered if o.get("status") == status]
        filtered.sort(key=lambda x: x["created_at"], reverse=True)
        return filtered[offset : offset + limit]
    with _get_conn() as conn:
        with conn.cursor() as cur:
            q = "SELECT id, customer, items, total_amount, status, created_at, updated_at, inventory_reservation_id, payment_id, notification_id FROM orders WHERE 1=1"
            params: list = []
            if customer_id:
                q += " AND customer->>'customer_id' = %s"
                params.append(customer_id)
            if status:
                q += " AND status = %s"
                params.append(status)
            q += " ORDER BY created_at DESC LIMIT %s OFFSET %s"
            params.extend([limit, offset])
            cur.execute(q, params)
            rows = cur.fetchall()
    return [
        {
            "id": r[0],
            "customer": r[1] if isinstance(r[1], dict) else json.loads(r[1]),
            "items": r[2] if isinstance(r[2], list) else json.loads(r[2]),
            "total_amount": float(r[3]),
            "status": r[4],
            "created_at": r[5],
            "updated_at": r[6],
            "inventory_reservation_id": r[7],
            "payment_id": r[8],
            "notification_id": r[9],
        }
        for r in rows
    ]


def order_count(customer_id: Optional[str] = None, status: Optional[str] = None) -> int:
    if not DATABASE_URL:
        filtered = list(_memory.values())
        if customer_id:
            filtered = [o for o in filtered if o.get("customer", {}).get("customer_id") == customer_id]
        if status:
            filtered = [o for o in filtered if o.get("status") == status]
        return len(filtered)
    with _get_conn() as conn:
        with conn.cursor() as cur:
            q = "SELECT COUNT(*) FROM orders WHERE 1=1"
            params: list = []
            if customer_id:
                q += " AND customer->>'customer_id' = %s"
                params.append(customer_id)
            if status:
                q += " AND status = %s"
                params.append(status)
            cur.execute(q, params)
            return cur.fetchone()[0]
