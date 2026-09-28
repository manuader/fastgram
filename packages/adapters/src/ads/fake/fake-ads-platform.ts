/**
 * `AdsPlatform` en memoria — sprint 9 (R). Para los tests y para usar la UI
 * sin cuenta publicitaria (`ADS_PLATFORM=fake`).
 *
 * Se comporta como lo que prometemos de Meta, no como Meta entera: crea todo
 * en `PAUSED`, guarda cada llamada (para que un test afirme qué se mandó),
 * devuelve los insights que el test le cargue y deja programar fallas.
 *
 * Es **tolerante con ids desconocidos** en `setStatus` / presupuesto /
 * insights: en modo demo la API se reinicia y la memoria se pierde, pero las
 * filas de la base siguen apuntando a sus ids "de Meta".
 */
import {
  AdsPlatformError,
  type AdAccountSummary,
  type AdInsightRow,
  type AdInsightsQuery,
  type AdPageSummary,
  type AdRunStatus,
  type AdsAuth,
  type AdsErrorReason,
  type AdsPlatform,
  type CreateAdInput,
  type CreateAdSetInput,
  type CreateCampaignInput,
  type CreateCreativeInput,
  type CreateSplitTestInput,
} from "@fastgram/ports";

export type FakeAdsMethod = Exclude<keyof AdsPlatform, never>;

export interface FakeAdsCall {
  readonly method: FakeAdsMethod;
  readonly input: unknown;
}

export interface FakeAdObject {
  readonly id: string;
  readonly kind: "campaign" | "adset" | "ad" | "creative" | "video" | "image" | "study";
  status: AdRunStatus;
  readonly input: unknown;
  dailyBudgetMinor?: number;
}

export const FAKE_AD_ACCOUNT: AdAccountSummary = {
  id: "act_000000000000",
  name: "Demo ad account (no real spend)",
  currency: "USD",
  timezoneName: "UTC",
  accountStatus: 1,
};

export const FAKE_AD_PAGE: AdPageSummary = {
  id: "100000000000000",
  name: "Demo Page",
  instagramUserId: "17800000000000000",
  instagramUsername: "demo.brand",
};

export class FakeAdsPlatform implements AdsPlatform {
  readonly calls: FakeAdsCall[] = [];
  readonly objects = new Map<string, FakeAdObject>();
  /** Insights por id de campaña "de Meta". */
  readonly #insights = new Map<string, AdInsightRow[]>();
  readonly #failures = new Map<FakeAdsMethod, AdsErrorReason[]>();
  #seq = 0;

  constructor(
    readonly accounts: readonly AdAccountSummary[] = [FAKE_AD_ACCOUNT],
    readonly pages: readonly AdPageSummary[] = [FAKE_AD_PAGE],
  ) {}

  /** La próxima llamada a `method` falla con `reason` (se pueden encolar varias). */
  failNext(method: FakeAdsMethod, reason: AdsErrorReason): void {
    this.#failures.set(method, [...(this.#failures.get(method) ?? []), reason]);
  }

  setInsights(platformCampaignId: string, rows: readonly AdInsightRow[]): void {
    this.#insights.set(platformCampaignId, [...rows]);
  }

  statusOf(id: string): AdRunStatus | undefined {
    return this.objects.get(id)?.status;
  }

  callsTo(method: FakeAdsMethod): FakeAdsCall[] {
    return this.calls.filter((c) => c.method === method);
  }

  /** Registra la llamada y resuelve `run()`, o rechaza con la falla programada. */
  #run<T>(method: FakeAdsMethod, input: unknown, run: () => T): Promise<T> {
    this.calls.push({ method, input });
    const reason = this.#failures.get(method)?.shift();
    if (reason !== undefined)
      return Promise.reject(
        new AdsPlatformError(reason, `fake ${method} failure`, {
          source: "AdsPlatform/fake",
        }),
      );
    return Promise.resolve(run());
  }

  #create(kind: FakeAdObject["kind"], input: unknown, extra: Partial<FakeAdObject> = {}) {
    this.#seq += 1;
    const id = `fake-${kind}-${String(this.#seq)}`;
    this.objects.set(id, { id, kind, status: "PAUSED", input, ...extra });
    return id;
  }

  listAdAccounts(accessToken: string): Promise<readonly AdAccountSummary[]> {
    return this.#run(
      "listAdAccounts",
      { token: accessToken.length > 0 },
      () => this.accounts,
    );
  }

  listPages(accessToken: string): Promise<readonly AdPageSummary[]> {
    return this.#run("listPages", { token: accessToken.length > 0 }, () => this.pages);
  }

  whoAmI(accessToken: string): Promise<{ id: string; name: string }> {
    return this.#run("whoAmI", { token: accessToken.length > 0 }, () => ({
      id: "10000000000",
      name: "Demo user",
    }));
  }

  createCampaign(_auth: AdsAuth, input: CreateCampaignInput): Promise<{ id: string }> {
    return this.#run("createCampaign", input, () => ({
      id: this.#create("campaign", input),
    }));
  }

  createAdSet(_auth: AdsAuth, input: CreateAdSetInput): Promise<{ id: string }> {
    return this.#run("createAdSet", input, () => ({
      id: this.#create("adset", input, { dailyBudgetMinor: input.dailyBudgetMinor }),
    }));
  }

  uploadVideo(
    _auth: AdsAuth,
    input: { readonly fileUrl: string; readonly name: string },
  ): Promise<{ videoId: string }> {
    return this.#run("uploadVideo", input, () => ({
      videoId: this.#create("video", input),
    }));
  }

  uploadImage(
    _auth: AdsAuth,
    input: { readonly bytes: Uint8Array; readonly filename: string },
  ): Promise<{ imageHash: string }> {
    return this.#run(
      "uploadImage",
      { filename: input.filename, size: input.bytes.byteLength },
      () => ({ imageHash: this.#create("image", input.filename) }),
    );
  }

  createCreative(_auth: AdsAuth, input: CreateCreativeInput): Promise<{ id: string }> {
    return this.#run("createCreative", input, () => ({
      id: this.#create("creative", input),
    }));
  }

  createAd(_auth: AdsAuth, input: CreateAdInput): Promise<{ id: string }> {
    return this.#run("createAd", input, () => ({ id: this.#create("ad", input) }));
  }

  createSplitTest(_auth: AdsAuth, input: CreateSplitTestInput): Promise<{ id: string }> {
    return this.#run("createSplitTest", input, () => ({
      id: this.#create("study", input),
    }));
  }

  setStatus(_auth: AdsAuth, objectId: string, status: AdRunStatus): Promise<void> {
    return this.#run("setStatus", { objectId, status }, () => {
      const obj = this.objects.get(objectId);
      if (obj !== undefined) obj.status = status;
      else
        this.objects.set(objectId, {
          id: objectId,
          kind: "campaign",
          status,
          input: null,
        });
    });
  }

  updateAdSetDailyBudget(
    _auth: AdsAuth,
    adSetId: string,
    dailyBudgetMinor: number,
  ): Promise<void> {
    return this.#run("updateAdSetDailyBudget", { adSetId, dailyBudgetMinor }, () => {
      const obj = this.objects.get(adSetId);
      if (obj !== undefined) obj.dailyBudgetMinor = dailyBudgetMinor;
    });
  }

  getInsights(_auth: AdsAuth, query: AdInsightsQuery): Promise<readonly AdInsightRow[]> {
    return this.#run("getInsights", query, () =>
      (this.#insights.get(query.campaignId) ?? []).filter(
        (r) => r.date >= query.since && r.date <= query.until,
      ),
    );
  }
}
