import type { ReactNode } from "react";
import { tw } from "@/lib/i18n/t";

export interface RoutePlaceholderProps {
  /** Nombre de la pantalla tal y como lo escribe el PRD. */
  screen: string;
  /** Referencias del PRD que la especifican: `PRD §3.1 · FR-040`. */
  spec: string;
  /** Id de `tasks.md` que la va a construir, si se sabe. */
  task?: string;
  /** Lo que haya que decir además — un hueco del contrato, un matiz. */
  children?: ReactNode;
}

/**
 * Marcador de una ruta que existe pero cuya pantalla no.
 *
 * La razón de que sea un componente y no un `<p>Coming soon</p>` suelto: un
 * placeholder honesto tiene que decir **tres** cosas —qué pantalla es, qué
 * parte del PRD la describe y qué tarea la va a construir— porque el que llega
 * después necesita las tres para no volver a buscarlas. "Coming soon" no dice
 * ninguna.
 *
 * No inventa UI. Si el PRD no describe la pantalla, aquí no se dibuja.
 */
export function RoutePlaceholder({
  screen,
  spec,
  task,
  children,
}: RoutePlaceholderProps) {
  return (
    <section className="fgw-placeholder" aria-labelledby="placeholder-title">
      <h1 id="placeholder-title" className="fgw-placeholder__title">
        {tw("placeholder.notBuilt.title", { screen })}
      </h1>
      <p className="fgw-placeholder__description">
        {tw("placeholder.notBuilt.description")}
      </p>
      <dl className="fgw-placeholder__meta">
        <div className="fgw-placeholder__row">
          <dt>{tw("placeholder.specLabel")}</dt>
          <dd>{spec}</dd>
        </div>
        {task !== undefined && (
          <div className="fgw-placeholder__row">
            <dt>{tw("placeholder.taskLabel")}</dt>
            <dd>
              <code>{task}</code>
            </dd>
          </div>
        )}
      </dl>
      {children !== undefined && <div className="fgw-placeholder__note">{children}</div>}
    </section>
  );
}
