# Ventas manuales de rifas (backend)

El endpoint administrativo `POST /api/v1/admin/raffles/:raffleId/manual-sales`
registra ventas externas como una `Order` real de tipo `RAFFLE`, estado `PAID`
y origen de pago `MANUAL`. La operación crea su `RafflePurchase`, marca todos
los números solicitados como `SOLD` y registra el audit
`manual_raffle_sale_created` dentro de una única transacción.

No se crea `Payment`, `PaymentPreference` ni un identificador ficticio de
Mercado Pago. Los medios admitidos son `CASH`, `TRANSFER` y `OTHER`.

La anulación de una venta manual queda fuera de esta primera versión. Debe
implementarse luego como una acción explícita, conservando orden y compra,
registrando auditoría y liberando números solamente si el estado de la rifa lo
permite. No debe reutilizar el flujo de refunds de Mercado Pago.
