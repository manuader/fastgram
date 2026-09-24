import { describe, expect, it } from "vitest";

import { DomainError } from "../errors.js";
import {
  MOVABLE_POST_STATUSES,
  assertCanMovePost,
  assertCanMoveSlot,
  isMovablePost,
  type MovablePost,
} from "./calendar-move.js";
import { POST_STATUSES } from "./schedule-post.js";

const NOW = new Date("2026-09-22T12:00:00Z");
const LATER = new Date("2026-09-23T12:00:00Z");

function post(over: Partial<MovablePost> = {}): MovablePost {
  return {
    id: "p1",
    status: "SCHEDULED",
    accountType: "oauth",
    tiktokProcessingDelayed: false,
    cancellationPending: false,
    scheduledFor: LATER,
    ...over,
  };
}

function codeOf(fn: () => void): string | null {
  try {
    fn();
    return null;
  } catch (error) {
    return error instanceof DomainError ? error.code : "unexpected";
  }
}

describe("mover un post", () => {
  it("la lista de estados coincide con la de FR-060", () => {
    // La lista local existe para no hacer un ciclo de imports; esto la ata.
    for (const status of MOVABLE_POST_STATUSES) {
      expect(POST_STATUSES).toContain(status);
    }
  });

  it("sólo se mueven los que no salieron", () => {
    for (const status of POST_STATUSES) {
      const movable = isMovablePost(post({ status }));
      expect(movable, status).toBe(MOVABLE_POST_STATUSES.includes(status));
    }
    expect(isMovablePost(post({ status: "POSTED" }))).toBe(false);
    expect(isMovablePost(post({ status: "IN_USER_INBOX" }))).toBe(false);
  });

  it("el carril lento de TikTok y una cancelación pendiente bloquean (conflict)", () => {
    expect(
      codeOf(() =>
        assertCanMovePost(post({ tiktokProcessingDelayed: true }), LATER, NOW),
      ),
    ).toBe("conflict");
    expect(
      codeOf(() => assertCanMovePost(post({ cancellationPending: true }), LATER, NOW)),
    ).toBe("conflict");
  });

  it("warmed no se mueve desde el calendario", () => {
    expect(
      codeOf(() => assertCanMovePost(post({ accountType: "warmed" }), LATER, NOW)),
    ).toBe("conflict");
  });

  it("la hora nueva tiene que ser futura", () => {
    expect(codeOf(() => assertCanMovePost(post(), NOW, NOW))).toBe("out_of_range");
    expect(codeOf(() => assertCanMovePost(post(), LATER, NOW))).toBeNull();
  });
});

describe("mover un slot", () => {
  it("planificado y a futuro, sí; convertido, no", () => {
    expect(
      codeOf(() => assertCanMoveSlot({ id: "s", status: "planned" }, LATER, NOW)),
    ).toBeNull();
    expect(
      codeOf(() => assertCanMoveSlot({ id: "s", status: "converted" }, LATER, NOW)),
    ).toBe("invalid_state");
    expect(
      codeOf(() => assertCanMoveSlot({ id: "s", status: "planned" }, NOW, NOW)),
    ).toBe("out_of_range");
  });
});
