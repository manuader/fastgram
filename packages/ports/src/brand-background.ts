/**
 * Puerto BrandBackgroundGenerator — `PU-MEDIA-002`.
 *
 * Fondos de marca (imágenes y loops de video) generados **sin proveedor**: una
 * paleta y una semilla entran, un archivo sale. Existe para que una marca
 * recién creada, sin nada en el Media Bank, tenga con qué construir un
 * slideshow o un wall-of-text desde el primer minuto.
 *
 * ## Por qué un puerto aparte y no un método más de `MediaRenderer`
 *
 * `MediaRenderer` tiene una docena de implementaciones —el adaptador HTTP, el
 * de memoria y los dobles de los tests de `apps/worker`—, y un método nuevo
 * obligatorio las rompería todas por algo que ninguna de ellas usa. Acá la
 * implementación real es la misma clase (`HttpMediaRenderer`, contra
 * `services/render`), que implementa los dos puertos; quien sólo necesita
 * generar fondos pide éste, y nada más.
 *
 * ## Lo que NO hace
 *
 * No sube ni crea filas: igual que `MediaRenderer`, devuelve bytes y quien
 * llama los guarda con `Storage`. Tampoco elige la paleta: eso es negocio
 * (`packages/core/src/brand-kit`).
 *
 * Errores (`PortError`): los mismos que `MediaRenderer` —`bad_request` para una
 * paleta inválida, `provider_unavailable`/`timeout` reintentables,
 * `unauthorized`/`forbidden` si el servicio rechaza el grant,
 * `provider_contract_violation` si devuelve algo que no es lo pedido—.
 */
import type { MediaAuthorization, RenderedMedia } from "./media-renderer.js";

/** `4:5` = feed, `9:16` = story/reel. El video sólo existe en 9:16. */
export type BrandBackgroundAspect = "4:5" | "9:16";

export type BrandBackgroundRequest =
  | {
      readonly kind: "image";
      /** 2–5 colores `#RRGGBB`. */
      readonly palette: readonly string[];
      /** El mismo `(paleta, seed)` da los mismos bytes en el mismo motor. */
      readonly seed: string;
      readonly aspectRatio: BrandBackgroundAspect;
    }
  | {
      readonly kind: "video";
      readonly palette: readonly string[];
      readonly seed: string;
      /** Enteros de 6 a 10. Un loop que empalma el último cuadro con el primero. */
      readonly durationSeconds: number;
    };

export interface BrandBackgroundGenerator {
  /**
   * Un fondo. `auth` dice **quién** lo pide —no hay media que leer—: el
   * adaptador lo convierte en el grant firmado que el servicio exige.
   */
  generateBrandBackground(
    request: BrandBackgroundRequest,
    auth: MediaAuthorization,
  ): Promise<RenderedMedia>;
}
