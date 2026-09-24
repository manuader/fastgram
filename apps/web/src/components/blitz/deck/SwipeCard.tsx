"use client";

import {
  animate,
  motion,
  useDragControls,
  useMotionValue,
  useTransform,
  type PanInfo,
} from "motion/react";
import { useEffect, type PointerEvent as ReactPointerEvent } from "react";
import { td } from "@/lib/blitz/deck/copy";
import { decisionFromDrag, type Decision } from "@/lib/blitz/deck/gestures";
import type { DeckCard } from "@/lib/blitz/deck/suggestion";
import { CardFace } from "./CardFace";

/**
 * La tarjeta de arriba del deck: la que se arrastra (F-051).
 *
 * ## Física
 *
 * El arrastre es libre en x y **vuelve al centro** al soltar si no decidió
 * (`dragSnapToOrigin`, con el resorte por defecto de motion). La rotación y los
 * sellos `Accept`/`Skip` salen del mismo `x`: son transformaciones del
 * desplazamiento, no estado de React, así que arrastrar no re-renderiza nada.
 *
 * La salida la anima quien monta la tarjeta (`AnimatePresence` en el deck), con
 * la dirección de la decisión en `custom`: acá sólo se decide.
 *
 * ## Qué inicia un arrastre
 *
 * Todo menos los controles de la tarjeta (`data-no-drag`: mute, flechas de
 * slide). Con el listener por defecto de motion, apretar una flecha de slide
 * y mover un poco el dedo arrastraba la tarjeta entera.
 *
 * ## `prefers-reduced-motion`
 *
 * Sin rotación ni resorte: la tarjeta se sigue pudiendo arrastrar —es la
 * interacción, no un adorno— pero no gira, y las salidas son un fundido corto
 * (ver `exitVariants`).
 */
export interface SwipeCardProps {
  readonly card: DeckCard;
  readonly label: string;
  readonly reducedMotion: boolean;
  /** `true` mientras el diálogo de aceptar está abierto: la tarjeta queda inclinada. */
  readonly leaning: boolean;
  readonly onDecide: (decision: Decision) => void;
}

/** Lo que viaja en `custom`: `dir` es `1` (derecha), `-1` (izquierda) o `0`. */
export interface ExitCustom {
  readonly dir: number;
  readonly reduced: boolean;
}

/** Entrada y salida de la tarjeta de arriba. */
export const exitVariants = {
  initial: ({ reduced }: ExitCustom) =>
    reduced ? { opacity: 0 } : { opacity: 0, scale: 0.94, y: 16 },
  enter: { opacity: 1, scale: 1, y: 0 },
  exit: ({ dir, reduced }: ExitCustom) =>
    reduced
      ? { opacity: 0, transition: { duration: 0.12 } }
      : {
          x: dir * 560,
          rotate: dir * 18,
          opacity: 0,
          transition: { type: "spring" as const, stiffness: 260, damping: 30 },
        },
};

export function SwipeCard({
  card,
  label,
  reducedMotion,
  leaning,
  onDecide,
}: SwipeCardProps) {
  const x = useMotionValue(0);
  const rotate = useTransform(
    x,
    [-240, 0, 240],
    reducedMotion ? [0, 0, 0] : [-14, 0, 14],
  );
  const acceptOpacity = useTransform(x, [24, 120], [0, 1]);
  const skipOpacity = useTransform(x, [-120, -24], [1, 0]);
  const controls = useDragControls();

  // Con el diálogo abierto la tarjeta queda un poco hacia la derecha: el usuario
  // ve que está aceptando *ésta*. Al cancelar vuelve al centro.
  useEffect(() => {
    const target = leaning && !reducedMotion ? 48 : 0;
    const animation = animate(x, target, { type: "spring", stiffness: 320, damping: 28 });
    return () => {
      animation.stop();
    };
  }, [leaning, reducedMotion, x]);

  function onPointerDown(event: ReactPointerEvent<HTMLDivElement>): void {
    const target = event.target as HTMLElement | null;
    if (target?.closest("[data-no-drag]") != null) return;
    controls.start(event);
  }

  function onDragEnd(_event: unknown, info: PanInfo): void {
    const decision = decisionFromDrag(info.offset.x, info.velocity.x);
    if (decision === null) return;
    onDecide(decision);
  }

  return (
    <motion.div
      role="group"
      aria-roledescription="card"
      aria-label={label}
      data-testid="deck-top-card"
      className="absolute inset-0 touch-pan-y select-none overflow-hidden rounded-2xl shadow-lg"
      style={{ x, rotate, cursor: "grab" }}
      drag="x"
      dragListener={false}
      dragControls={controls}
      dragSnapToOrigin
      dragElastic={0.9}
      whileDrag={{ cursor: "grabbing" }}
      onPointerDown={onPointerDown}
      onDragEnd={onDragEnd}
      variants={exitVariants}
      custom={{ dir: 0, reduced: reducedMotion } satisfies ExitCustom}
      initial="initial"
      animate="enter"
      exit="exit"
    >
      <CardFace card={card} interactive />

      <motion.span
        aria-hidden="true"
        className="pointer-events-none absolute right-4 top-12 rounded-md border-4 px-3 py-1 text-2xl font-black uppercase tracking-wider"
        style={{
          opacity: acceptOpacity,
          rotate: 12,
          color: "var(--fg-color-success)",
          borderColor: "var(--fg-color-success)",
          background: "rgba(0,0,0,.35)",
        }}
      >
        {td("deck.indicator.accept")}
      </motion.span>
      <motion.span
        aria-hidden="true"
        className="pointer-events-none absolute left-4 top-12 rounded-md border-4 px-3 py-1 text-2xl font-black uppercase tracking-wider"
        style={{
          opacity: skipOpacity,
          rotate: -12,
          color: "var(--fg-color-danger)",
          borderColor: "var(--fg-color-danger)",
          background: "rgba(0,0,0,.35)",
        }}
      >
        {td("deck.indicator.skip")}
      </motion.span>
    </motion.div>
  );
}
