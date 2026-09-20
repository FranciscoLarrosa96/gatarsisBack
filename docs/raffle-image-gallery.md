# Galería de imágenes de rifas (backend)

Las imágenes externas del premio se almacenan en `raffles.image_urls` como un
array JSONB ordenado, con un máximo de ocho URLs HTTPS. La posición cero es la
portada. El backend no sube ni transforma archivos; acepta URLs de entrega de
Cloudinary y otros hosts HTTPS.

La migración convierte cada `image_url` anterior no nulo en `[image_url]` y
elimina la columna antigua. Una rifa que no tenía imagen queda con `[]`.

Durante la transición, crear y editar todavía acepta el campo singular
`imageUrl`. Las respuestas admin y públicas incluyen el nuevo `imageUrls` y
también `imageUrl`, calculado como `imageUrls[0] ?? null`, para no romper
clientes desplegados anteriormente. `imageUrl` queda deprecado y no existe
como columna de base de datos.
