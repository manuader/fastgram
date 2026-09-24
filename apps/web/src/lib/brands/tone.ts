/**
 * Un tono estable por marca, para que el avatar de iniciales se reconozca de
 * un vistazo en el selector (PLAN-USO-PERSONAL §7: "avatares de marca").
 *
 * Sale del id, no del nombre: renombrar una marca no le cambia el color. Los
 * tonos son semánticos del design system (ningún hex suelto, así funcionan en
 * los dos temas); el CSS mapea `data-tone` a sus tokens.
 */
export const BRAND_TONES = ["accent", "info", "success", "warning", "danger"] as const;
export type BrandTone = (typeof BRAND_TONES)[number];

export function brandTone(id: string): BrandTone {
  let hash = 0;
  for (let i = 0; i < id.length; i += 1) {
    hash = (hash * 31 + id.charCodeAt(i)) >>> 0;
  }
  return BRAND_TONES[hash % BRAND_TONES.length] ?? "accent";
}
