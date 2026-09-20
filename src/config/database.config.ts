import { TypeOrmModuleOptions } from "@nestjs/typeorm";
import { DataSourceOptions } from "typeorm";
import { Inventory } from "../inventory/entities/inventory.entity";
import { InventoryMovement } from "../inventory/entities/inventory-movement.entity";
import { Order } from "../orders/entities/order.entity";
import { OrderItem } from "../orders/entities/order-item.entity";
import { Payment } from "../payments/entities/payment.entity";
import { PaymentPreference } from "../payments/entities/payment-preference.entity";
import { WebhookEvent } from "../payments/entities/webhook-event.entity";
import { AdminUser } from "../admin/entities/admin-user.entity";
import { AdminSession } from "../admin/entities/admin-session.entity";
import { AdminAuditLog } from "../admin/entities/admin-audit-log.entity";
import { InitialCommerce1766448000000 } from "../database/migrations/1766448000000-InitialCommerce";
import { PaymentsMercadoPago1766534400000 } from "../database/migrations/1766534400000-PaymentsMercadoPago";
import { AdminAuth1766620800000 } from "../database/migrations/1766620800000-AdminAuth";
import { AdminProducts1766707200000 } from "../database/migrations/1766707200000-AdminProducts";
import { AdminPaymentReview1766793600000 } from "../database/migrations/1766793600000-AdminPaymentReview";
import { OrderFulfillment1766880000000 } from "../database/migrations/1766880000000-OrderFulfillment";
import { OrderFulfillment } from "../orders/entities/order-fulfillment.entity";
import { ProductMedia } from "../products/entities/product-media.entity";
import { Product } from "../products/entities/product.entity";
import { ProductVariant } from "../products/entities/product-variant.entity";
import { RefundOperation } from "../payments/entities/refund-operation.entity";
import { RefundOperations1766880000000 } from "../database/migrations/1766880000000-RefundOperations";
import { VariantMedia1766966400000 } from "../database/migrations/1766966400000-VariantMedia";
import { EarlyPaymentReconciliation1767052800000 } from "../database/migrations/1767052800000-EarlyPaymentReconciliation";
import { VariantAttributes1767139200000 } from "../database/migrations/1767139200000-VariantAttributes";
import { RafflesFoundation1767225600000 } from "../database/migrations/1767225600000-RafflesFoundation";
import { Raffle } from "../raffles/entities/raffle.entity";
import { RaffleNumber } from "../raffles/entities/raffle-number.entity";
import { RafflePurchase } from "../raffles/entities/raffle-purchase.entity";
import { OneActiveRaffle1767312000000 } from "../database/migrations/1767312000000-OneActiveRaffle";
import { AdoptableCats1767398400000 } from "../database/migrations/1767398400000-AdoptableCats";
import { ManualRaffleSales1767484800000 } from "../database/migrations/1767484800000-ManualRaffleSales";
import { AdoptableCat } from "../adoptions/entities/adoptable-cat.entity";
import { AdoptionApplication } from "../adoptions/entities/adoption-application.entity";

const numberFromEnv = (name: string, fallback: number): number => {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isFinite(value)) throw new Error(`${name} must be a number`);
  return value;
};

const positiveNumberFromEnv = (name: string, fallback: number): number => {
  const value = numberFromEnv(name, fallback);
  if (value <= 0) throw new Error(`${name} must be positive`);
  return value;
};

const positiveIntegerFromEnv = (name: string, fallback: number): number => {
  const value = positiveNumberFromEnv(name, fallback);
  if (!Number.isInteger(value)) throw new Error(`${name} must be an integer`);
  return value;
};

const databaseSsl = () => {
  if (process.env.DATABASE_SSL !== "true") return false;
  const ca = process.env.DATABASE_SSL_CA?.replace(/\\n/g, "\n");
  return {
    rejectUnauthorized: true,
    ...(ca?.trim() ? { ca } : {}),
  };
};

export const adminAuthConfig = () => {
  const accessTokenMinutes = numberFromEnv("ADMIN_ACCESS_TOKEN_MINUTES", 15);
  const refreshTokenHours = numberFromEnv("ADMIN_REFRESH_TOKEN_HOURS", 8);
  if (accessTokenMinutes <= 0 || refreshTokenHours <= 0)
    throw new Error("Admin token lifetimes must be positive.");
  const configuredSecret = process.env.ADMIN_JWT_ACCESS_SECRET;
  if (process.env.NODE_ENV === "production" && !configuredSecret)
    throw new Error("ADMIN_JWT_ACCESS_SECRET is required in production.");
  return {
    accessSecret: configuredSecret ?? "development-only-admin-jwt-secret",
    accessTokenMinutes,
    refreshTokenHours,
  };
};

const dataSourceOptions = (): DataSourceOptions => ({
  type: "postgres",
  host: process.env.DATABASE_HOST ?? "localhost",
  port: numberFromEnv("DATABASE_PORT", 5432),
  username: process.env.DATABASE_USER ?? "gatarsis",
  password: process.env.DATABASE_PASSWORD ?? "gatarsis_local_password",
  database: process.env.DATABASE_NAME ?? "gatarsis",
  ssl: databaseSsl(),
  extra: {
    max: positiveIntegerFromEnv("DATABASE_POOL_MAX", 10),
    connectionTimeoutMillis: positiveIntegerFromEnv(
      "DATABASE_CONNECTION_TIMEOUT_MS",
      10_000,
    ),
    statement_timeout: positiveIntegerFromEnv(
      "DATABASE_STATEMENT_TIMEOUT_MS",
      30_000,
    ),
    query_timeout: positiveIntegerFromEnv("DATABASE_QUERY_TIMEOUT_MS", 35_000),
  },
  entities: [
    Product,
    ProductVariant,
    Inventory,
    InventoryMovement,
    Order,
    OrderItem,
    PaymentPreference,
    Payment,
    WebhookEvent,
    AdminUser,
    AdminSession,
    AdminAuditLog,
    OrderFulfillment,
    ProductMedia,
    RefundOperation,
    Raffle,
    RafflePurchase,
    RaffleNumber,
    AdoptableCat,
    AdoptionApplication,
  ],
  synchronize: false,
  migrations: [
    InitialCommerce1766448000000,
    PaymentsMercadoPago1766534400000,
    AdminAuth1766620800000,
    AdminProducts1766707200000,
    AdminPaymentReview1766793600000,
    OrderFulfillment1766880000000,
    RefundOperations1766880000000,
    VariantMedia1766966400000,
    EarlyPaymentReconciliation1767052800000,
    VariantAttributes1767139200000,
    RafflesFoundation1767225600000,
    OneActiveRaffle1767312000000,
    AdoptableCats1767398400000,
    ManualRaffleSales1767484800000,
  ],
});

export const databaseConfig = (): TypeOrmModuleOptions =>
  dataSourceOptions() as TypeOrmModuleOptions;

export const dataSourceConfig = (): DataSourceOptions => dataSourceOptions();

export const reservationMinutes = (): number =>
  numberFromEnv("STOCK_RESERVATION_MINUTES", 15);

const frontendUrl = (environment: NodeJS.ProcessEnv): string =>
  (environment.FRONTEND_URL?.trim() ?? "").replace(/\/+$/, "");

export const validateMercadoPagoEnvironment = (environment = process.env) => {
  if (environment.MP_ENABLED !== "true") return;
  if (!environment.MP_ACCESS_TOKEN?.trim())
    throw new Error("MP_ENABLED=true but MP_ACCESS_TOKEN is missing");
  if (!environment.MP_WEBHOOK_SECRET?.trim())
    throw new Error("MP_ENABLED=true but MP_WEBHOOK_SECRET is missing");
  const publicFrontendUrl = frontendUrl(environment);
  if (!publicFrontendUrl)
    throw new Error("MP_ENABLED=true but FRONTEND_URL is missing");
  let parsed: URL;
  try {
    parsed = new URL(publicFrontendUrl);
  } catch {
    throw new Error("MP_ENABLED=true but FRONTEND_URL is invalid");
  }
  if (parsed.protocol !== "https:")
    throw new Error("MP_ENABLED=true but FRONTEND_URL must use HTTPS");
};

export const mercadoPagoConfig = () => {
  validateMercadoPagoEnvironment();
  return {
    enabled: process.env.MP_ENABLED === "true",
    accessToken: process.env.MP_ACCESS_TOKEN?.trim() ?? "",
    webhookSecret: process.env.MP_WEBHOOK_SECRET?.trim() ?? "",
    frontendUrl: frontendUrl(process.env),
    excludeTicket: process.env.MP_EXCLUDE_TICKET !== "false",
    binaryMode: process.env.MP_BINARY_MODE === "true",
    reconciliationGraceSeconds: numberFromEnv(
      "MP_RECONCILIATION_GRACE_SECONDS",
      120,
    ),
    earlyReconciliationIntervalSeconds: numberFromEnv(
      "MP_EARLY_RECONCILIATION_INTERVAL_SECONDS",
      60,
    ),
    pendingReviewHours: positiveNumberFromEnv("MP_PENDING_REVIEW_HOURS", 24),
    preferenceCreatingStaleSeconds: positiveNumberFromEnv(
      "MP_PREFERENCE_CREATING_STALE_SECONDS",
      60,
    ),
    preferenceRecoveryConfirmSeconds: positiveNumberFromEnv(
      "MP_PREFERENCE_RECOVERY_CONFIRM_SECONDS",
      30,
    ),
  };
};
