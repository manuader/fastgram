/**
 * Sprint 7 — el relleno de Blitz le pone música de la marca a las piezas de
 * video (`withBrandAudio`), contra Postgres real y con el rol de aplicación
 * (RLS de `brand_audio_tracks`, migración `0025`).
 */
import { SeededRng } from "@fastgram/adapters";
import { parseSuggestionBuildPlan } from "@fastgram/core";
import {
  APP_ROLE,
  brandAudioRepository,
  withCompany,
  type DbHandle,
  type QueuedSuggestionDraft,
  type Transaction,
} from "@fastgram/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { withBrandAudio } from "../src/discovery/refill-handler.js";
import { openDb, seedCompany } from "./helpers/fixtures.js";

let handle: DbHandle;

beforeAll(() => {
  handle = openDb();
});

afterAll(async () => {
  await handle?.close();
});

const inCompany =
  (companyId: string) =>
  <T>(fn: (tx: Transaction) => Promise<T>): Promise<T> =>
    withCompany(handle.db, companyId, fn, { role: APP_ROLE });

const ref = (id: string) => ({ mediaId: id, url: `https://bucket.test/media/${id}.mp4` });

function draft(contentType: string): QueuedSuggestionDraft {
  const media =
    contentType === "slideshow"
      ? { format: "slideshow", slides: [ref("s1")] }
      : contentType === "green-screen"
        ? { format: "green-screen", image: ref("bg"), video: ref("clip") }
        : { format: "wall-of-text", video: ref("v") };
  return {
    contentType,
    generatedText: "x",
    aiExplanation: "x",
    angleId: null,
    influencerId: null,
    textStylePresetId: null,
    buildPlan: { version: 1, media, texts: ["x"] },
  } as unknown as QueuedSuggestionDraft;
}

async function addTrack(companyId: string, title: string, autoUse = true) {
  return inCompany(companyId)(async (tx) => {
    const row = await brandAudioRepository.create(
      tx,
      { companyId },
      {
        title,
        origin: "upload",
        storageKey: `audio/${companyId}/${title}`,
        url: `https://bucket.test/audio/${companyId}/${title}.mp3`,
        contentType: "audio/mpeg",
        sizeMb: 1,
      },
    );
    if (!autoUse)
      await brandAudioRepository.update(tx, { companyId }, row.id, { autoUse });
    return row;
  });
}

describe("withBrandAudio · música de la marca en el relleno (sprint 7)", () => {
  it("sin pistas en la biblioteca, las sugerencias salen como antes", async () => {
    const companyId = await seedCompany(handle);
    const drafts = [draft("wall-of-text")];
    const out = await withBrandAudio(new SeededRng(1), drafts, inCompany(companyId), {
      companyId,
    });
    expect(out[0]?.buildPlan).toEqual(drafts[0]?.buildPlan);
  });

  it("con pistas: cada pieza de video lleva una; el slideshow ninguna; sobrevive al parse", async () => {
    const companyId = await seedCompany(handle);
    const track = await addTrack(companyId, "beat");
    const out = await withBrandAudio(
      new SeededRng(1),
      [draft("wall-of-text"), draft("green-screen"), draft("slideshow")],
      inCompany(companyId),
      { companyId },
    );
    const expected = { audioId: track.id, url: track.url };
    expect(out[0]?.buildPlan).toMatchObject({ audio: expected });
    expect(out[1]?.buildPlan).toMatchObject({ audio: expected });
    expect(out[2]?.buildPlan).not.toHaveProperty("audio");

    // Lo que se persiste vuelve por `parseSuggestionBuildPlan` al aceptar.
    const parsed = parseSuggestionBuildPlan(
      JSON.parse(JSON.stringify(out[1]?.buildPlan)),
      "green-screen",
    );
    if (!parsed.ok) throw new Error(parsed.reason);
    expect(parsed.plan.audio).toEqual(expected);
  });

  it("las pistas fuera del sorteo (autoUse=false) y las borradas no salen", async () => {
    const companyId = await seedCompany(handle);
    await addTrack(companyId, "fuera", false);
    const borrada = await addTrack(companyId, "borrada");
    await inCompany(companyId)((tx) =>
      brandAudioRepository.softDelete(tx, { companyId }, borrada.id),
    );
    const out = await withBrandAudio(
      new SeededRng(1),
      [draft("wall-of-text")],
      inCompany(companyId),
      { companyId },
    );
    expect(out[0]?.buildPlan).not.toHaveProperty("audio");
  });

  it("la biblioteca de otra marca no se ve (RLS + scope)", async () => {
    const mine = await seedCompany(handle);
    const other = await seedCompany(handle);
    await addTrack(other, "ajena");
    const out = await withBrandAudio(
      new SeededRng(1),
      [draft("wall-of-text")],
      inCompany(mine),
      { companyId: mine },
    );
    expect(out[0]?.buildPlan).not.toHaveProperty("audio");
  });

  it("si la lectura falla, sigue sin música y avisa", async () => {
    const errors: unknown[] = [];
    const out = await withBrandAudio(
      new SeededRng(1),
      [draft("wall-of-text")],
      () => Promise.reject(new Error("db caída")),
      { companyId: "x" },
      (e) => errors.push(e),
    );
    expect(out[0]?.buildPlan).not.toHaveProperty("audio");
    expect(errors).toHaveLength(1);
  });
});
