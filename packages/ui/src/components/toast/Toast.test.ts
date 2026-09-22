import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { t } from "../../i18n/t";
import { createToastStore, DEFAULT_TOAST_DURATION } from "./toast-store";
import { toastVariants } from "./toast.variants";

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("createToastStore", () => {
  it("arranca vacío y devuelve siempre la misma referencia", () => {
    const store = createToastStore();
    expect(store.getSnapshot()).toEqual([]);
    expect(store.getSnapshot()).toBe(store.getSnapshot());
  });

  it("encola con los valores por defecto", () => {
    const store = createToastStore();
    store.add({ title: t("toast.contentSaved") });
    const [toast] = store.getSnapshot();
    expect(toast?.title).toBe("Content saved!");
    expect(toast?.tone).toBe("neutral");
    expect(toast?.duration).toBe(DEFAULT_TOAST_DURATION);
  });

  it("se auto-cierra al vencer la duración", () => {
    const store = createToastStore();
    store.add({ title: t("toast.buildingPost") });
    expect(store.getSnapshot()).toHaveLength(1);
    vi.advanceTimersByTime(DEFAULT_TOAST_DURATION - 1);
    expect(store.getSnapshot()).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(store.getSnapshot()).toHaveLength(0);
  });

  it("duration 0 deja el toast fijo", () => {
    const store = createToastStore();
    store.add({ title: t("toast.allChangesSaved"), duration: 0 });
    vi.advanceTimersByTime(60_000);
    expect(store.getSnapshot()).toHaveLength(1);
  });

  it("respeta el límite descartando el más viejo", () => {
    const store = createToastStore({ limit: 2 });
    store.add({ title: "uno" });
    store.add({ title: "dos" });
    store.add({ title: "tres" });
    expect(store.getSnapshot().map((toast) => toast.title)).toEqual(["dos", "tres"]);
  });

  it("descartar por límite también cancela su temporizador", () => {
    const store = createToastStore({ limit: 1 });
    store.add({ title: "uno" });
    store.add({ title: "dos" });
    vi.advanceTimersByTime(DEFAULT_TOAST_DURATION);
    // Si el temporizador del descartado siguiera vivo, borraría a "dos"
    // después de que éste ya se fue, o peor: emitiría un cambio fantasma.
    expect(store.getSnapshot()).toEqual([]);
  });

  it("dismiss quita sólo el suyo y es idempotente", () => {
    const store = createToastStore();
    const first = store.add({ title: "uno" });
    store.add({ title: "dos" });
    store.dismiss(first);
    store.dismiss(first);
    expect(store.getSnapshot().map((toast) => toast.title)).toEqual(["dos"]);
  });

  it("notifica a los suscriptores en alta y baja, y deja desuscribirse", () => {
    const store = createToastStore();
    const listener = vi.fn();
    const unsubscribe = store.subscribe(listener);
    const id = store.add({ title: "uno" });
    expect(listener).toHaveBeenCalledTimes(1);
    store.dismiss(id);
    expect(listener).toHaveBeenCalledTimes(2);
    unsubscribe();
    store.add({ title: "dos" });
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it("clear vacía la cola y apaga los temporizadores", () => {
    const store = createToastStore();
    store.add({ title: "uno" });
    store.add({ title: "dos" });
    store.clear();
    expect(store.getSnapshot()).toEqual([]);
    vi.advanceTimersByTime(DEFAULT_TOAST_DURATION);
    expect(store.getSnapshot()).toEqual([]);
  });

  it("transporta la acción del PRD §3.5 tal cual", () => {
    const store = createToastStore();
    const onClick = vi.fn();
    store.add({
      title: t("toast.buildingPost"),
      action: { label: t("toast.viewInLibrary"), onClick },
    });
    const [toast] = store.getSnapshot();
    expect(toast?.action?.label).toBe("View in Library");
    toast?.action?.onClick();
    expect(onClick).toHaveBeenCalledOnce();
  });
});

describe("toastVariants", () => {
  it("cubre los cinco tonos", () => {
    for (const tone of ["neutral", "success", "warning", "danger", "info"] as const) {
      expect(toastVariants({ tone })).toContain(`fg-toast--${tone}`);
    }
  });
});
