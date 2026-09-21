/**
 * Contrato del puerto `MediaRenderer` — IMPL ADR-007 e IMPL §5, PRD `FR-070`,
 * `NFR-014`.
 *
 * El caso que más plata vale es el de `fingerprint`. IMPL §5 pone el CPU de
 * render como driver de costo #2 y prescribe cachear por hash del payload: «si
 * sólo cambió el texto, no re-encodear el video de fondo». Un `fingerprint`
 * que no fuera estable haría que el cache nunca acierte —costo silencioso— y
 * uno que colisionara serviría el render equivocado —bug silencioso—. Las dos
 * fallas son invisibles hasta que alguien mira la factura o una pieza ajena.
 *
 * Después está la validación del payload normativo de `FR-070`. `num_images`
 * que no coincide con `images.length` es el error que el contrato público
 * menciona explícitamente; si el renderer lo deja pasar, produce un slideshow
 * corto sin avisar.
 */

import type { MediaRenderer, RenderJob, SlideshowJob } from "../media-renderer.js";
import { MAX_SLIDES } from "../media-renderer.js";
import {
  check,
  checkEqual,
  checkNonEmpty,
  checkRejectsWithCode,
  type AdapterFactory,
  type ContractHarness,
} from "./harness.js";

export interface MediaRendererContractSetup {
  readonly makeAdapter: AdapterFactory<MediaRenderer>;
  /**
   * Un job válido por formato que el adaptador soporte, con URLs de media
   * alcanzables. Es lo que hace que esta suite valga: sin media real, un
   * renderer no se puede verificar.
   */
  readonly sampleJobs: readonly RenderJob[];
  /** URL de un video normalizable (MOV/HDR). Omitirla saltea `NFR-014`. */
  readonly videoToNormalize?: string;
}

function withText(job: RenderJob, content: string): RenderJob {
  if (job.format === "slideshow") {
    return {
      ...job,
      images: job.images.map((slide) => ({
        ...slide,
        texts: slide.texts.map((text) => ({ ...text, content })),
      })),
    } satisfies SlideshowJob;
  }
  return { ...job, text: { ...job.text, content } };
}

export function describeMediaRendererContract(
  harness: ContractHarness,
  name: string,
  setup: MediaRendererContractSetup,
): void {
  const { describe, it } = harness;
  const firstJob = setup.sampleJobs[0];

  describe(`MediaRenderer contract · ${name}`, () => {
    it("fingerprint es estable ENTRE INSTANCIAS, no sólo dentro de una", async () => {
      // Medido: la versión anterior comparaba dos llamadas sobre **la misma
      // instancia**, y un renderer con un `randomUUID()` por instancia metido
      // en el hash pasaba las diez aserciones de esta suite. El cache de
      // IMPL §5 no habría acertado nunca y nada lo habría dicho.
      //
      // La garantía que el cache necesita es entre procesos: cada worker
      // construye su propio renderer y tiene que llegar al mismo hash para el
      // mismo job. Dos instancias es lo más cerca que se puede estar de eso
      // dentro de un test; captura el salto por instancia, que es el modo de
      // falla real.
      check(firstJob !== undefined, "sampleJobs vacío: la suite no probaría nada");
      if (firstJob === undefined) return;

      const uno = await setup.makeAdapter();
      const otro = await setup.makeAdapter();

      const once = uno.fingerprint(firstJob);
      checkNonEmpty(once, "fingerprint");
      checkEqual(
        uno.fingerprint(firstJob),
        once,
        "fingerprint no es determinista ni dentro de una instancia",
      );
      checkEqual(
        otro.fingerprint(firstJob),
        once,
        "fingerprint cambia entre instancias del mismo motor: el cache de IMPL §5 nunca acertaría",
      );
    });

    it("fingerprint cambia cuando cambia el texto", async () => {
      const renderer = await setup.makeAdapter();
      if (firstJob === undefined) return;

      const a = renderer.fingerprint(withText(firstJob, "hook A"));
      const b = renderer.fingerprint(withText(firstJob, "hook B"));
      check(
        a !== b,
        "dos textos distintos dan el mismo fingerprint: el cache serviría el render equivocado",
      );
    });

    it("fingerprint distingue formatos distintos", async () => {
      const renderer = await setup.makeAdapter();
      if (setup.sampleJobs.length < 2) return;

      const hashes = new Set(setup.sampleJobs.map((job) => renderer.fingerprint(job)));
      checkEqual(
        hashes.size,
        setup.sampleJobs.length,
        "dos jobs distintos comparten fingerprint",
      );
    });

    it("render devuelve un artefacto con dimensiones y tamaño reales", async () => {
      const renderer = await setup.makeAdapter();
      for (const job of setup.sampleJobs) {
        const result = await renderer.render(job);

        checkNonEmpty(result.contentType, `contentType de ${job.format}`);
        check(result.sizeBytes > 0, `${job.format} produjo 0 bytes`);
        check(result.width > 0 && result.height > 0, `${job.format} sin dimensiones`);
        check(result.renderMs >= 0, "renderMs negativo");
        checkEqual(
          result.fingerprint,
          renderer.fingerprint(job),
          "el fingerprint del resultado no coincide con el del job: el cache no podría indexarse",
        );
      }
    });

    it("rechaza un slideshow con num_images que no coincide (FR-070)", async () => {
      const renderer = await setup.makeAdapter();
      const slideshow = setup.sampleJobs.find(
        (job): job is SlideshowJob => job.format === "slideshow",
      );
      if (slideshow === undefined) return;

      await checkRejectsWithCode(
        () => renderer.render({ ...slideshow, num_images: slideshow.images.length + 1 }),
        ["bad_request"],
        "num_images distinto de images.length",
      );
    });

    it(`rechaza un slideshow de más de ${String(MAX_SLIDES)} slides`, async () => {
      const renderer = await setup.makeAdapter();
      const slideshow = setup.sampleJobs.find(
        (job): job is SlideshowJob => job.format === "slideshow",
      );
      if (slideshow === undefined) return;
      const firstSlide = slideshow.images[0];
      if (firstSlide === undefined) return;

      const images = Array.from({ length: MAX_SLIDES + 1 }, () => firstSlide);
      await checkRejectsWithCode(
        () => renderer.render({ ...slideshow, num_images: images.length, images }),
        ["bad_request"],
        `slideshow de ${String(MAX_SLIDES + 1)} slides`,
      );
    });

    it("probe reporta lo que NFR-014 necesita para decidir la normalización", async () => {
      const renderer = await setup.makeAdapter();
      const url = setup.videoToNormalize;
      if (url === undefined) return;

      const probe = await renderer.probe(url);
      checkNonEmpty(probe.contentType, "contentType del probe");
      check(probe.width > 0 && probe.height > 0, "probe sin dimensiones");
      check(
        typeof probe.isHdr === "boolean" && typeof probe.isFastStart === "boolean",
        "probe sin las banderas que gobiernan la normalización",
      );
    });

    it("probe de una URL inalcanzable es not_found o bad_request (ERR-P11)", async () => {
      const renderer = await setup.makeAdapter();
      await checkRejectsWithCode(
        () => renderer.probe("https://example.invalid/no-existe.mp4"),
        ["not_found", "bad_request", "provider_unavailable"],
        "probe de una URL inalcanzable",
      );
    });

    it("normalize produce el content type pedido (NFR-014)", async () => {
      const renderer = await setup.makeAdapter();
      const url = setup.videoToNormalize;
      if (url === undefined) return;

      const normalized = await renderer.normalize({
        url,
        targetContentType: "video/mp4",
      });
      check(
        normalized.contentType.startsWith("video/mp4"),
        `normalize devolvió ${normalized.contentType}`,
      );
      check(normalized.sizeBytes > 0, "normalize produjo 0 bytes");
    });

    it("thumbnail respeta maxWidth: IMPL §5 prohíbe servir el master", async () => {
      const renderer = await setup.makeAdapter();
      const url = setup.videoToNormalize;
      if (url === undefined) return;

      const maxWidth = 320;
      const thumbnail = await renderer.thumbnail({ url, maxWidth, atSeconds: 0 });
      check(
        thumbnail.width <= maxWidth,
        `thumbnail de ${String(thumbnail.width)} px con maxWidth ${String(maxWidth)}`,
      );
    });
  });
}
