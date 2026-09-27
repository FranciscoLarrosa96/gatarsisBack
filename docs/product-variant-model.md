# Variantes: modelo, color y talle

Las APIs admin de creación y edición aceptan `model`, `color` y `size`
opcionales (string de hasta 80 caracteres o null). Se recortan y normalizan
espacios; un campo vacío queda null. PATCH conserva los campos omitidos.
Las dimensiones se reflejan también en `attributes`; cuando se envían ambos
formatos, el campo explícito tiene prioridad. Un objeto attributes enviado
en PATCH reemplaza los atributos, como en el contrato anterior.

Las respuestas admin y públicas incluyen `model: string | null`.
Precio, SKU y stock continúan por variante; checkout utiliza variantId y
conserva el nombre de la variante como snapshot para la preferencia.

Ejemplo POST /api/v1/admin/products/:productId/variants:

```json
{
  "name": "Hilo rojo / M",
  "model": "Hilo rojo",
  "color": null,
  "size": "M",
  "sku": "REMERA-HILO-ROJO-M",
  "priceInCents": 1800000,
  "initialStock": 5
}
```

El generador y la sugerencia de SKU viven en frontend, no hay endpoint de
generación/bulk en este backend. Se conserva el POST individual existente.
El cliente envía combinaciones concretas con name y SKU incluyendo modelo.
El SKU se recorta, convierte a mayúsculas y conserva su constraint único.

La creación y edición bloquean Product antes de verificar combinaciones.
Las comparaciones ignoran mayúsculas/minúsculas. Las variantes con modelo
tienen además índice único PostgreSQL por producto/modelo/color/talle:
NULL de color o talle se compara como dimensión ausente. Esto incluye
variantes inactivas: se edita/reactiva la variante existente.
Para las variantes anteriores sin modelo se conserva la validación de
atributos activos y no se agrega un índice que pudiera bloquear el deploy
por duplicados históricos. No se eliminan datos antiguos.

La migración 1767657600000-VariantModel agrega una columna nullable y el índice.
Ejecutar db:migration:run antes de iniciar la nueva versión. synchronize
continúa desactivado. Productos anteriores conservan model=null.

Las imágenes siguen asociándose por ProductMedia.variantId. No se agrega
una asociación automática a todas las variantes de un modelo: el frontend
elige la media de la variante seleccionada o la galería general.

## Validación y entrega (2026-09-27)

- E2E de atributos/modelos: 15/15 pasan; cubren modelos solos, modelo+talle,
  color+talle, las tres dimensiones, null, espacios, edición, longitud máxima,
  SKU único, concurrencia, constraint SQL, media y stock exacto.
- Combinaciones enviadas desde el generador: 3, 6, 6 y 12 variantes, con
  repetición rechazada y sin insertar duplicados.
- Unitarios globales: 47/47 pasan (11 suites).
- E2E globales: 302/307 pasan (22/24 suites). Persisten los cinco fallos ya
  reportados de procesamiento inmediato en raffle-payments y
  payments-webhook-reconciliation. El webhook actual encola el inbox;
  esos tests esperan aplicar el pago durante el POST.
- Build backend: pasa.
- Frontend: fuera del alcance solicitado; sin archivos o pruebas modificados.

Archivos modificados:

- src/products/entities/product-variant.entity.ts
- src/products/products.controller.ts
- src/admin/admin-products.dto.ts
- src/admin/admin-products.service.ts
- src/config/database.config.ts
- src/database/migrations/1767657600000-VariantModel.ts (nuevo)
- test/variant-attributes.e2e-spec.ts
- docs/product-variant-model.md (nuevo)

No se ejecutó un deploy ni se aplicó la migración a producción.
