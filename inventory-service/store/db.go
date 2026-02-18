// Package store provides Postgres persistence for products and reservations (kind-local).
// When DATABASE_URL is set, use this store; otherwise main uses in-memory maps.
package store

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
	"os"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
)

var Pool *pgxpool.Pool

func Init(ctx context.Context) error {
	url := os.Getenv("DATABASE_URL")
	if url == "" {
		return nil
	}
	var err error
	Pool, err = pgxpool.New(ctx, url)
	if err != nil {
		return fmt.Errorf("postgres connect: %w", err)
	}
	if err := createTables(ctx); err != nil {
		return err
	}
	if err := seedProductsIfEmpty(ctx); err != nil {
		return err
	}
	log.Println("inventory store: postgres initialized")
	return nil
}

func createTables(ctx context.Context) error {
	_, err := Pool.Exec(ctx, `
		CREATE TABLE IF NOT EXISTS products (
			id TEXT PRIMARY KEY,
			name TEXT NOT NULL,
			description TEXT,
			price NUMERIC(12,2) NOT NULL,
			stock INT NOT NULL DEFAULT 0,
			created_at TIMESTAMPTZ NOT NULL,
			updated_at TIMESTAMPTZ NOT NULL
		);
		CREATE TABLE IF NOT EXISTS reservations (
			id TEXT PRIMARY KEY,
			order_id TEXT NOT NULL,
			items JSONB NOT NULL,
			status TEXT NOT NULL,
			created_at TIMESTAMPTZ NOT NULL,
			expires_at TIMESTAMPTZ NOT NULL
		);
	`)
	return err
}

func seedProductsIfEmpty(ctx context.Context) error {
	var n int
	err := Pool.QueryRow(ctx, "SELECT COUNT(*) FROM products").Scan(&n)
	if err != nil || n > 0 {
		return err
	}
	now := time.Now()
	seeds := []struct {
		ID, Name, Description string
		Price                  float64
		Stock                  int
	}{
		{"prod-001", "Laptop", "15-inch laptop", 999.99, 50},
		{"prod-002", "Mouse", "Wireless mouse", 29.99, 200},
		{"prod-003", "Keyboard", "Mechanical keyboard", 79.99, 100},
		{"prod-004", "Monitor", "27-inch 4K monitor", 399.99, 30},
		{"prod-005", "Headphones", "Noise-canceling headphones", 199.99, 75},
	}
	for _, s := range seeds {
		_, err := Pool.Exec(ctx,
			"INSERT INTO products (id, name, description, price, stock, created_at, updated_at) VALUES ($1,$2,$3,$4,$5,$6,$6)",
			s.ID, s.Name, s.Description, s.Price, s.Stock, now,
		)
		if err != nil {
			return err
		}
	}
	log.Println("inventory store: seeded products")
	return nil
}

// Product matches main.Product for JSON.
type Product struct {
	ID          string    `json:"id"`
	Name        string    `json:"name"`
	Description string    `json:"description"`
	Price       float64   `json:"price"`
	Stock       int       `json:"stock"`
	CreatedAt   time.Time `json:"created_at"`
	UpdatedAt   time.Time `json:"updated_at"`
	Links       map[string]string `json:"links,omitempty"`
}

// ReservationItem and Reservation match main types.
type ReservationItem struct {
	ProductID string `json:"product_id"`
	Quantity  int    `json:"quantity"`
}

type Reservation struct {
	ID        string            `json:"id"`
	OrderID   string            `json:"order_id"`
	Items     []ReservationItem `json:"items"`
	Status    string            `json:"status"`
	CreatedAt time.Time         `json:"created_at"`
	ExpiresAt time.Time         `json:"expires_at"`
	Links     map[string]string `json:"links,omitempty"`
}

func ListProducts(ctx context.Context, page, pageSize int) ([]*Product, int, error) {
	var total int
	err := Pool.QueryRow(ctx, "SELECT COUNT(*) FROM products").Scan(&total)
	if err != nil {
		return nil, 0, err
	}
	rows, err := Pool.Query(ctx,
		"SELECT id, name, description, price, stock, created_at, updated_at FROM products ORDER BY id LIMIT $1 OFFSET $2",
		pageSize, (page-1)*pageSize,
	)
	if err != nil {
		return nil, 0, err
	}
	defer rows.Close()
	var list []*Product
	for rows.Next() {
		var p Product
		err := rows.Scan(&p.ID, &p.Name, &p.Description, &p.Price, &p.Stock, &p.CreatedAt, &p.UpdatedAt)
		if err != nil {
			return nil, 0, err
		}
		p.Links = map[string]string{"self": fmt.Sprintf("/api/v1/products/%s", p.ID)}
		list = append(list, &p)
	}
	return list, total, rows.Err()
}

func GetProduct(ctx context.Context, id string) (*Product, error) {
	var p Product
	err := Pool.QueryRow(ctx,
		"SELECT id, name, description, price, stock, created_at, updated_at FROM products WHERE id = $1",
		id,
	).Scan(&p.ID, &p.Name, &p.Description, &p.Price, &p.Stock, &p.CreatedAt, &p.UpdatedAt)
	if err != nil {
		return nil, err
	}
	p.Links = map[string]string{"self": fmt.Sprintf("/api/v1/products/%s", p.ID)}
	return &p, nil
}

func CreateProduct(ctx context.Context, p *Product) error {
	p.ID = "prod-" + uuid.New().String()[:8]
	p.CreatedAt = time.Now()
	p.UpdatedAt = p.CreatedAt
	_, err := Pool.Exec(ctx,
		"INSERT INTO products (id, name, description, price, stock, created_at, updated_at) VALUES ($1,$2,$3,$4,$5,$6,$6)",
		p.ID, p.Name, p.Description, p.Price, p.Stock, p.CreatedAt,
	)
	return err
}

func UpdateProduct(ctx context.Context, id string, name, desc string, price float64, stock int) (*Product, error) {
	_, err := Pool.Exec(ctx,
		"UPDATE products SET name = COALESCE(NULLIF($2,''), name), description = COALESCE(NULLIF($3,''), description), price = CASE WHEN $4 > 0 THEN $4 ELSE price END, stock = CASE WHEN $5 >= 0 THEN $5 ELSE stock END, updated_at = $6 WHERE id = $1",
		id, name, desc, price, stock, time.Now(),
	)
	if err != nil {
		return nil, err
	}
	return GetProduct(ctx, id)
}

func DeleteProduct(ctx context.Context, id string) error {
	res, err := Pool.Exec(ctx, "DELETE FROM products WHERE id = $1", id)
	if err != nil {
		return err
	}
	if res.RowsAffected() == 0 {
		return fmt.Errorf("not found")
	}
	return nil
}

func Reserve(ctx context.Context, orderID string, items []ReservationItem) (*Reservation, error) {
	// Check and deduct stock in a transaction
	tx, err := Pool.Begin(ctx)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback(ctx)
	for _, it := range items {
		var stock int
		err := tx.QueryRow(ctx, "SELECT stock FROM products WHERE id = $1 FOR UPDATE", it.ProductID).Scan(&stock)
		if err != nil {
			return nil, err
		}
		if stock < it.Quantity {
			return nil, fmt.Errorf("insufficient stock for %s: want %d have %d", it.ProductID, it.Quantity, stock)
		}
		_, err = tx.Exec(ctx, "UPDATE products SET stock = stock - $2, updated_at = $3 WHERE id = $1", it.ProductID, it.Quantity, time.Now())
		if err != nil {
			return nil, err
		}
	}
	resID := "res-" + uuid.New().String()[:8]
	itemsJSON, _ := json.Marshal(items)
	expires := time.Now().Add(15 * time.Minute)
	_, err = tx.Exec(ctx,
		"INSERT INTO reservations (id, order_id, items, status, created_at, expires_at) VALUES ($1,$2,$3,'reserved',$4,$5)",
		resID, orderID, itemsJSON, time.Now(), expires,
	)
	if err != nil {
		return nil, err
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return &Reservation{
		ID:        resID,
		OrderID:   orderID,
		Items:     items,
		Status:    "reserved",
		CreatedAt: time.Now(),
		ExpiresAt: expires,
		Links:     map[string]string{"self": fmt.Sprintf("/api/v1/inventory/reservations/%s", resID)},
	}, nil
}

func GetReservation(ctx context.Context, id string) (*Reservation, error) {
	var itemsJSON []byte
	var res Reservation
	err := Pool.QueryRow(ctx,
		"SELECT id, order_id, items, status, created_at, expires_at FROM reservations WHERE id = $1",
		id,
	).Scan(&res.ID, &res.OrderID, &itemsJSON, &res.Status, &res.CreatedAt, &res.ExpiresAt)
	if err != nil {
		return nil, err
	}
	_ = json.Unmarshal(itemsJSON, &res.Items)
	res.Links = map[string]string{"self": fmt.Sprintf("/api/v1/inventory/reservations/%s", res.ID)}
	return &res, nil
}

func Release(ctx context.Context, reservationID string) (*Reservation, error) {
	res, err := GetReservation(ctx, reservationID)
	if err != nil {
		return nil, err
	}
	if res.Status == "released" {
		return res, nil
	}
	tx, err := Pool.Begin(ctx)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback(ctx)
	for _, it := range res.Items {
		_, err = tx.Exec(ctx, "UPDATE products SET stock = stock + $2, updated_at = $3 WHERE id = $1", it.ProductID, it.Quantity, time.Now())
		if err != nil {
			return nil, err
		}
	}
	_, err = tx.Exec(ctx, "UPDATE reservations SET status = 'released' WHERE id = $1", reservationID)
	if err != nil {
		return nil, err
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	res.Status = "released"
	return res, nil
}
