import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "./Tabs";

// Las tabs de Library, PRD §3.3.
function LibraryTabs() {
  return (
    <Tabs defaultValue="posts">
      <TabsList>
        <TabsTrigger value="posts">My Posts</TabsTrigger>
        <TabsTrigger value="content">My Content</TabsTrigger>
        <TabsTrigger value="media">My Media Bank</TabsTrigger>
      </TabsList>
      <TabsContent value="posts">posts</TabsContent>
      <TabsContent value="content">content</TabsContent>
    </Tabs>
  );
}

describe("Tabs (markup)", () => {
  const html = renderToStaticMarkup(<LibraryTabs />);

  it("usa los roles del patrón tablist", () => {
    expect(html).toContain('role="tablist"');
    expect(html.match(/role="tab"/g)).toHaveLength(3);
    expect(html.match(/role="tabpanel"/g)).toHaveLength(2);
  });

  it("sólo la pestaña activa está en el orden de tabulación", () => {
    expect(html.match(/tabindex="0"/g)).toHaveLength(2); // la tab activa y su panel
    expect(html.match(/tabindex="-1"/g)).toHaveLength(3); // dos tabs y el panel oculto
  });

  it("cada tab apunta a su panel y cada panel a su tab", () => {
    const tabId = /id="([^"]*-tab-posts)"/.exec(html)?.[1];
    const panelId = /id="([^"]*-panel-posts)"/.exec(html)?.[1];
    expect(tabId).toBeDefined();
    expect(panelId).toBeDefined();
    expect(html).toContain(`aria-controls="${panelId ?? ""}"`);
    expect(html).toContain(`aria-labelledby="${tabId ?? ""}"`);
  });

  it("el panel inactivo va oculto, no sólo despintado", () => {
    expect(html).toContain("hidden");
    expect(html).toContain('aria-selected="true"');
    expect(html.match(/aria-selected="false"/g)).toHaveLength(2);
  });
});
