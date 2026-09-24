import { describe, expect, it } from "vitest";

import {
  parseBanRiskJob,
  parseLeadDiscoveryJob,
  parseThreadMonitoringJob,
} from "./jobs.js";
import { summarizeThread, type ThreadSnapshot } from "./monitor.js";

const snap = (over: Partial<ThreadSnapshot> = {}): ThreadSnapshot => ({
  postId: "abc",
  locked: false,
  numComments: 4,
  score: 10,
  comments: [
    { name: "t1_a", author: "me", parentId: "t3_abc", createdUtc: 1 },
    { name: "t1_b", author: "other", parentId: "t1_a", createdUtc: 2 },
    { name: "t1_c", author: "other2", parentId: "t3_abc", createdUtc: 3 },
  ],
  ...over,
});

describe("summarizeThread (F-198/F-199)", () => {
  it("nuestro comentario visible + respuestas directas", () => {
    const s = summarizeThread({
      snapshot: snap(),
      ownUsername: "Me",
      sentCommentNames: [],
      replied: true,
      previousNumComments: 2,
    });
    expect(s).toMatchObject({
      threadState: "tracking",
      ourComments: 1,
      repliesToUs: 1,
      newActivity: true,
    });
  });

  it("enviado y no visible → comment_missing (filtrado o borrado)", () => {
    const s = summarizeThread({
      snapshot: snap({ comments: [] }),
      ownUsername: "me",
      sentCommentNames: ["t1_zzz"],
      replied: true,
      previousNumComments: 4,
    });
    expect(s.threadState).toBe("comment_missing");
    expect(s.newActivity).toBe(false);
  });

  it("sin respuesta: new o locked", () => {
    const base = {
      ownUsername: null,
      sentCommentNames: [],
      replied: false,
      previousNumComments: null,
    };
    expect(summarizeThread({ ...base, snapshot: snap() }).threadState).toBe("new");
    expect(
      summarizeThread({ ...base, snapshot: snap({ locked: true }) }).threadState,
    ).toBe("locked");
  });
});

describe("payloads de las colas", () => {
  const id = "11111111-1111-4111-8111-111111111111";
  it("`{}` del cron es sweep; lo raro es null", () => {
    expect(parseLeadDiscoveryJob({})).toEqual({ kind: "sweep" });
    expect(parseThreadMonitoringJob({})).toEqual({ kind: "sweep" });
    expect(parseBanRiskJob({})).toEqual({ kind: "sweep" });
    expect(parseLeadDiscoveryJob({ kind: "discover", companyId: "nope" })).toBeNull();
    expect(parseLeadDiscoveryJob(null)).toBeNull();
  });

  it("variantes con marca y lead", () => {
    expect(
      parseLeadDiscoveryJob({
        kind: "reply",
        companyId: id,
        leadId: id,
        regenerate: true,
      }),
    ).toEqual({
      kind: "reply",
      companyId: id,
      leadId: id,
      regenerate: true,
    });
    expect(parseThreadMonitoringJob({ kind: "sync", companyId: id })).toEqual({
      kind: "sync",
      companyId: id,
    });
    expect(parseBanRiskJob({ kind: "compute", companyId: id })).toEqual({
      kind: "compute",
      companyId: id,
    });
  });
});
