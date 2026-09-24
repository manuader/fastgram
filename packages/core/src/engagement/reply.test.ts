import { describe, expect, it } from "vitest";

import {
  blockingIssues,
  buildReplyPrompt,
  cleanGeneratedReply,
  lintReply,
  mentionsBrand,
} from "./reply.js";

const brand = { name: "Acme", productOffering: "invoicing for freelancers" };
const thread = {
  subreddit: "freelance",
  title: "How do you invoice?",
  body: "Help",
  topComments: ["c1"],
};

describe("reply prompt (F-195/F-196)", () => {
  it("sin link por defecto, divulgación obligatoria, post como dato no confiable", () => {
    const p = buildReplyPrompt({
      brand,
      settings: { tone: "casual", customRules: "", allowLinks: false },
      thread,
    });
    const system = p.messages[0]?.content ?? "";
    expect(system).toContain("No links of any kind");
    expect(system).toContain("affiliated");
    expect(system).not.toContain("How do you invoice?");
    expect(p.untrusted.map((u) => u.label)).toEqual(["reddit_post", "reddit_comment"]);
  });

  it("links sólo si la marca los habilita, y sólo su URL", () => {
    const p = buildReplyPrompt({
      brand,
      settings: {
        tone: "professional",
        customRules: "",
        allowLinks: true,
        websiteUrl: "https://acme.test",
      },
      thread,
    });
    expect(p.messages[0]?.content).toContain("only this one: https://acme.test");
  });

  it("las reglas propias van al final y no pisan 1–4; regenerar pide otra versión", () => {
    const p = buildReplyPrompt({
      brand,
      settings: {
        tone: "casual",
        customRules: "Never say 'game changer'.",
        allowLinks: false,
      },
      thread,
      previousDraft: "old draft",
    });
    const system = p.messages[0]?.content ?? "";
    expect(system.indexOf("Never say")).toBeGreaterThan(system.indexOf("Rule 4"));
    expect(system).toContain("unless they contradict Rules 1–4");
    expect(p.messages[1]?.content).toContain("clearly different version");
  });

  it("limpia comillas y prefacios", () => {
    expect(cleanGeneratedReply('"hello there"')).toBe("hello there");
    expect(cleanGeneratedReply("Here is the comment:\nhello")).toBe("hello");
  });
});

describe("lintReply: reglas determinísticas", () => {
  const opts = { brandName: "Acme", allowLinks: false };

  it("nombrar la marca sin divulgar bloquea Send", () => {
    const issues = lintReply("Try Acme, it rocks.", opts);
    expect(issues).toContain("brand_without_disclosure");
    expect(blockingIssues(issues)).toEqual(["brand_without_disclosure"]);
  });

  it("con divulgación (en inglés o castellano) pasa", () => {
    expect(lintReply("Full disclosure, I work on Acme: it does this.", opts)).toEqual([]);
    expect(lintReply("Aclaración: trabajo en Acme, y sirve para esto.", opts)).toEqual(
      [],
    );
  });

  it("sin mencionar la marca no pide divulgación", () => {
    expect(lintReply("Use a spreadsheet with due dates.", opts)).toEqual([]);
  });

  it("un link con links apagados avisa pero no bloquea", () => {
    const issues = lintReply("See https://example.com", opts);
    expect(issues).toEqual(["contains_link"]);
    expect(blockingIssues(issues)).toEqual([]);
    expect(lintReply("See https://example.com", { ...opts, allowLinks: true })).toEqual(
      [],
    );
  });

  it("vacío y demasiado largo bloquean", () => {
    expect(lintReply("  ", opts)).toEqual(["empty"]);
    expect(blockingIssues(lintReply("a".repeat(3_000), opts))).toEqual(["too_long"]);
  });

  it("la marca como palabra, no dentro de otra", () => {
    expect(mentionsBrand("acme is nice", "Acme")).toBe(true);
    expect(mentionsBrand("acmeville is nice", "Acme")).toBe(false);
  });
});
