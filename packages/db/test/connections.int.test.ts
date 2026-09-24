/**
 * `0015_social_platforms.sql` + `repositories/connections.ts`.
 *
 * Con `SET LOCAL ROLE fastgram_app`, como el resto: RLS tiene que ver lo mismo
 * que el `WHERE` del repositorio.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  connectionAccountRepository,
  connectionTokenStore,
  type ConnectionAccountValues,
} from "../src/repositories/index";
import type { Transaction } from "../src/client";
import { APP_ROLE, withCompany } from "../src/tenancy";
import { seedCompany, startTestDatabase, type TestDatabase } from "./helpers/postgres";

let ctx: TestDatabase;
let alpha: { companyId: string };
let beta: { companyId: string };

const asApp = <T>(companyId: string, fn: (tx: Transaction) => Promise<T>): Promise<T> =>
  withCompany(ctx.db, companyId, fn, { role: APP_ROLE });

const account = (
  over: Partial<ConnectionAccountValues> = {},
): ConnectionAccountValues => ({
  platform: "x",
  platformUserId: "42",
  platformUsername: "brand",
  displayName: "Brand",
  avatarUrl: null,
  scopes: ["tweet.write"],
  publishable: true,
  accessToken: "v1.cipher-a",
  refreshToken: "v1.cipher-r",
  tokenExpiry: new Date("2026-09-24T14:00:00.000Z"),
  refreshTokenExpiry: null,
  tokenIssuedAt: new Date("2026-09-24T12:00:00.000Z"),
  ...over,
});

beforeAll(async () => {
  ctx = await startTestDatabase();
  alpha = await seedCompany(ctx.db, { name: "Alpha" });
  beta = await seedCompany(ctx.db, { name: "Beta" });
});

afterAll(async () => {
  await ctx?.stop();
});

describe("connections (0015)", () => {
  it("acepta x/threads/facebook y reconectar la misma cuenta actualiza la fila", async () => {
    const first = await asApp(alpha.companyId, (tx) =>
      connectionAccountRepository.upsertAccount(tx, alpha, account()),
    );
    await asApp(alpha.companyId, (tx) =>
      connectionAccountRepository.markExpired(tx, alpha, first.id, "refresh_rejected"),
    );
    const again = await asApp(alpha.companyId, (tx) =>
      connectionAccountRepository.upsertAccount(
        tx,
        alpha,
        account({ platformUsername: "brand2", accessToken: "v1.cipher-b" }),
      ),
    );
    expect(again.id).toBe(first.id);
    expect(again).toMatchObject({
      status: "active",
      statusReason: null,
      platformUsername: "brand2",
      accessToken: "v1.cipher-b",
    });

    for (const platform of ["threads", "facebook"] as const) {
      const row = await asApp(alpha.companyId, (tx) =>
        connectionAccountRepository.upsertAccount(tx, alpha, account({ platform })),
      );
      expect(row.platform).toBe(platform);
    }
  });

  it("la misma cuenta en otra marca es otra fila, y cada marca ve sólo la suya", async () => {
    const mine = await asApp(beta.companyId, (tx) =>
      connectionAccountRepository.upsertAccount(tx, beta, account()),
    );
    const alphaList = await asApp(alpha.companyId, (tx) =>
      connectionAccountRepository.list(tx, alpha),
    );
    expect(alphaList.map((r) => r.id)).not.toContain(mine.id);
    expect(
      await asApp(alpha.companyId, (tx) =>
        connectionAccountRepository.find(tx, alpha, mine.id),
      ),
    ).toBeNull();
    expect(
      await asApp(alpha.companyId, (tx) =>
        connectionAccountRepository.revoke(tx, alpha, mine.id),
      ),
    ).toBeNull();
  });

  it("revocar borra los tokens; el token store respeta la marca", async () => {
    const row = await asApp(alpha.companyId, (tx) =>
      connectionAccountRepository.upsertAccount(
        tx,
        alpha,
        account({ platform: "tiktok", platformUserId: "open-1" }),
      ),
    );
    const loaded = await asApp(alpha.companyId, (tx) =>
      connectionTokenStore(tx).load(alpha.companyId, row.id),
    );
    expect(loaded).toMatchObject({ accessToken: "v1.cipher-a", platform: "tiktok" });
    expect(
      await asApp(beta.companyId, (tx) =>
        connectionTokenStore(tx).load(beta.companyId, row.id),
      ),
    ).toBeNull();

    await asApp(alpha.companyId, (tx) =>
      connectionTokenStore(tx).saveTokens(alpha.companyId, row.id, {
        accessToken: "v1.new",
        tokenExpiry: null,
        tokenIssuedAt: new Date("2026-09-25T00:00:00.000Z"),
      }),
    );
    const saved = await asApp(alpha.companyId, (tx) =>
      connectionAccountRepository.find(tx, alpha, row.id),
    );
    // `refreshToken` no vino: no se toca.
    expect(saved).toMatchObject({ accessToken: "v1.new", refreshToken: "v1.cipher-r" });

    const revoked = await asApp(alpha.companyId, (tx) =>
      connectionAccountRepository.revoke(tx, alpha, row.id),
    );
    expect(revoked).toMatchObject({
      status: "revoked",
      accessToken: null,
      refreshToken: null,
    });
  });
});
