# Eliminación segura de rifas (backend)

`DELETE /api/v1/admin/raffles/:raffleId` elimina únicamente rifas sin evidencia
de actividad real. La operación está protegida por autenticación admin, bloquea
la rifa y sus órdenes con locks pesimistas y se ejecuta en una transacción.

La eliminación se rechaza con `409 RAFFLE_DELETE_NOT_ALLOWED` cuando existe
alguna de estas condiciones:

- números vendidos;
- reservas todavía vigentes;
- órdenes pagadas, reembolsadas o con pago pendiente;
- órdenes `AWAITING_PAYMENT` que todavía no vencieron;
- cualquier registro `Payment` o `RefundOperation`;
- una preference activa, en revisión o con ID asignado por el proveedor;
- fulfillment, items o movimientos asociados a la orden;
- una rifa sorteada o con datos de ganador.

Se pueden limpiar reservas vencidas/canceladas sin pagos. En ese caso se
eliminan, en orden compatible con las foreign keys, las preferences fallidas o
vencidas sin ID externo, los números, las compras de rifa, las órdenes y la
rifa. Los logs administrativos históricos se conservan y se agrega
`RAFFLE_DELETED` con los conteos eliminados.

No se modifican constraints `ON DELETE` ni se eliminan Payments, refunds o
webhooks. Como `webhook_events` no tiene una relación explícita con una orden,
la presencia de un Payment o de una preference externa se usa como barrera de
seguridad para no borrar operaciones que puedan necesitar reconciliación.
