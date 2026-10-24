import { Module } from "@nestjs/common";
import { APP_GUARD } from "@nestjs/core";
import { JwtModule } from "@nestjs/jwt";
import { ThrottlerModule } from "@nestjs/throttler";
import { AdminAuthController } from "./admin-auth.controller";
import { AdminAuthGuard } from "./admin-auth.guard";
import { AdminAuthService } from "./admin-auth.service";
import { AdminProductsController } from "./admin-products.controller";
import { AdminProductsService } from "./admin-products.service";
import { AdminInventoryController } from "./admin-inventory.controller";
import { AdminInventoryService } from "./admin-inventory.service";
import { AdminOrdersPaymentsController } from "./admin-orders-payments.controller";
import { adminAuthConfig } from "../config/database.config";
import { PaymentsModule } from "../payments/payments.module";
import { AdminRefundsController } from "./admin-refunds.controller";
import { AdminRefundsService } from "./admin-refunds.service";
import { AdminDashboardAuditController } from './admin-dashboard-audit.controller';
import { InventoryModule } from "../inventory/inventory.module";
import { AdminManualStoreSalesController } from "./admin-manual-store-sales.controller";
import { AdminManualStoreSalesService } from "./admin-manual-store-sales.service";

const authConfig = adminAuthConfig();

@Module({
  imports: [
    JwtModule.register({
      secret: authConfig.accessSecret,
      signOptions: { expiresIn: authConfig.accessTokenMinutes * 60 },
    }),
    ThrottlerModule.forRoot([{ ttl: 60_000, limit: 100 }]),
    PaymentsModule,
    InventoryModule,
  ],
  controllers: [
    AdminAuthController,
    AdminProductsController,
    AdminInventoryController,
    AdminOrdersPaymentsController,
    AdminRefundsController,
    AdminDashboardAuditController,
    AdminManualStoreSalesController,
  ],
  providers: [
    AdminAuthService,
    AdminProductsService,
    AdminInventoryService,
    AdminRefundsService,
    AdminManualStoreSalesService,
    { provide: APP_GUARD, useClass: AdminAuthGuard },
  ],
})
export class AdminModule {}
