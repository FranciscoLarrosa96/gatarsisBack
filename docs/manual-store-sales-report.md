# Venta manual de productos — reporte backend

Fecha: 23/10/2026. Alcance: sólo backend.

## Entrega

Se agregó `POST /api/v1/admin/orders/manual`, protegido por la autenticación ADMIN existente. El contrato completo, payload, respuesta y errores están en [manual-store-sales.md](manual-store-sales.md).

La operación crea una `Order` normal `MERCH / PAID / MANUAL`, sus `OrderItem` con snapshots/precios de DB, una entrega `PICKUP / PENDING` y una auditoría `STORE_MANUAL_SALE_CREATED`. Guarda método `CASH / TRANSFER / OTHER`, nota, comprador y fecha de pago. No fabrica un `Payment`, ID de MP ni preferencia.

El DTO exige confirmación `paymentReceived: true` e `idempotencyKey` en el body. Reintentar la misma venta devuelve la misma orden; cambiar el contenido o colisionar con otro flujo da `409 IDEMPOTENCY_CONFLICT`.

El stock se descuenta reutilizando `InventoryService.reserveStock()` y `commitSale()` dentro de la misma transacción. Los bloqueos siguen el orden de productos, variantes e inventario usado por checkout. Se respeta el stock reservado por otros pedidos; no quedan reservas internas pendientes de TTL. Un error revierte orden, artículos, entrega, stock, movimientos y auditoría.

Los endpoints existentes de órdenes devuelven método y nota manuales, comprador y snapshots. Así la venta forma parte del listado utilizado por Pedidos y por Pagos simples. El listado técnico de pagos del proveedor permanece sin filas artificiales.

## Archivos creados

- `src/admin/admin-manual-store-sales.controller.ts`: endpoint admin.
- `src/admin/admin-manual-store-sales.dto.ts`: validación y normalización.
- `src/admin/admin-manual-store-sales.service.ts`: transacción e idempotencia.
- `src/orders/manual-payment-method.ts`: enum compartido con rifas.
- `src/database/migrations/1767744000000-ManualStoreSales.ts`: persistencia y contactos opcionales.
- `test/manual-store-sales.e2e-spec.ts`: matriz PostgreSQL real.
- `docs/manual-store-sales.md`: contrato para el frontend.
- `docs/manual-store-sales-report.md`: este reporte.

## Archivos actualizados

- `src/admin/admin.module.ts`: registro del controller/servicio y dependencia de inventario.
- `src/admin/admin-orders-payments.controller.ts`: método y nota manuales en el detalle existente.
- `src/admin/admin-orders-payments.responses.ts`: método y nota en el listado de órdenes.
- `src/config/database.config.ts`: registro de la migración.
- `src/inventory/inventory.service.ts`: motivo opcional de venta; conserva el motivo de Mercado Pago por defecto.
- `src/orders/entities/order.entity.ts`: método/nota manuales.
- `src/orders/entities/order-fulfillment.entity.ts`: email/teléfono anulables.
- `src/raffles/entities/raffle-purchase.entity.ts`: enum compartido, conservando el export anterior.
- `README.md`: acceso al contrato y al reporte.

Frontend: ningún archivo modificado. No se ejecutaron tests ni build frontend por la indicación explícita de realizar sólo backend.

## Resultados de validación

| Verificación                                                                 | Resultado                                        |
| ---------------------------------------------------------------------------- | ------------------------------------------------ |
| Build backend (`npm.cmd run build`)                                          | Correcta                                         |
| Tipos incluyendo tests (`tsc --noEmit --incremental false -p tsconfig.json`) | Correctos                                        |
| Unit (`npm.cmd test -- --runInBand`)                                         | 47/47, 11 suites                                 |
| E2E nuevos de ventas manuales                                                | 29/29                                            |
| Regresión E2E completa, 25/25 archivos                                       | 332 aprobados, 5 fallos preexistentes, 337 total |

El comando global `npm.cmd run test:e2e` fue ejecutado, pero Node/Windows terminó antes de generar su resumen. Una corrida diagnóstica directa registró salida nativa `0xC0000409` (`-1073740791`). Para completar la regresión se ejecutaron todos los mismos archivos, sin omitir tests, en dos grupos independientes y bases locales separadas:

- 12 suites: 118 aprobados.
- 13 suites: 214 aprobados y 5 fallidos.

Se verificó que no faltara ningún archivo y que los fallos coincidieran exactamente con el baseline.

## Fallos preexistentes comprobados

Se extrajo una copia limpia del commit base `44a9d13071e9234188df17fe4b2ea826fe058df8`, sin cambiar el working tree, y se ejecutaron las dos suites afectadas en otra base PostgreSQL. Resultado: 46 aprobados y los mismos 5 fallos entre 51 tests.

- `payments-webhook-reconciliation.e2e-spec.ts`: tres casos esperan aplicación inmediata, diagnóstico con orden pagada y reparación inmediata de duplicados.
- `raffle-payments.e2e-spec.ts`: dos casos esperan procesamiento inmediato del inbox y settlement durante la carrera webhook/reconciliación.

El código base de `receiveWebhook()` actualmente devuelve el acuse después de encolar el evento; esos tests todavía esperan el pipeline completo antes de retornar. Esta diferencia requiere una decisión separada sobre el contrato del webhook. No se modificaron esos tests ni el código de webhooks.

**La regresión global no queda verde**, aunque la comparación no detectó nuevos fallos funcionales introducidos por esta entrega.

## Evidencia de atomicidad y stock

- Venta de 1 y 2 unidades: stock `5/0 → 4/0` y `4/0 → 2/0` (`stockOnHand/reservedStock`), dos artículos y total calculado de 2.000.000 centavos.
- Stock reservado por la web: `5/2 → 2/2` al vender las tres unidades disponibles; se conservan las dos reservadas.
- 20 solicitudes distintas por la última unidad: 1 venta, 19 `OUT_OF_STOCK`, un solo movimiento `SALE`.
- 20 solicitudes con la misma clave: 1 orden, 1 `SALE`, 1 `STORE_MANUAL_SALE_CREATED`, misma orden en todas las respuestas.
- Carrera venta manual/reserva web por la última unidad: exactamente un ganador y un conflicto de stock.
- Stock insuficiente en el último artículo: rollback de lo procesado en artículos anteriores.
- Trigger PostgreSQL que falla al guardar auditoría: stock `2/0 → 2/0`, sin orden, artículos, entrega, movimientos ni auditoría de venta persistidos. Trigger/function eliminados en `finally`.
- Gateway de Mercado Pago: cero llamadas en la venta válida; cero filas `Payment` / `PaymentPreference`.

Además se probaron auth admin, usuario inactivo, los tres métodos de pago, contactos opcionales, cantidades/duplicados, manipulación de precios/totales, variantes/productos no vendibles, reintentos, snapshots históricos, lecturas de Pedidos/Pagos simples y continuidad de entrega. La venta pagada no es expirada por el proceso de TTL.

## Migración, alcance y deuda

Se requiere `1767744000000-ManualStoreSales` antes de desplegar el código actualizado. Agrega columnas anulables de método/nota a `orders` y permite contactos nulos en `order_fulfillments`. El checkout web conserva sus requisitos originales de email y teléfono.

El `down` rechaza la reversión si aún existen contactos nulos: no inventa datos para restaurar las restricciones antiguas. El total continúa limitado por los enteros de centavos actuales de PostgreSQL; los importes fuera de rango se rechazan antes de consumir stock.

Se usaron bases temporales locales. No se ejecutaron ventas/pagos reales ni un deploy. La integración visual, los badges nuevos y el formulario quedan a cargo del frontend consumidor del contrato.
