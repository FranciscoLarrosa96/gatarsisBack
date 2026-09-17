import { DataSource } from "typeorm";
import { InventoryService } from "../inventory/inventory.service";
import { Order, OrderKind } from "../orders/entities/order.entity";
import {
  RaffleLifecycleService,
  RafflePreferenceContext,
} from "../raffles/raffle-lifecycle.service";
import { MercadoPagoGatewayContract } from "./mercado-pago.gateway";
import { PaymentsService } from "./payments.service";

describe("Mercado Pago return URL contract", () => {
  const orderId = "a723e5bb-1f36-4788-8625-f93b5e721c7a";
  const purchaseId = "f620e8a5-1169-429c-82ac-e0cf87f6b851";
  const context: RafflePreferenceContext = {
    raffleId: "7462107d-880c-478b-9f61-653215290389",
    rafflePurchaseId: purchaseId,
    item: {
      id: "raffle-item",
      title: "Rifa solidaria",
      description: "Números: 07",
      quantity: 1,
      unitPriceInCents: 50_000,
    },
  };
  let service: PaymentsService;
  let savedEnvironment: NodeJS.ProcessEnv;

  beforeEach(() => {
    savedEnvironment = { ...process.env };
    process.env.MP_ENABLED = "true";
    process.env.MP_ACCESS_TOKEN = "test-token";
    process.env.MP_WEBHOOK_SECRET = "test-secret";
    process.env.FRONTEND_URL = "https://gatarsis.com.ar///";
    service = new PaymentsService(
      {} as DataSource,
      {} as InventoryService,
      {} as RaffleLifecycleService,
      {} as MercadoPagoGatewayContract,
    );
  });

  afterEach(() => {
    process.env = savedEnvironment;
  });

  it.each(["success", "pending", "failure"])(
    "sends a new raffle %s return directly to the raffle purchase route",
    (outcome) => {
      const payload = service["preferencePayload"](
        {
          id: orderId,
          kind: OrderKind.RAFFLE,
          reservationExpiresAt: new Date("2027-01-01T00:00:00Z"),
        } as Order,
        [],
        context,
      );
      const backUrl =
        payload.back_urls[outcome as keyof typeof payload.back_urls];
      expect(backUrl).toBe(
        `https://gatarsis.com.ar/rifa/checkout/${outcome}?rafflePurchaseId=${purchaseId}`,
      );
      expect(payload.external_reference).toBe(orderId);
      expect(payload.external_reference).not.toBe(purchaseId);
      expect(payload.auto_return).toBe("approved");
      expect(payload).not.toHaveProperty("notification_url");
      expect(new URL(backUrl).pathname).not.toContain("//");
    },
  );

  it("keeps all SHOP return URLs and external_reference unchanged", () => {
    const payload = service["preferencePayload"](
      {
        id: orderId,
        kind: OrderKind.MERCH,
        reservationExpiresAt: new Date("2027-01-01T00:00:00Z"),
      } as Order,
      [],
    );
    expect(payload.back_urls).toEqual({
      success: "https://gatarsis.com.ar/checkout/success",
      pending: "https://gatarsis.com.ar/checkout/pending",
      failure: "https://gatarsis.com.ar/checkout/failure",
    });
    expect(payload.external_reference).toBe(orderId);
    expect(payload.auto_return).toBe("approved");
    expect(payload).not.toHaveProperty("notification_url");
  });
});
