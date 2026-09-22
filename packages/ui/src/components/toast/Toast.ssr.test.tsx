import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Toaster } from "./Toast";
import { createToastStore } from "./toast-store";

describe("Toaster (markup)", () => {
  it("la live region existe aunque no haya ningún toast", () => {
    const html = renderToStaticMarkup(<Toaster store={createToastStore()} />);
    expect(html).toContain('aria-live="polite"');
    expect(html).toContain('aria-label="Notifications"');
  });

  it("renderiza título, descripción y acción del toast del PRD §3.5", () => {
    const store = createToastStore();
    store.add({
      title: "Building post!",
      action: { label: "View in Library", onClick: () => {} },
    });
    const html = renderToStaticMarkup(<Toaster store={store} />);
    expect(html).toContain("Building post!");
    expect(html).toContain("View in Library");
    expect(html).toContain('role="status"');
    expect(html).toContain('aria-label="Dismiss"');
    store.clear();
  });

  it("el toast de error interrumpe con role=alert", () => {
    const store = createToastStore();
    store.add({ title: "Something went wrong", tone: "danger" });
    expect(renderToStaticMarkup(<Toaster store={store} />)).toContain('role="alert"');
    store.clear();
  });
});
