# Venta manual de productos — contrato backend

## Endpoint y autorización

`POST /api/v1/admin/orders/manual`, autenticado con el Bearer token ADMIN habitual.
Sólo registra dinero que ya fue recibido. No llama a Mercado Pago.

```json
{
  "customer": {
    "name": "María Piloni",
    "email": null,
    "phone": "+542491234567"
  },
  "paymentMethod": "TRANSFER",
  "paymentReceived": true,
  "items": [{ "variantId": "uuid-de-variante", "quantity": 2 }],
  "note": "Venta coordinada por WhatsApp",
  "idempotencyKey": "uuid-generado-para-esta-venta"
}
```

- `customer.name`: obligatorio, 2–120 caracteres después de quitar espacios.
- `email` y `phone`: opcionales y anulables; cadenas vacías se normalizan a `null`.
- `paymentMethod`: `CASH`, `TRANSFER` u `OTHER`, compartido con la venta manual de rifas.
- `paymentReceived`: debe ser el booleano `true`.
- `items`: 1–100 líneas, UUIDs distintos, cantidades enteras positivas. No admite precios, nombres, stock ni totales enviados por el cliente.
- `note`: opcional, máximo 500 caracteres.
- `idempotencyKey`: obligatorio en el **body**, 8–200 caracteres, igual que en la venta manual de rifas. Se genera una vez al confirmar la venta y se conserva al reintentar. No regenerar la clave después de un timeout sin comprobar el resultado.

## Respuesta 201

```json
{
  "orderId": "uuid",
  "kind": "MERCH",
  "status": "PAID",
  "paymentSource": "MANUAL",
  "paymentMethod": "TRANSFER",
  "note": "Venta coordinada por WhatsApp",
  "totalInCents": 1000000,
  "paidAt": "2026-10-23T15:00:00.000Z",
  "customer": {
    "name": "María Piloni",
    "email": null,
    "phone": "+542491234567"
  },
  "items": [
    {
      "id": "uuid-item",
      "variantId": "uuid-variante",
      "productNameSnapshot": "Llavero Gatarsis",
      "variantNameSnapshot": "Patita",
      "skuSnapshot": "LLAVERO-PATITA",
      "quantity": 2,
      "unitPriceInCents": 500000,
      "lineTotalInCents": 1000000
    }
  ],
  "fulfillment": {
    "id": "uuid-entrega",
    "method": "PICKUP",
    "status": "PENDING"
  }
}
```

Reenviar la misma operación y clave devuelve la misma orden, sin nuevas ventas, movimientos ni auditorías. Cambiar el contenido o usar una clave de otro flujo devuelve `409 IDEMPOTENCY_CONFLICT`.

## Persistencia y concurrencia

Se usa `Order` / `OrderItem` y `OrderFulfillment`; no hay tabla paralela de ventas manuales. El pago se representa mediante la orden `PAID`, origen `MANUAL`, método, nota y `paidAt`. No se fabrica ningún `Payment`, `PaymentPreference`, ID de MP ni referencia externa.

La transacción bloquea productos y variantes en el mismo orden que checkout y reutiliza `InventoryService.reserveStock()` y `commitSale()`. Cada línea crea `RESERVE` y `SALE` dentro de esa misma transacción; su efecto neto es restar la cantidad a `stockOnHand` y dejar `reservedStock` igual que antes. Se respeta `stockOnHand - reservedStock`: una reserva web existente no se consume con la venta manual. La reserva interna nunca queda pendiente de TTL.

Los snapshots y totales se calculan con nombres, SKU y precios leídos bajo bloqueo. El total debe caber en el entero de centavos existente (máximo 2.147.483.647). Cualquier error revierte orden, artículos, stock, entrega y auditoría.

Evento de auditoría: `STORE_MANUAL_SALE_CREATED`, asociado a la orden y al admin. Incluye cantidades, total y método; no duplica contactos ni la nota del comprador.

## Lecturas para Pedidos / Pagos simples

`GET /api/v1/admin/orders` y `GET /api/v1/admin/orders/:id` incluyen `paymentSource: MANUAL`, `manualPaymentMethod` y `manualSaleNote`, además de comprador, artículos y entrega. La pantalla simple de Pagos ya consume el listado de órdenes y por eso recibe estas ventas automáticamente. El listado técnico `GET /admin/payments` sigue representando pagos del proveedor: una venta manual no crea una fila artificial allí.

La entrega comienza `PICKUP / PENDING` y continúa por las transiciones admin existentes. No se marca completada automáticamente.

## Errores

- `400`: payload inválido, duplicados, pago no confirmado o campos calculados no permitidos.
- `400 INVALID_SALE_TOTAL`: importe fuera de rango o precio no válido.
- `401`: sesión admin ausente, inválida o usuario inactivo.
- `404 VARIANT_NOT_FOUND`: variante inexistente.
- `409 VARIANT_INACTIVE` / `PRODUCT_INACTIVE`: variante o producto no vendible.
- `409 OUT_OF_STOCK`: disponibilidad insuficiente, incluyendo stock reservado.
- `409 IDEMPOTENCY_CONFLICT`: clave reutilizada para una operación distinta.

## Despliegue y alcance

Ejecutar las migraciones antes de iniciar el backend actualizado: `npm.cmd run db:migration:run`.
`1767744000000-ManualStoreSales` agrega método/nota opcionales a `orders` y hace opcionales los contactos en `order_fulfillments`. El checkout web conserva su validación original, con email y teléfono obligatorios. Revertir esta migración requiere resolver primero las entregas con contactos nulos: el `down` no inventa datos de contacto.

Esta implementación modifica sólo backend. El formulario, la confirmación visual, los badges nuevos y el manejo de éxito/error corresponden al frontend consumidor de este contrato.

Pruebas: `test/manual-store-sales.e2e-spec.ts`, además de la regresión de checkout, inventario, pagos, entrega y ventas manuales de rifas.
