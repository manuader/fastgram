/**
 * El menú del selector de marca · ERR-E10 (`P5-ERR-001`) y roles del menú.
 *
 * `useWorkspace` y `useShellActions` van mockeados: lo que se prueba es qué
 * muestra el menú según cuántas marcas hay, no el provider (ése tiene su test).
 */
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type * as Provider from "./WorkspaceProvider";

type Ctx = ReturnType<typeof Provider.useWorkspace>;
let ctx: Ctx;

vi.mock("./WorkspaceProvider", () => ({ useWorkspace: () => ctx }));
vi.mock("@/components/shell/ShellActions", () => ({
  useShellActions: () => ({ openNewBrand: vi.fn() }),
}));

import { BrandSwitcher } from "./BrandSwitcher";

function brand(id: string, name: string) {
  return { id, name, logoUrl: null, profileStatus: "ready" } as unknown as NonNullable<
    Ctx["active"]
  >;
}

function setBrands(list: ReturnType<typeof brand>[]): void {
  ctx = {
    mode: "personal",
    isPersonal: true,
    workspaces: {
      data: list,
      isPending: false,
      isSuccess: true,
      isError: false,
      refetch: vi.fn(),
    },
    active: list[0] ?? null,
    selectedId: list[0]?.id ?? null,
    switchTo: vi.fn(),
    forget: vi.fn(),
  } as unknown as Ctx;
}

beforeEach(() => {
  setBrands([brand("a", "Acme")]);
});

async function openMenu(): Promise<HTMLElement> {
  const user = userEvent.setup();
  await user.click(screen.getByRole("button", { expanded: false }));
  return screen.findByRole("menu");
}

describe("BrandSwitcher", () => {
  it("con una sola marca dice ERR-E10 literal y ofrece crear otra", async () => {
    render(<BrandSwitcher collapsed={false} />);
    const menu = await openMenu();
    expect(menu).toHaveTextContent("No other workspace available");
    expect(screen.getByRole("menuitemradio", { name: /Acme/ })).toHaveAttribute(
      "aria-checked",
      "true",
    );
  });

  it("con dos marcas no lo dice", async () => {
    setBrands([brand("a", "Acme"), brand("b", "Beta")]);
    render(<BrandSwitcher collapsed={false} />);
    const menu = await openMenu();
    expect(menu).not.toHaveTextContent("No other workspace available");
    expect(screen.getAllByRole("menuitemradio")).toHaveLength(2);
  });
});
