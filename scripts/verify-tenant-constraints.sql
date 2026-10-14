BEGIN;

INSERT INTO "Tenant" ("id", "slug", "name", "status", "updatedAt")
VALUES
  ('tenant-fk-a', 'tenant-fk-a', 'Tenant FK A', 'ACTIVE', CURRENT_TIMESTAMP),
  ('tenant-fk-b', 'tenant-fk-b', 'Tenant FK B', 'ACTIVE', CURRENT_TIMESTAMP);

INSERT INTO "Customer" ("id", "tenantId", "updatedAt")
VALUES
  ('customer-fk-a', 'tenant-fk-a', CURRENT_TIMESTAMP),
  ('customer-fk-b', 'tenant-fk-b', CURRENT_TIMESTAMP);

INSERT INTO "Product" ("id", "tenantId", "slug", "name", "type", "priceMinor", "updatedAt")
VALUES
  ('product-fk-a', 'tenant-fk-a', 'product-fk-a', 'Product A', 'DIGITAL', 100, CURRENT_TIMESTAMP),
  ('product-fk-b', 'tenant-fk-b', 'product-fk-b', 'Product B', 'DIGITAL', 100, CURRENT_TIMESTAMP),
  ('product-fk-a2', 'tenant-fk-a', 'product-fk-a2', 'Product A2', 'DIGITAL', 100, CURRENT_TIMESTAMP);

INSERT INTO "Plan" ("id", "tenantId", "productId", "slug", "name", "priceMinor", "updatedAt")
VALUES
  ('plan-fk-a', 'tenant-fk-a', 'product-fk-a', 'plan-fk-a', 'Plan A', 100, CURRENT_TIMESTAMP),
  ('plan-fk-a2', 'tenant-fk-a', 'product-fk-a2', 'plan-fk-a2', 'Plan A2', 100, CURRENT_TIMESTAMP);

INSERT INTO "Order" (
  "id", "tenantId", "customerId", "orderNumber", "subtotalMinor",
  "totalMinor", "idempotencyKey", "updatedAt"
)
VALUES (
  'order-fk-a', 'tenant-fk-a', 'customer-fk-a', 'order-fk-a',
  100, 100, 'order-fk-a', CURRENT_TIMESTAMP
);

DO $$
BEGIN
  BEGIN
    INSERT INTO "Order" (
      "id", "tenantId", "customerId", "orderNumber", "subtotalMinor",
      "totalMinor", "idempotencyKey", "updatedAt"
    ) VALUES (
      'order-fk-invalid-customer', 'tenant-fk-a', 'customer-fk-b',
      'order-fk-invalid-customer', 100, 100, 'order-fk-invalid-customer', CURRENT_TIMESTAMP
    );
    RAISE EXCEPTION 'Expected the database to reject an order referencing another tenant customer';
  EXCEPTION WHEN foreign_key_violation THEN
    NULL;
  END;

  BEGIN
    INSERT INTO "Plan" (
      "id", "tenantId", "productId", "slug", "name", "priceMinor", "updatedAt"
    ) VALUES (
      'plan-fk-invalid-product', 'tenant-fk-a', 'product-fk-b',
      'plan-fk-invalid-product', 'Invalid Plan', 100, CURRENT_TIMESTAMP
    );
    RAISE EXCEPTION 'Expected the database to reject a plan referencing another tenant product';
  EXCEPTION WHEN foreign_key_violation THEN
    NULL;
  END;

  BEGIN
    INSERT INTO "OrderItem" (
      "id", "tenantId", "orderId", "productId", "unitPriceMinor", "totalPriceMinor"
    ) VALUES (
      'item-fk-invalid-product', 'tenant-fk-a', 'order-fk-a',
      'product-fk-b', 100, 100
    );
    RAISE EXCEPTION 'Expected the database to reject an order item referencing another tenant product';
  EXCEPTION WHEN foreign_key_violation THEN
    NULL;
  END;

  BEGIN
    INSERT INTO "OrderItem" (
      "id", "tenantId", "orderId", "productId", "planId", "unitPriceMinor", "totalPriceMinor"
    ) VALUES (
      'item-fk-invalid-plan', 'tenant-fk-a', 'order-fk-a',
      'product-fk-a', 'plan-fk-a2', 100, 100
    );
    RAISE EXCEPTION 'Expected the database to reject a plan that belongs to a different product';
  EXCEPTION WHEN foreign_key_violation THEN
    NULL;
  END;
END $$;

ROLLBACK;
