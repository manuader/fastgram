import { describe, expect, it } from "vitest";
import * as ui from "./index";

/**
 * El barrel es fácil de romper en silencio: una ruta mal escrita o un componente
 * que se renombra y no se re-exporta no lo nota ningún test de variantes.
 */
describe("superficie pública de @fastgram/ui", () => {
  const components = [
    "Avatar",
    "Badge",
    "Button",
    "Card",
    "Checkbox",
    "Dialog",
    "Drawer",
    "EmptyState",
    "ErrorState",
    "Input",
    "Pagination",
    "Select",
    "Skeleton",
    "Spinner",
    "Switch",
    "Tabs",
    "Textarea",
    "Toaster",
    "Tooltip",
  ] as const;

  it("exporta los diecinueve componentes base", () => {
    for (const name of components) {
      expect(ui[name], name).toBeTypeOf("function");
    }
  });

  it("exporta las piezas de composición de los compuestos", () => {
    const parts = [
      "CardHeader",
      "CardTitle",
      "CardDescription",
      "CardContent",
      "CardFooter",
      "DialogHeader",
      "DialogTitle",
      "DialogDescription",
      "DialogBody",
      "DialogFooter",
      "DialogClose",
      "DrawerHeader",
      "DrawerTitle",
      "DrawerDescription",
      "DrawerBody",
      "DrawerFooter",
      "DrawerClose",
      "TabsList",
      "TabsTrigger",
      "TabsContent",
      "SkeletonText",
      "ToastProvider",
      "useToast",
    ] as const;
    for (const name of parts) {
      expect(ui[name], name).toBeTypeOf("function");
    }
  });

  it("exporta el helper de clases, el copy y los helpers puros", () => {
    expect(ui.cn("a", "b")).toBe("a b");
    expect(ui.t("common.tryAgain")).toBe("Try again");
    expect(ui.en).toBeTypeOf("object");
    expect(ui.getInitials("Ada Lovelace")).toBe("AL");
    expect(ui.getPaginationRange({ current: 1, total: 3 })).toEqual([1, 2, 3]);
    expect(ui.nextRovingIndex({ current: 0, count: 2, key: "ArrowRight" })).toBe(1);
    expect(ui.resolveTrapTarget(["a", "b"], "b", false)).toBe("a");
  });

  it("exporta las variantes de cva, que es lo que consume la app para componer", () => {
    for (const name of [
      "avatarVariants",
      "badgeVariants",
      "buttonVariants",
      "cardVariants",
      "dialogVariants",
      "drawerVariants",
      "emptyStateVariants",
      "errorStateVariants",
      "inputVariants",
      "paginationVariants",
      "selectVariants",
      "skeletonVariants",
      "spinnerVariants",
      "switchVariants",
      "textareaVariants",
      "toastVariants",
      "tooltipVariants",
    ] as const) {
      expect(ui[name], name).toBeTypeOf("function");
    }
  });

  it("exporta los presets de estado del PRD §19", () => {
    expect(Object.keys(ui.emptyStatePresets)).toHaveLength(13);
    expect(ui.errorStatePresets.generic.titleKey).toBe("common.somethingWentWrong");
  });
});
