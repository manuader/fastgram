import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Button } from "../button/Button";
import { EmptyState } from "./EmptyState";

describe("EmptyState (markup)", () => {
  it("renderiza el copy literal del PRD a partir del ID del estado", () => {
    expect(renderToStaticMarkup(<EmptyState preset="ERR-E04" />)).toContain(
      "No images uploaded yet",
    );
    const inspiration = renderToStaticMarkup(<EmptyState preset="ERR-E02" />);
    expect(inspiration).toContain("No results");
    expect(inspiration).toContain("Try a different search or clear your filters.");
  });

  it("interpola los huecos del copy (ERR-E13)", () => {
    const html = renderToStaticMarkup(
      <EmptyState preset="ERR-E13" vars={{ handle: "fastgram" }} />,
    );
    expect(html).toContain(
      "@fastgram doesn&#x27;t have enough posts yet. Add another source or describe your brand.",
    );
  });

  it("un título explícito le gana al preset", () => {
    const html = renderToStaticMarkup(<EmptyState preset="ERR-E05" title="No drafts" />);
    expect(html).toContain("No drafts");
    expect(html).not.toContain("No posts");
  });

  it("renderiza la acción que le pasen (ERR-E12: `+ Add source`)", () => {
    const html = renderToStaticMarkup(
      <EmptyState preset="ERR-E12" action={<Button>+ Add source</Button>} />,
    );
    expect(html).toContain("+ Add source");
    expect(html).toContain("fg-state__actions");
  });
});
