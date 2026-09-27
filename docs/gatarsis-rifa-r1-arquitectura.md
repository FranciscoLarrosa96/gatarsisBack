# Gatarsis — Rifas Solidarias R1

Estado: análisis de arquitectura. Este documento no implementa entities, migrations, endpoints ni cambios de comportamiento.

## Decisión recomendada

Se recomienda una variante acotada de extender Order:

    Order (sobre financiero, kind = MERCH | RAFFLE)
      ├─ MERCH  -> OrderItem -> Inventory / InventoryMovement
      └─ RAFFLE -> RafflePurchase -> RaffleNumber

RafflePurchase no reemplaza Order: contiene el dominio específico y los datos del comprador. Order conserva el identificador pagable y el external_reference de Mercado Pago. Payment, PaymentPreference, WebhookEvent y RefundOperation siguen referenciando Order.id.

No crear RaffleWebhook, RafflePayment ni RafflePreference.

## 1. Mapa del sistema actual

| Área | Código actual | Impacto |
| --- | --- | --- |
| Reserva de merch | src/checkout/checkout.service.ts:31 y :76 | Patrón reutilizable de transacción, TTL, snapshots e idempotencia. No modificarlo. |
| Stock | src/inventory/inventory.service.ts:13 | Sólo merch usa Inventory; rifa no crea variants ficticias ni InventoryMovement. |
| Order | src/orders/entities/order.entity.ts:19 | Ya es FK de Payment y Preference; agregar kind con default MERCH. |
| Expiración | src/orders/orders.service.ts:37 | Debe despachar liberación por kind. |
| Preference | src/payments/payments.service.ts:64 | Conserva single-flight y recovery; requiere un item de rifa cuando kind=RAFFLE. |
| Webhook e inbox | src/payments/payments.service.ts:415 | Se reutilizan íntegros, incluyendo HMAC, dedupe y retry. |
| Settlement | src/payments/payments.service.ts:668 | Ya bloquea Order; aquí vive el único branch MERCH/RAFFLE. |
| Reconciliación | src/payments/payments.service.ts:855 y :929 | Mantiene external_reference=Order.id; cambia sólo la liberación/settlement de Raffle. |
| Fulfillment | src/orders/entities/order-fulfillment.entity.ts:17 | Es pickup; una rifa no crea fulfillment. |
| Refund | src/admin/admin-refunds.service.ts:39 | Reutilizable para refund financiero, sin liberar número automáticamente. |
| Admin/Audit | src/admin/admin.module.ts y AdminAuditLog | Reutilizar guard y auditoría. |
| Media | src/products/entities/product-media.entity.ts:12 | No reutilizable: product_id obligatorio y FK a Product. |

Hechos que condicionan la decisión:

- Payment.orderId y PaymentPreference.orderId no son polimórficos.
- Payment(provider, providerPaymentId) y WebhookEvent(provider, providerEventId) son únicos.
- recordAndApply bloquea Order con pessimistic_write antes de mutar estado.
- Inventory tiene checks PostgreSQL que deben permanecer exclusivos de stock físico.

## 2. Alternativas

| Opción | Ventajas | Riesgo / costo | Decisión |
| --- | --- | --- | --- |
| A. Sólo extender Order | Reusa Payment, Preference, webhook y external_reference. | Meter números en OrderItem volvería nullable variant_id y contaminaría Inventory/Fulfillment. | No usar sola. |
| B. RafflePurchase independiente con Payment polimórfico | Dominio de rifa aislado. | Reescribe FKs, refund, reconciliaciones, admin y validaciones. Riesgo alto de regresión. | Rechazada. |
| C. Order financiero + RafflePurchase companion | Reusa pipeline probado y mantiene PII/números fuera de merch. El branch es explícito y pequeño. | Hay que cubrir preference, settlement y expiración por kind. | Recomendada. |

## 3. Modelo de datos propuesto

### Cambio backward-compatible de orders

    CREATE TYPE order_kind_enum AS ENUM ('MERCH', 'RAFFLE');
    ALTER TABLE orders ADD kind order_kind_enum NOT NULL DEFAULT 'MERCH';
    CREATE INDEX idx_orders_kind_status_expiration
      ON orders (kind, status, reservation_expires_at);

Las órdenes existentes quedan MERCH. No cambiar Payment, PaymentPreference, WebhookEvent, RefundOperation, OrderItem ni Inventory.

### raffles

    id UUID PK
    title varchar NOT NULL
    prize_name varchar NOT NULL
    description text NULL
    image_url text NULL
    price_in_cents integer NOT NULL CHECK (> 0)
    status DRAFT | ACTIVE | PAUSED | CLOSED | DRAWN
    draw_at timestamptz NULL
    winning_number smallint NULL CHECK (0..99)
    drawn_at timestamptz NULL
    drawn_by_admin_id uuid NULL FK admin_users RESTRICT
    created_at / updated_at

Índices: status + created_at DESC y, opcionalmente, draw_at. Para R1 usar image_url única validada; ProductMedia no sirve porque requiere product_id. Una galería futura merece raffle_media propia.

### raffle_purchases

    id UUID PK
    raffle_id UUID NOT NULL FK raffles RESTRICT
    order_id UUID NOT NULL UNIQUE FK orders RESTRICT
    buyer_name varchar NOT NULL
    buyer_email varchar NOT NULL     -- trim + lowercase
    buyer_phone varchar NOT NULL     -- trim
    unit_price_in_cents integer NOT NULL CHECK (> 0)
    created_at / updated_at

No agregar status duplicado: el estado se deriva de Order y Payment:
RESERVED, PAYMENT_PENDING, PAID, EXPIRED, REFUNDED o REQUIRES_REVIEW. Así no pueden divergir dos state machines. Índices: raffle_id + created_at DESC y buyer_email + created_at DESC.

### raffle_numbers

    id UUID PK
    raffle_id UUID NOT NULL FK raffles RESTRICT
    number smallint NOT NULL CHECK (number BETWEEN 0 AND 99)
    status AVAILABLE | RESERVED | SOLD
    raffle_purchase_id UUID NULL FK raffle_purchases RESTRICT
    reserved_until timestamptz NULL
    reserved_at timestamptz NULL
    sold_at timestamptz NULL
    created_at / updated_at
    UNIQUE (raffle_id, number)

Índices: raffle_id + status + number, raffle_purchase_id, y un índice parcial:

    CREATE INDEX idx_raffle_numbers_reserved_expiry
      ON raffle_numbers (reserved_until)
      WHERE status = 'RESERVED';

Crear la rifa inserta exactamente 100 rows 0..99 en la misma transacción. 00..99 es formato de UI; la DB guarda enteros.

## 4. State machines

### Raffle

    DRAFT --publish--> ACTIVE --pause--> PAUSED --resume--> ACTIVE
    ACTIVE/PAUSED --close--> CLOSED --draw--> DRAWN

- Sólo DRAFT admite cambios materiales, especialmente precio.
- ACTIVE permite reservas. PAUSED y CLOSED no.
- CLOSED conserva reservas existentes para que paguen o expiren; no admite nuevas.
- DRAWN requiere CLOSED, cero RESERVED y ganador SOLD. Es terminal.

### RaffleNumber

    AVAILABLE --reserve--> RESERVED --approved--> SOLD
    RESERVED --expire/reject/cancel--> AVAILABLE
    SOLD --refund--> SOLD

SOLD es terminal automático. Una futura desasignación debe ser una acción administrativa explícita, auditada y prohibida luego de DRAWN.

### RafflePurchase (estado derivado)

    Order AWAITING_PAYMENT -> RESERVED
    Order PAYMENT_PENDING  -> PAYMENT_PENDING
    Order PAID             -> PAID
    Order EXPIRED          -> EXPIRED
    Payment REQUIRES_REVIEW -> REQUIRES_REVIEW
    Order REFUNDED         -> REFUNDED

## 5. Flujo end-to-end

### Reserva de 07, 23 y 65

1. POST /raffles/:raffleId/reservations recibe números, buyer e Idempotency-Key.
2. Normaliza, deduplica y ordena números; calcula fingerprint con números y buyer normalizado.
3. Una transacción toma advisory lock por raffle:<buyerEmail>, bloquea Raffle y luego raffle_numbers por number ASC FOR UPDATE.
4. Si uno no está AVAILABLE, rollback completo con RAFFLE_NUMBER_UNAVAILABLE y details.numbers. No hay compra parcial.
5. Crea Order(kind=RAFFLE), RafflePurchase y marca números RESERVED con el mismo TTL.
6. Devuelve rafflePurchaseId, orderId, total y expiración.
7. La Preference delega a PaymentsService. Para RAFFLE construye un item desde título/premio, números y precio snapshot; external_reference sigue siendo Order.id.

### Pago aprobado

1. Webhook o reconciliación llama al recordAndApply existente.
2. Éste bloquea Order y valida referencia, ARS e importe como hoy.
3. MERCH ejecuta commitSale sin cambios.
4. RAFFLE bloquea RafflePurchase y sus números por number ASC, verifica RESERVED y ownership, los marca SOLD, y persiste Order PAID + Payment APPLIED en la misma transacción.
5. Payment ya APPLIED es no-op: no hay segundo settlement.

### Expiración, rechazo y cancelación

La rama RAFFLE bloquea Order, Purchase y números; hace RESERVED -> AVAILABLE, limpia compra y reserved_until, y marca Order EXPIRED. No toca Inventory.

### Late approved

Si ya se liberó, Order está EXPIRED. El guard actual de recordAndApply ya asigna LATE_APPROVED_AFTER_RELEASE a REQUIRES_REVIEW antes de settlement. Rifa conserva exactamente esa política: no marca SOLD ni quita un número a otro comprador.

## 6. Integración Mercado Pago y refunds

- Payment sigue usando order_id; no se vuelve polimórfico.
- PaymentPreference conserva un registro por Order, single-flight y recovery.
- WebhookEvent, firma HMAC, dedupe, retry y dead letter no cambian.
- external_reference debe ser Order.id, nunca raffleId ni rafflePurchaseId.
- Early/final reconciliation conserva la búsqueda por Order.id.
- RefundOperation existente puede marcar una Order de rifa REFUNDED tras refund confirmado.
- Refund financiero no implica liberar número: debe permanecer SOLD por trazabilidad y porque el sorteo podría haber ocurrido.
- Una futura corrección manual requiere motivo, auditoría, confirmación explícita y prohibición posterior a DRAWN.

## 7. Concurrencia, TTL y abuso

La garantía de que 37 no se vende dos veces es PostgreSQL:

    SELECT ... FROM raffle_numbers
    WHERE raffle_id = $1 AND number IN (...)
    ORDER BY number ASC
    FOR UPDATE;

Tras adquirir locks se verifica AVAILABLE. Una transacción reserva; la segunda espera y devuelve 409 al observar RESERVED o SOLD. El orden numérico evita deadlocks en selecciones solapadas.

Valores iniciales propuestos:

| Límite | Valor | Motivo |
| --- | ---: | --- |
| RAFFLE_RESERVATION_MINUTES | 10 | TTL independiente y menor capacidad de acaparamiento. |
| Reservas activas por email | 2 | Mitiga acaparamiento; se serializa con advisory lock. |
| Rate limit | 20/minuto/origen | Más estricto que merch, sin Redis. |

No existe un máximo fijo de números por compra. El máximo efectivo es la cantidad de números solicitados que sigan `AVAILABLE` dentro de la transacción.

## 8. API propuesta

### Pública

    GET  /raffles/active
    GET  /raffles/:id
    GET  /raffles/:id/numbers
    POST /raffles/:id/reservations
    POST /raffle-purchases/:id/mercado-pago/preference
    GET  /raffle-purchases/:id/status

La grilla pública sólo expone número y estado, nunca buyer. La preference resuelve orderId internamente y conserva la respuesta actual: orderId, preferenceId, initPoint y expiración.

### Admin

    GET   /admin/raffles
    POST  /admin/raffles
    GET   /admin/raffles/:id
    PATCH /admin/raffles/:id
    POST  /admin/raffles/:id/publish
    POST  /admin/raffles/:id/pause
    POST  /admin/raffles/:id/resume
    POST  /admin/raffles/:id/close
    POST  /admin/raffles/:id/draw
    GET   /admin/raffles/:id/numbers
    GET   /admin/raffles/:id/purchases

El dashboard cuenta AVAILABLE/RESERVED/SOLD y recauda sólo Orders PAID.

## 9. Errores de dominio

| Código | HTTP | Uso |
| --- | ---: | --- |
| RAFFLE_NOT_FOUND | 404 | Rifa inexistente. |
| RAFFLE_NOT_ACTIVE | 409 | No se puede reservar en DRAFT/PAUSED/CLOSED/DRAWN. |
| RAFFLE_NUMBER_INVALID | 400 | Fuera de 0..99, formato inválido o repetido. |
| RAFFLE_NUMBER_UNAVAILABLE | 409 | Devuelve details.numbers sin reserva parcial. |
| RAFFLE_PURCHASE_NOT_FOUND | 404 | Compra inexistente. |
| RAFFLE_PURCHASE_EXPIRED | 409 | Preference posterior al TTL. |
| RAFFLE_CLOSE_NOT_ALLOWED | 409 | Transición inválida. |
| RAFFLE_DRAW_NOT_ALLOWED | 409 | No CLOSED o hay reservas. |
| RAFFLE_WINNING_NUMBER_NOT_SOLD | 409 | Ganador no SOLD. |
| RAFFLE_ALREADY_DRAWN | 409 | Sorteo terminal. |

Reutilizar IDEMPOTENCY_KEY_REQUIRED e IDEMPOTENCY_CONFLICT.

## 10. Locks, auditoría y observabilidad

| Operación | Orden de locks |
| --- | --- |
| Reserva | advisory email -> Raffle FOR UPDATE -> números ASC -> Order/Purchase. |
| Liberación | Order FOR UPDATE -> Purchase -> números ASC. |
| Pago | Order FOR UPDATE -> Payment -> Purchase/números ASC. |
| Late approved | Order EXPIRED bloqueada; sólo Payment review. |
| Close | Raffle FOR UPDATE. |
| Draw | Raffle FOR UPDATE -> winning number FOR UPDATE. |
| Refund | RefundOperation/Payment/Order existentes; no números. |

Reutilizar AdminAuditLog con RAFFLE_CREATED, RAFFLE_UPDATED, RAFFLE_ACTIVATED, RAFFLE_PAUSED, RAFFLE_CLOSED, RAFFLE_DRAWN, RAFFLE_NUMBERS_RESERVED, RAFFLE_NUMBERS_RELEASED y RAFFLE_NUMBERS_SOLD. Guardar IDs, conteo y números; no PII completa.

Logs mínimos: step, raffleId, rafflePurchaseId, orderId, providerPaymentId, numberCount, numbers cuando sean pocos y processingResult. No nombre, email ni teléfono.

## 11. Plan de migrations

1. Crear enum/columna orders.kind DEFAULT MERCH e índice de lifecycle.
2. Crear enums y tablas raffles, raffle_purchases y raffle_numbers con checks, FKs, unique e índices detallados.
3. Registrar entities/migration en database.config y database/data-source.
4. No modificar FKs de Payment, Preference, RefundOperation, OrderItem, Inventory o Fulfillment.

## 12. Fases posteriores

| Fase | Alcance | Gate |
| --- | --- | --- |
| R2 | Entities, migration, Admin DRAFT y generación atómica 00..99. | 100 rows, checks y migration backward compatible. |
| R3 | Reserva pública, TTL, límites e idempotencia. | All-or-nothing y 20 concurrentes sobre 37. |
| R4 | Order.kind, Preference, settlement y release mediante pipeline actual. | Webhook/reconcile/late-approved sin regresión MERCH. |
| R5 | Admin lifecycle, dashboard, compradores, audit y draw manual. | Guard y transiciones. |
| R6 | API pública, DTOs y status polling. | Contrato, PII y rate limit. |
| R7 | E2E PostgreSQL de concurrencia/refund/review y regresión global. | Suite completa + build. |

## 13. Matriz obligatoria de pruebas

- Crear rifa: exactamente 100 números únicos 0..99.
- Reserva de uno, varios e Idempotency-Key repetida.
- 07,23,65 con 23 no disponible: rollback total y details.numbers.
- 20 requests concurrentes sobre 37: un RESERVED, 19 conflictos.
- Overlap de números sin deadlock.
- Expiración/rechazo/cancelación: una liberación.
- Approved: sólo los números de la compra pasan SOLD.
- Webhook duplicado y webhook + reconciliation: un settlement.
- Late approved tras liberar/revender: review, nunca doble asignación.
- Refund: Order REFUNDED y número SOLD.
- PAUSED/CLOSED sin reservas nuevas; DRAWN sólo sin RESERVED y con winner SOLD.
- Guard Admin, audit y ausencia de PII en logs/respuestas públicas.
- Regresión completa de Checkout, Inventory, Payments, Refunds y Fulfillment actuales.

## Respuestas explícitas

1. Reutilizar Order como sobre financiero RAFFLE y crear RafflePurchase companion; no usar Purchase aislada.
2. Reutilizar Payment manteniendo order_id y external_reference=Order.id; el settlement despacha por kind.
3. Garantizar el 37 con FOR UPDATE PostgreSQL, orden ascendente y UNIQUE(raffle_id, number).
4. Si uno de cinco falla, rollback total y 409 RAFFLE_NUMBER_UNAVAILABLE.
5. Si vence mientras paga, liberar números y marcar Order EXPIRED.
6. Approved tardío: REQUIRES_REVIEW, sin SOLD ni auto-refund.
7. Refund: el número sigue SOLD; corrección futura sólo manual/auditada.
8. CLOSED detiene nuevas reservas y honra las existentes hasta pago/expiración; DRAWN exige cero RESERVED.
9. Ganador: winning_number, drawn_at, drawn_by_admin_id; sólo CLOSED y SOLD, DRAWN terminal.
10. No tocar invariantes Inventory, checkout MERCH, HMAC/inbox webhook, idempotencia, reconciliation, fulfillment MERCH ni refund core.
11. Hacen falta orders.kind y tablas/enums/índices de rifa; Payment/Preference no cambian de FK.
12. Mayor riesgo: omitir la rama RAFFLE en preference, settlement o expiración. Late approved tras liberar es el caso crítico; se mitiga con el guard EXPIRED existente y E2E concurrente.

