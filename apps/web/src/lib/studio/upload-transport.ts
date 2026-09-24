/**
 * Re-export: el PUT firmado se mudó a `lib/media/upload/transport.ts`
 * (`PU-MEDIA-001`), porque ahora lo usan dos pantallas —el video custom del
 * Studio y la subida del Media Bank— y no es de ninguna de las dos.
 *
 * Se queda este archivo, y no se cambian los imports de `custom-video.ts`, por
 * los tests: `CustomVideoUpload.test.tsx` hace `vi.mock` de **esta** ruta, y
 * un mock sólo intercepta el módulo que el código importa de verdad.
 */
export * from "../media/upload/transport";
