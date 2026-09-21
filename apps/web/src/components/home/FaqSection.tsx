import { HOME_FAQ } from "@/lib/home/faq";
import { tw } from "@/lib/i18n/t";

/**
 * FAQ del Home · `P1-UI-010` / F-037 (PRD:1047-1052).
 *
 * `<details>`/`<summary>` nativos y no un acordeón propio: el navegador ya trae
 * el teclado, el `aria-expanded`, el anuncio del estado y la búsqueda en página
 * (Chrome abre un `<details>` cerrado al encontrar texto dentro). Un acordeón a
 * medida pierde las cuatro cosas y no gana ninguna.
 *
 * **Las preguntas son copy literal del PRD.** Las respuestas no existen: el PRD
 * registra las 39 preguntas y ninguna respuesta, así que cada panel lo dice.
 * Escribir respuestas plausibles aquí sería meter contenido de producto
 * inventado en la pantalla más visitada de la app.
 */
export function FaqSection() {
  return (
    <section className="fgw-faq" aria-labelledby="faq-title">
      <h2 id="faq-title" className="fgw-faq__title">
        {tw("home.faq.title")}
      </h2>

      {HOME_FAQ.map((category) => (
        <div key={category.title} className="fgw-faq__category">
          <h3 className="fgw-faq__category-title">{category.title}</h3>
          <ul className="fgw-faq__list">
            {category.questions.map((question) => (
              <li key={question} className="fgw-faq__item">
                <details className="fgw-faq__details">
                  <summary className="fgw-faq__summary fg-focusable">{question}</summary>
                  <p className="fgw-faq__answer">{tw("home.faq.answerMissing")}</p>
                </details>
              </li>
            ))}
          </ul>
        </div>
      ))}
    </section>
  );
}
