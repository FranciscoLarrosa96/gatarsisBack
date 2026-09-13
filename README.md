# Gatarsis Commerce Backend

NestJS + PostgreSQL + TypeORM para catálogo, stock, reservas, órdenes y Checkout Pro de Mercado Pago. PostgreSQL decide cómo un pago confirmado afecta la orden e inventario; el backend nunca confía en redirects del navegador.

## Desarrollo local

1. Copiá `.env.example` a `.env` y definí las credenciales locales.
2. Iniciá PostgreSQL: `docker compose up -d`.
3. Instalá dependencias: `npm install`.
4. Aplicá el schema: `npm run db:migration:run`.
5. Opcionalmente cargá sólo datos de prueba: `npm run db:seed`.
6. Ejecutá: `npm run start:dev`.

La API está bajo `/api/v1`: catálogo, reserva, preference de Mercado Pago, estado de orden, webhook y health.

## Configuración productiva

En producción definí explícitamente `NODE_ENV=production`. PostgreSQL admite `DATABASE_SSL=true`; la conexión conserva `rejectUnauthorized=true` y puede recibir la CA del proveedor mediante `DATABASE_SSL_CA` (acepta saltos de línea escapados como `\n`). El pool y los timeouts se controlan con `DATABASE_POOL_MAX`, `DATABASE_CONNECTION_TIMEOUT_MS`, `DATABASE_STATEMENT_TIMEOUT_MS` y `DATABASE_QUERY_TIMEOUT_MS`.

La URL pública vigente del servicio es `https://gatarsisback.onrender.com` y la base de la API es `https://gatarsisback.onrender.com/api/v1`. Los clientes e integraciones externas deben utilizar este hostname.

El proceso web no ejecuta seeds ni migrations al iniciar (`synchronize=false` y migrations automáticas deshabilitadas). Aplicá cada migration como un paso controlado del deploy con `npm run db:migration:run`; `npm run db:seed` es sólo para datos locales/de prueba.

## Stock y reserva

`POST /checkout/reserve` exige `Idempotency-Key` y recibe `{ "items": [{ "variantId": "uuid", "quantity": 1 }] }`. Precios y snapshots se resuelven desde PostgreSQL. La misma clave con el mismo carrito devuelve la orden original; con otro carrito responde `409 IDEMPOTENCY_CONFLICT`.

El inventario conserva `stockOnHand` y `reservedStock`; `availableStock = stockOnHand - reservedStock` se deriva. La reserva usa un `UPDATE ... WHERE stock_on_hand - reserved_stock >= quantity` atómico dentro de una transacción.

El checkout limita a 10 líneas, 5 unidades por línea y 15 unidades totales. Además, permite como máximo 3 reservas activas por email normalizado; el conteo se serializa con un advisory lock transaccional de PostgreSQL. Se eligió email en lugar de IP para no bloquear familias o redes NAT completas. `POST /checkout/reserve` tiene throttling de 60 requests por minuto por origen.

## Mercado Pago

Configurá sin commitear secretos: `MP_ENABLED=true`, `MP_ACCESS_TOKEN`, `MP_WEBHOOK_SECRET` y `FRONTEND_URL=https://gatarsis.com.ar`. `FRONTEND_URL` se normaliza aunque termine en `/` y se usa exclusivamente para las `back_urls` del comprador. También están disponibles `MP_EXCLUDE_TICKET`, `MP_BINARY_MODE`, `MP_RECONCILIATION_GRACE_SECONDS`, `MP_PENDING_REVIEW_HOURS`, `MP_PREFERENCE_CREATING_STALE_SECONDS` y `MP_PREFERENCE_RECOVERY_CONFIRM_SECONDS`.

Después de reservar, solicitá `POST /checkout/:orderId/mercado-pago/preference`. La preference se genera desde los snapshots de `OrderItem`, usa `external_reference=orderId` y vence junto con la reserva. La respuesta devuelve `preferenceId`, `initPoint` y vencimiento, nunca el Access Token.

Configurá en Mercado Pago un webhook HTTPS para **Payments** hacia `https://gatarsisback.onrender.com/api/v1/webhooks/mercado-pago`, y guardá su secret. Se validan `x-signature`, `x-request-id` y `data.id`; el evento entra en un inbox durable deduplicado y se consulta el Payment real antes de cambiar stock.

Un Payment `approved` válido (referencia, ARS e importe exacto) hace una sola venta transaccional: descuenta reservado y stock, registra `SALE`, marca la Order `PAID` y el Payment `APPLIED`. Estados pending conservan la reserva. Los pagos tardíos, duplicados o inconsistentes quedan en `REQUIRES_REVIEW`; no existe auto-refund ni auto-restock.

**Un redirect a `/checkout/success` NO confirma una compra.**

Con Mercado Pago deshabilitado, las reservas expiran de forma directa e idempotente. Con Mercado Pago habilitado, el scheduler reconcilia con el proveedor antes de liberar; ante una caída conserva la reserva para reintentar.

Una orden vencida en `PAYMENT_PENDING` continúa reconciliándose durante `MP_PENDING_REVIEW_HOURS`, contadas desde el vencimiento de la reserva. Si Mercado Pago sigue confirmando un estado pending al finalizar esa ventana, el Payment pasa a revisión y la reserva se libera transaccionalmente. Un error de red nunca se interpreta como ausencia de pago.

La creación de Preference usa `CREATING` como single-flight. Un intento stale o ambiguo pasa a `REQUIRES_REVIEW` y se busca por `external_reference`; sólo después de dos búsquedas vacías separadas por `MP_PREFERENCE_RECOVERY_CONFIRM_SECONDS` queda `FAILED` y se habilita un nuevo POST al proveedor.

Checklist sandbox: crear/seleccionar aplicación, usar Access Token de prueba, configurar webhook HTTPS de Payments y secret, definir `FRONTEND_URL=https://gatarsis.com.ar` y hacer una compra con credenciales/tarjetas de prueba. La URL del webhook continúa siendo la del backend; `FRONTEND_URL` no se utiliza como `notification_url`.

## Tests

Los E2E usan PostgreSQL real y una base aislada `gatarsis_test`. Las migrations están registradas en el DataSource y se aplican al inicializar la suite. Ejecutá `npm run test:e2e`; cubre concurrencia 20×, rollback multi-item, idempotencia y expiración idempotente.

## Administración y autenticación

No existe registro público de administradores. Para crear el primero, configurá en el entorno seguro (no en el repositorio):

```env
ADMIN_JWT_ACCESS_SECRET=<secreto-largo-y-aleatorio>
ADMIN_BOOTSTRAP_ENABLED=true
ADMIN_BOOTSTRAP_EMAIL=admin@tu-dominio.com
ADMIN_BOOTSTRAP_PASSWORD=<al-menos-14-caracteres>
```

Ejecutá una sola vez `npm run admin:bootstrap`. El comando aplica migrations, falla si no está habilitado o ya existe un administrador, y sólo guarda el hash bcrypt de la contraseña. Luego cambiá `ADMIN_BOOTSTRAP_ENABLED=false` y remové `ADMIN_BOOTSTRAP_PASSWORD` del entorno.

- `POST /api/v1/admin/auth/login` recibe `{ "email", "password" }` y devuelve access JWT y refresh token opaco.
- `POST /api/v1/admin/auth/refresh` recibe `{ "refreshToken" }`, rota el refresh e invalida el anterior.
- `POST /api/v1/admin/auth/logout` usa `Authorization: Bearer <accessToken>` y revoca la sesión server-side.
- `GET /api/v1/admin/auth/me` usa el mismo header y devuelve el administrador activo.

Todas las rutas bajo `/api/v1/admin/**` quedan protegidas por defecto, salvo login y refresh. El guard verifica JWT, `AdminUser.active` y que la sesión exista, no esté revocada y no haya expirado. Login admite 5 intentos por IP/minuto y refresh 20 por IP/minuto. Helmet está activo y CORS se limita a `CORS_ORIGINS`; los webhooks de Mercado Pago no dependen de CORS.

## Dashboard y auditoría administrativa

- `GET /api/v1/admin/dashboard` devuelve agregados de productos, inventario, órdenes y pagos en revisión. `paidToday` usa el día UTC de `paidAt`; mientras no exista `expiredAt`, `expiredToday` usa el día UTC de `updatedAt` para órdenes `EXPIRED`.
- `GET /api/v1/admin/audit` es un read model paginado y filtrable por `action`, `adminUserId`, `entityType`, `entityId`, `dateFrom` y `dateTo`. Acepta `page`, `pageSize` (máximo 100) y `sort=createdAt:asc|createdAt:desc`; un rango invertido devuelve `400 INVALID_DATE_RANGE`.

Ambos endpoints son exclusivamente de lectura y no exponen hashes, sesiones ni datos de autenticación.

## Fuera de esta fase

Panel/admin y auth, cuentas de comprador, carrito persistido, envío, descuentos, Redis, WebSockets y colas. La resolución operativa de `REQUIRES_REVIEW` y refunds queda para Fase 3.
