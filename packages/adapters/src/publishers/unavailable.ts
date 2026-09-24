/**
 * Implementaciones «no disponible» de los dos puertos que el worker necesita
 * para publicar y que construyen otros agentes: `PublicMediaUrls` (el túnel,
 * `PU-RUN-005`) y `ConnectionTokens` (OAuth, `PU-PUB-001`).
 *
 * Existen para que el worker se pueda montar y testear antes de que estén, y
 * para que su ausencia sea **ruidosa y con código estable**, no un `undefined`
 * a mitad de camino.
 */
import {
  PortError,
  PublicMediaUnavailableError,
  type ConnectionTokens,
  type PublicMediaUrls,
} from "@fastgram/ports";

export class UnavailablePublicMediaUrls implements PublicMediaUrls {
  async forObject(_objectKey: string): Promise<string> {
    throw new PublicMediaUnavailableError();
  }
}

export class UnavailableConnectionTokens implements ConnectionTokens {
  async getAccessToken(_connectionId: string): Promise<string> {
    throw new PortError("provider_unavailable", "Connection tokens aren't configured.", {
      source: "ConnectionTokens/unavailable",
    });
  }
}
