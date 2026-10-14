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

INSERT INTO "Order" (
  "id", "tenantId", "customerId", "orderNumber", "subtotalMinor",
  "totalMinor", "idempotencyKey", "updatedAt"
)
VALUES (
  'order-fk-b', 'tenant-fk-b', 'customer-fk-b', 'order-fk-b',
  100, 100, 'order-fk-b', CURRENT_TIMESTAMP
);

INSERT INTO "Payment" ("id", "tenantId", "orderId", "amountMinor", "idempotencyKey", "provider", "updatedAt")
VALUES
  ('payment-fk-a', 'tenant-fk-a', 'order-fk-a', 100, 'payment-fk-a', 'test', CURRENT_TIMESTAMP),
  ('payment-fk-b', 'tenant-fk-b', 'order-fk-b', 100, 'payment-fk-b', 'test', CURRENT_TIMESTAMP);

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

  BEGIN
    INSERT INTO "Payment" ("id", "tenantId", "orderId", "amountMinor", "idempotencyKey", "provider", "updatedAt")
    VALUES ('payment-fk-invalid-order', 'tenant-fk-a', 'order-fk-b', 100, 'payment-fk-invalid-order', 'test', CURRENT_TIMESTAMP);
    RAISE EXCEPTION 'Expected the database to reject a payment referencing another tenant order';
  EXCEPTION WHEN foreign_key_violation THEN
    NULL;
  END;

  BEGIN
    INSERT INTO "PaymentAttempt" ("id", "tenantId", "paymentId", "attemptNumber", "updatedAt")
    VALUES ('attempt-fk-invalid-payment', 'tenant-fk-a', 'payment-fk-b', 1, CURRENT_TIMESTAMP);
    RAISE EXCEPTION 'Expected the database to reject a payment attempt referencing another tenant payment';
  EXCEPTION WHEN foreign_key_violation THEN
    NULL;
  END;

  BEGIN
    INSERT INTO "Refund" ("id", "tenantId", "paymentId", "amountMinor", "idempotencyKey", "updatedAt")
    VALUES ('refund-fk-invalid-payment', 'tenant-fk-a', 'payment-fk-b', 100, 'refund-fk-invalid-payment', CURRENT_TIMESTAMP);
    RAISE EXCEPTION 'Expected the database to reject a refund referencing another tenant payment';
  EXCEPTION WHEN foreign_key_violation THEN
    NULL;
  END;

  BEGIN
    INSERT INTO "Invoice" ("id", "tenantId", "orderId", "invoiceNumber", "amountMinor")
    VALUES ('invoice-fk-invalid-order', 'tenant-fk-a', 'order-fk-b', 'invoice-fk-invalid-order', 100);
    RAISE EXCEPTION 'Expected the database to reject an invoice referencing another tenant order';
  EXCEPTION WHEN foreign_key_violation THEN
    NULL;
  END;

  BEGIN
    INSERT INTO "Subscription" ("id", "tenantId", "customerId", "orderId", "productId", "planId", "name", "updatedAt")
    VALUES ('subscription-fk-invalid-plan', 'tenant-fk-a', 'customer-fk-a', 'order-fk-a', 'product-fk-a', 'plan-fk-a2', 'Invalid Plan', CURRENT_TIMESTAMP);
    RAISE EXCEPTION 'Expected the database to reject a subscription plan that belongs to another product';
  EXCEPTION WHEN foreign_key_violation THEN
    NULL;
  END;

  BEGIN
    INSERT INTO "Subscription" ("id", "tenantId", "customerId", "orderId", "productId", "name", "updatedAt")
    VALUES ('subscription-fk-invalid-order', 'tenant-fk-a', 'customer-fk-a', 'order-fk-b', 'product-fk-a', 'Invalid Order', CURRENT_TIMESTAMP);
    RAISE EXCEPTION 'Expected the database to reject a subscription referencing another tenant order';
  EXCEPTION WHEN foreign_key_violation THEN
    NULL;
  END;
END $$;

ROLLBACK;
