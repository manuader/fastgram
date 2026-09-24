/**
 * Puerto BackgroundRemoval — `PU-MEME-002`, `docs/PLAN-USO-PERSONAL.md` §4 y
 * §6, D-14.
 *
 * Un clip de meme sirve como *foreground* (`green-screen-video`, F-129) sólo si
 * el render puede separarlo de su fondo. Hay dos caminos, y el barato va
 * primero:
 *
 * 1. **Ya es verde** → no se procesa nada: el render lo recorta con su croma
 *    (`services/render/src/render/formats.ts`, `planGreenScreenBase`). El
 *    adaptador local (`ChromaKeyBackgroundRemoval`) sólo *detecta* eso.
 * 2. **No es verde** → un proveedor devuelve un video **con alfa** (webm VP9 o
 *    ProRes 4444) y el render lo superpone con `overlay` directo, sin croma.
 *    Hoy: fal BiRefNet v2 (`FalBirefnetBackgroundRemoval`).
 *
 * Un método que no sirve para un clip lo dice con `not_applicable`: no es un
 * error, es la señal para probar el siguiente.
 *
 * Errores (`PortError`): `unauthorized` (key inválida), `rate_limited`,
 * `timeout`, `provider_unavailable`, `bad_request` (el proveedor rechazó el
 * clip) y `provider_contract_violation`.
 */

export interface BackgroundRemovalInput {
  /** Archivo local del clip. */
  readonly path: string;
  readonly contentType: string;
}

export type BackgroundRemovalOutcome =
  /** El clip ya tiene fondo de croma de este color (`#RRGGBB`): lo recorta el render. */
  | { readonly kind: "chroma_key"; readonly keyColor: string }
  /** Un video nuevo con canal alfa. */
  | {
      readonly kind: "alpha_video";
      readonly body: Uint8Array;
      /** `video/webm` (VP9 con alfa) o `video/quicktime` (ProRes 4444). */
      readonly contentType: string;
      readonly extension: string;
    }
  /** Este método no sirve para este clip. */
  | { readonly kind: "not_applicable" };

export interface BackgroundRemoval {
  /** Para logs. Nunca una key. */
  readonly id: string;
  remove(input: BackgroundRemovalInput): Promise<BackgroundRemovalOutcome>;
}
