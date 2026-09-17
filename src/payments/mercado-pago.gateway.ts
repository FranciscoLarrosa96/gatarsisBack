import { Injectable, Logger } from "@nestjs/common";
import {
  InvalidWebhookSignatureError,
  MercadoPagoConfig,
  Payment,
  PaymentRefund,
  Preference,
  WebhookSignatureValidator,
} from "mercadopago";
import { mercadoPagoConfig } from "../config/database.config";

export const MERCADO_PAGO_GATEWAY = Symbol("MERCADO_PAGO_GATEWAY");
const MERCADO_PAGO_SDK_VERSION = require("mercadopago/package.json").version as string;
export type MercadoPagoPayment = {
  id: string;
  status: string;
  status_detail?: string;
  transaction_amount: number;
  currency_id: string;
  external_reference?: string;
  payment_method_id?: string;
  payment_type_id?: string;
  date_created?: string;
  date_approved?: string;
  date_last_updated?: string;
};
export type MercadoPagoPreference = { id: string; init_point: string };
export type MercadoPagoRefund = { id: string };
export interface MercadoPagoGatewayContract {
  createPreference(
    input: Record<string, unknown>,
  ): Promise<MercadoPagoPreference>;
  searchPreferencesByExternalReference(
    orderId: string,
  ): Promise<MercadoPagoPreference[]>;
  getPayment(paymentId: string): Promise<MercadoPagoPayment>;
  searchPaymentsByExternalReference(
    orderId: string,
  ): Promise<MercadoPagoPayment[]>;
  refundPayment(
    paymentId: string,
    idempotencyKey: string,
  ): Promise<MercadoPagoRefund>;
  listRefunds(paymentId: string): Promise<MercadoPagoRefund[]>;
  validateWebhookSignature(input: {
    xSignature?: string | string[];
    xRequestId?: string | string[];
    dataId?: string | string[];
  }): void;
}
@Injectable()
export class MercadoPagoGateway implements MercadoPagoGatewayContract {
  private readonly logger = new Logger(MercadoPagoGateway.name);
  private readonly config = mercadoPagoConfig();
  private readonly client = new MercadoPagoConfig({
    accessToken: this.config.accessToken,
    options: { timeout: 5000 },
  });
  private readonly preferences = new Preference(this.client);
  private readonly payments = new Payment(this.client);
  private readonly paymentRefunds = new PaymentRefund(this.client);
  private ensureEnabled() {
    if (!this.config.enabled || !this.config.accessToken)
      throw new Error("Mercado Pago is not enabled or configured");
  }
  async createPreference(
    input: Record<string, unknown>,
  ): Promise<MercadoPagoPreference> {
    this.ensureEnabled();
    const response = await this.preferences.create({ body: input as never });
    return { id: String(response.id), init_point: String(response.init_point) };
  }
  async searchPreferencesByExternalReference(
    orderId: string,
  ): Promise<MercadoPagoPreference[]> {
    this.ensureEnabled();
    const response = await this.preferences.search({
      options: { external_reference: orderId },
    });
    const details = await Promise.all(
      (response.elements ?? []).map((item) =>
        this.preferences.get({ preferenceId: item.id }),
      ),
    );
    return details
      .filter((item) => item.id && item.init_point)
      .map((item) => ({
        id: String(item.id),
        init_point: String(item.init_point),
      }));
  }
  async getPayment(paymentId: string): Promise<MercadoPagoPayment> {
    this.ensureEnabled();
    const response = await this.payments.get({ id: paymentId });
    if (
      response.id == null ||
      !response.status ||
      response.transaction_amount == null ||
      !response.currency_id
    )
      throw new Error("Mercado Pago returned an incomplete payment");
    return {
      id: String(response.id),
      status: response.status,
      status_detail: response.status_detail,
      transaction_amount: response.transaction_amount,
      currency_id: response.currency_id,
      external_reference: response.external_reference,
      payment_method_id: response.payment_method_id,
      payment_type_id: response.payment_type_id,
      date_created: response.date_created,
      date_approved: response.date_approved,
      date_last_updated: response.date_last_updated,
    };
  }
  async searchPaymentsByExternalReference(
    orderId: string,
  ): Promise<MercadoPagoPayment[]> {
    this.ensureEnabled();
    const response = await this.payments.search({
      options: { external_reference: orderId },
    });
    return (response.results ?? []) as MercadoPagoPayment[];
  }
  async refundPayment(
    paymentId: string,
    idempotencyKey: string,
  ): Promise<MercadoPagoRefund> {
    this.ensureEnabled();
    const response = await this.paymentRefunds.total({
      payment_id: paymentId,
      requestOptions: { idempotencyKey },
    });
    if (response.id == null)
      throw new Error("Mercado Pago returned an incomplete refund");
    return { id: String(response.id) };
  }
  async listRefunds(paymentId: string): Promise<MercadoPagoRefund[]> {
    this.ensureEnabled();
    const refunds = await this.paymentRefunds.list({
      payment_id: paymentId,
    });
    return refunds
      .filter((refund) => refund.id != null)
      .map((refund) => ({ id: String(refund.id) }));
  }
  validateWebhookSignature(input: {
    xSignature?: string | string[];
    xRequestId?: string | string[];
    dataId?: string | string[];
  }): void {
    if (!this.config.enabled || !this.config.webhookSecret)
      throw new Error("Mercado Pago webhook is not configured");
    const value = (inputValue: string | string[] | undefined) => {
      const raw = Array.isArray(inputValue) ? inputValue[0] : inputValue;
      return raw === undefined ? undefined : String(raw);
    };
    const rawSignature = value(input.xSignature);
    const rawRequestId = value(input.xRequestId);
    const rawDataId = value(input.dataId);
    const parsed = new Map<string, string>();
    for (const part of rawSignature?.split(",") ?? []) {
      const equalsAt = part.indexOf("=");
      if (equalsAt >= 0) parsed.set(part.slice(0, equalsAt).trim().toLowerCase(), part.slice(equalsAt + 1).trim());
    }
    const ts = parsed.get("ts") || null;
    const v1 = parsed.get("v1") || null;
    const dataId = rawDataId?.trim() || null;
    const requestId = rawRequestId?.trim() || null;
    const manifest = ts ? [dataId ? `id:${dataId}` : null, requestId ? `request-id:${requestId}` : null, `ts:${ts}`].filter(Boolean).join(";") + ";" : null;
    const diagnostics = {
      sdkVersion: MERCADO_PAGO_SDK_VERSION,
      tsReceived: ts,
      v1Present: Boolean(v1),
      v1Length: v1?.length ?? 0,
      xRequestId: requestId,
      dataId,
      canonicalManifest: manifest,
      xSignatureTrimmed: rawSignature !== (rawSignature?.trim() ?? undefined),
      xRequestIdTrimmed: rawRequestId !== (rawRequestId?.trim() ?? undefined),
      dataIdTrimmed: rawDataId !== (rawDataId?.trim() ?? undefined),
      webhookSecretConfigured: Boolean(this.config.webhookSecret),
      webhookSecretLength: this.config.webhookSecret.length,
      webhookSecretHasEdgeWhitespace: this.config.webhookSecret !== this.config.webhookSecret.trim(),
    };
    this.logger.log({ step: "webhook_signature_validation_input", ...diagnostics });
    try {
      WebhookSignatureValidator.validate({
        xSignature: input.xSignature,
        xRequestId: input.xRequestId,
        dataId: input.dataId,
        secret: this.config.webhookSecret,
        toleranceSeconds: 300,
      });
      this.logger.log({ step: "webhook_signature_validation_result", validationResult: "VALID", ...diagnostics });
    } catch (error) {
      this.logger.warn({
        step: "webhook_signature_validation_result",
        validationResult: "INVALID",
        failureReason: error instanceof InvalidWebhookSignatureError ? error.reason : (error instanceof Error ? error.name : "UNKNOWN_ERROR"),
        ...diagnostics,
      });
      throw error;
    }
  }
}
