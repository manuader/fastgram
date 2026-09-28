-- Sprint 9, tanda 2 (agente T, `PU-S9-015`): «Edit» del deck → `edit_before_accept`.
--
-- El botón «Edit» del deck acepta la sugerencia y abre el editor. Esa
-- aceptación se guarda como `edit_before_accept` **sin aspecto** (la pieza
-- entera, con todos sus rasgos en `added` y peso 0,5): el dueño la quiso, pero
-- distinta. La 0039 (Q) exigía aspecto en toda edición; esto suma esa única
-- excepción. Las ediciones por aspecto siguen igual.
--
-- La selección del refill no necesita tablas nuevas: `asset_decisions` (0037)
-- ya guarda la fuente de cada candidato (`candidates[].source`: `brand` |
-- `library`) y, desde este sprint, el multiplicador del gusto de cada uno
-- (`scored[].preference`, jsonb).
ALTER TABLE "preference_signals" DROP CONSTRAINT "preference_signals_edit_has_aspect_check";
--> statement-breakpoint
ALTER TABLE "preference_signals" ADD CONSTRAINT "preference_signals_edit_has_aspect_check"
  CHECK (
    (("kind" IN ('accept', 'discard')) = ("aspect" = ''))
    OR ("kind" = 'edit_before_accept' AND "aspect" = '')
  );
