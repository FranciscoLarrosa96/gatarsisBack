import { Controller, Get, NotFoundException, Param } from "@nestjs/common";
import { ProductsService } from "./products.service";
@Controller("products")
export class ProductsController {
  constructor(private readonly products: ProductsService) {}
  @Get() async findAll() {
    return (await this.products.findAll()).map((product) =>
      this.serialize(product),
    );
  }
  @Get(":slug") async findOne(@Param("slug") slug: string) {
    const product = await this.products.findBySlug(slug);
    if (!product)
      throw new NotFoundException({
        code: "PRODUCT_NOT_FOUND",
        message: "El producto no existe.",
      });
    return this.serialize(product);
  }
  private serialize(
    product: Awaited<ReturnType<ProductsService["findAll"]>>[number],
  ) {
    return {
      id: product.id,
      slug: product.slug,
      name: product.name,
      ...(product.shortDescription
        ? { shortDescription: product.shortDescription }
        : {}),
      media: (product.media ?? [])
        .filter((media) => media.variantId === null)
        .sort((a, b) => a.sortOrder - b.sortOrder)
        .map((media) => ({
          id: media.id,
          url: media.url,
          alt: media.alt,
          sortOrder: media.sortOrder,
          isCover: media.isCover,
        })),
      variants: product.variants.map((variant) => ({
        id: variant.id,
        sku: variant.sku,
        name: variant.name,
        model: variant.model ?? null,
        color: variant.color,
        size: variant.size,
        attributes: variant.attributes ?? {},
        priceInCents: variant.priceInCents,
        active: variant.active,
        media: (product.media ?? [])
          .filter((media) => media.variantId === variant.id)
          .sort((a, b) => a.sortOrder - b.sortOrder)
          .map((media) => ({
            id: media.id,
            url: media.url,
            alt: media.alt,
            sortOrder: media.sortOrder,
            isCover: media.isCover,
          })),
        availableStock: Math.max(
          0,
          (variant.inventory?.stockOnHand ?? 0) -
            (variant.inventory?.reservedStock ?? 0),
        ),
      })),
    };
  }
}
