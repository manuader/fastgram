import type { ReactNode } from "react";

export interface PageHeaderProps {
  title: string;
  description?: string;
  actions?: ReactNode;
}

/**
 * Encabezado de pantalla.
 *
 * El `<h1>` vive aquí y sólo aquí: una pantalla con dos `h1` —o con ninguno—
 * deja sin punto de entrada a quien navega por encabezados.
 */
export function PageHeader({ title, description, actions }: PageHeaderProps) {
  return (
    <header className="fgw-page-header">
      <div className="fgw-page-header__text">
        <h1 className="fgw-page-header__title">{title}</h1>
        {description !== undefined && (
          <p className="fgw-page-header__description">{description}</p>
        )}
      </div>
      {actions !== undefined && <div className="fgw-page-header__actions">{actions}</div>}
    </header>
  );
}
