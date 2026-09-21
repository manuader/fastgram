import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Dialog, DialogTitle } from "./Dialog.js";

describe("Dialog (markup)", () => {
  it("cerrado no renderiza nada", () => {
    expect(
      renderToStaticMarkup(
        <Dialog open={false} onClose={() => {}}>
          <DialogTitle>Select Video</DialogTitle>
        </Dialog>,
      ),
    ).toBe("");
  });

  it("abierto tampoco renderiza en servidor: el portal necesita document", () => {
    // Documentado a propósito: el diálogo se monta sólo en cliente, así que en
    // SSR no hay salto de layout ni un portal a un body que no existe.
    expect(
      renderToStaticMarkup(
        <Dialog open onClose={() => {}}>
          <DialogTitle>Select Video</DialogTitle>
        </Dialog>,
      ),
    ).toBe("");
  });
});
