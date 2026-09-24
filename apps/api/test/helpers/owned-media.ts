/**
 * URLs de media que `POST /content` acepta como de la marca (`P2-RENDER-009`).
 *
 * Desde que la ruta valida el payload, `https://cdn.example.test/a.mp4` es una
 * URL ajena y da `400`. Los tests que sólo quieren *una pieza cualquiera* usan
 * esto: la dirección canónica del objeto bajo `media/{companyId}/`, armada con
 * la misma función que la API (`canonicalObjectUrl`) sobre el mismo
 * `MemoryStorage` que monta el harness.
 */
import { FixedClock, MemoryStorage, canonicalObjectUrl } from "@fastgram/adapters";

const storage = new MemoryStorage(new FixedClock());

/** `media/{companyId}/{file}` como URL canónica del storage del harness. */
export function ownedMediaUrl(companyId: string, file: string): Promise<string> {
  return canonicalObjectUrl(storage, `media/${companyId}/${file}`);
}

/** `audio/{companyId}/{file}`: la biblioteca de audio de la marca. */
export function ownedAudioUrl(companyId: string, file: string): Promise<string> {
  return canonicalObjectUrl(storage, `audio/${companyId}/${file}`);
}
