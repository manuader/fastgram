/**
 * Qué extractores sociales se montan, según el entorno — `PU-SCRAPE-001`,
 * `PU-SCRAPE-002`, `D-13`.
 *
 * **Nada tiene default.** Configurar la URL de un extractor es la decisión de
 * leer esa plataforma con él (tier C para los scrapers: `D-13` lo levanta para
 * uso personal). Sin la variable, la plataforma no tiene extractor y el handler
 * la cierra en `failed` / `unsupported_platform` / `D_assisted`: la UI ofrece
 * pegar la bio a mano (`P1-BRAND-014`).
 *
 * | Variable | Qué monta |
 * |---|---|
 * | `INSTAGRAM_EXTRACTOR_URL` | Instagram anónimo por `services/vision` (instaloader) — C |
 * | `INSTAGRAM_BD_IG_USER_ID` + `INSTAGRAM_BD_ACCESS_TOKEN` | Instagram por Business Discovery (Facebook Login) — B |
 * | `TIKTOK_EXTRACTOR_URL` (+ `TIKTOK_EXTRACTOR_API_KEY`) | TikTok por el contenedor de Evil0ctal v5.1.1 — C |
 * | `X_EXTRACTOR_URL` | X por FxTwitter (`https://api.fxtwitter.com`) — C |
 *
 * Con las dos vías de Instagram se monta una escalera **B → C** (`FR-011.4`):
 * Business Discovery primero, y el anónimo sólo si la cuenta no califica o la
 * API no contesta.
 *
 * `INSTAGRAM_BD_ACCESS_TOKEN` es un secreto: va al entorno o a `~/.fastgram`,
 * nunca al repo. **Lo ideal** sería sacarlo de una `Connection` de Facebook
 * Login con su IG User vinculado, pero hoy la conexión de Instagram de este repo
 * es de Instagram Login (`graph.instagram.com`), y Business Discovery exige un
 * token de Facebook Login. Queda como variable hasta que exista esa conexión.
 */
import {
  InstagramBusinessDiscoveryReader,
  InstagramVisionReader,
  LadderSocialReader,
  TikTokDtkReader,
  XFxTwitterReader,
  type SocialFetch,
} from "@fastgram/adapters/social-readers";
import type { BrandSourceType, SocialReader } from "@fastgram/ports";

export type SocialReaderEnv = Readonly<Record<string, string | undefined>>;

export interface SocialReadersMount {
  readonly readers: Readonly<Partial<Record<BrandSourceType, SocialReader>>>;
  /** Para el log de arranque: qué quedó montado y con qué. */
  readonly mounted: readonly string[];
  /** Qué no, y por qué. Nunca incluye valores de variables. */
  readonly skipped: readonly { readonly source: BrandSourceType; readonly why: string }[];
}

function value(env: SocialReaderEnv, name: string): string | undefined {
  const v = env[name]?.trim();
  return v === undefined || v === "" ? undefined : v;
}

function httpUrl(env: SocialReaderEnv, name: string): string | undefined {
  const v = value(env, name);
  if (v === undefined) return undefined;
  let url: URL;
  try {
    url = new URL(v);
  } catch {
    throw new Error(`${name} no es una URL válida`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`${name} tiene que ser http(s)`);
  }
  return v;
}

export function socialReadersFromEnv(
  env: SocialReaderEnv,
  options: { readonly fetch?: SocialFetch } = {},
): SocialReadersMount {
  const readers: Partial<Record<BrandSourceType, SocialReader>> = {};
  const mounted: string[] = [];
  const skipped: { source: BrandSourceType; why: string }[] = [];
  const f = options.fetch === undefined ? {} : { fetch: options.fetch };

  // ── Instagram ──────────────────────────────────────────────────────────────
  const ig: SocialReader[] = [];
  const bdUser = value(env, "INSTAGRAM_BD_IG_USER_ID");
  const bdToken = value(env, "INSTAGRAM_BD_ACCESS_TOKEN");
  if ((bdUser === undefined) !== (bdToken === undefined)) {
    throw new Error(
      "INSTAGRAM_BD_IG_USER_ID e INSTAGRAM_BD_ACCESS_TOKEN van juntas (Business Discovery)",
    );
  }
  if (bdUser !== undefined && bdToken !== undefined) {
    ig.push(
      new InstagramBusinessDiscoveryReader({
        credentials: () => Promise.resolve({ igUserId: bdUser, accessToken: bdToken }),
        ...f,
      }),
    );
    mounted.push("instagram:business_discovery(B)");
  }
  const vision = httpUrl(env, "INSTAGRAM_EXTRACTOR_URL");
  if (vision !== undefined) {
    ig.push(new InstagramVisionReader({ baseUrl: vision, ...f }));
    mounted.push("instagram:instaloader(C)");
  }
  const [firstIg] = ig;
  if (firstIg === undefined) {
    skipped.push({
      source: "instagram",
      why: "sin INSTAGRAM_EXTRACTOR_URL ni Business Discovery",
    });
  } else {
    readers.instagram = ig.length === 1 ? firstIg : new LadderSocialReader(ig);
  }

  // ── TikTok ─────────────────────────────────────────────────────────────────
  const tiktok = httpUrl(env, "TIKTOK_EXTRACTOR_URL");
  if (tiktok === undefined) {
    skipped.push({ source: "tiktok", why: "sin TIKTOK_EXTRACTOR_URL" });
  } else {
    const apiKey = value(env, "TIKTOK_EXTRACTOR_API_KEY");
    readers.tiktok = new TikTokDtkReader({
      baseUrl: tiktok,
      ...(apiKey === undefined ? {} : { apiKey }),
      ...f,
    });
    mounted.push(apiKey === undefined ? "tiktok:dtk(C, sin API key)" : "tiktok:dtk(C)");
  }

  // ── X ──────────────────────────────────────────────────────────────────────
  const x = httpUrl(env, "X_EXTRACTOR_URL");
  if (x === undefined) {
    skipped.push({ source: "x", why: "sin X_EXTRACTOR_URL" });
  } else {
    readers.x = new XFxTwitterReader({ baseUrl: x, ...f });
    mounted.push("x:fxtwitter(C)");
  }

  return { readers, mounted, skipped };
}
