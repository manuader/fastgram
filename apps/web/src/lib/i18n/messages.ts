/**
 * Catálogo de copy **local de `apps/web`**.
 *
 * El catálogo canónico vive en `@fastgram/ui` (`packages/ui/src/i18n/messages.ts`)
 * y sale del PRD §19 / §3.5. Este archivo **sólo** añade las claves que la shell
 * necesita y ese catálogo no trae, porque esta tarea no puede escribir en
 * `packages/ui`.
 *
 * Procedencia, con la misma convención que el catálogo de `ui`:
 *
 *   · `literal`  → copiado tal cual del PRD (línea citada).
 *   · `nuevo`    → **lo escribió esta sesión**. El PRD no lo trae. Es candidato
 *                  a revisión: si el producto original tiene otra palabra, gana
 *                  la del producto.
 *
 * Cuando `packages/ui` se pueda tocar, lo `literal` de aquí debería migrar allí
 * y este archivo quedarse sólo con lo que sea específico de la shell.
 */

export const webEn = {
  /* ------------------------------------------------- navegación · PRD §3.2 */
  // Los 17 labels del sidebar son literales del PRD:293-338.
  "nav.home": "Home", // literal
  "nav.engagement": "Engagement", // literal
  "nav.blitz": "Blitz", // literal
  "nav.aiStudio": "AI Studio", // literal
  "nav.influencers": "Influencers", // literal
  "nav.content": "Content", // literal
  "nav.library": "Library", // literal
  "nav.calendar": "Calendar", // literal
  "nav.analytics": "Analytics", // literal
  "nav.warmedAccounts": "Warmed Accounts", // literal
  "nav.admin": "Admin", // literal (gateado por rol; PRD dice omitir en el clon)
  "nav.referAndEarn": "Refer & Earn", // literal
  "nav.brand": "Brand", // literal
  "nav.guide": "Guide", // literal
  "nav.feedback": "Feedback", // literal
  "nav.discord": "Discord", // literal
  "nav.settings": "Settings", // literal

  "nav.primaryLabel": "Main", // nuevo · sólo para lectores de pantalla
  "nav.secondaryLabel": "More", // nuevo · sólo para lectores de pantalla
  "nav.collapse": "Collapse sidebar", // nuevo
  "nav.expand": "Expand sidebar", // nuevo
  "nav.openMenu": "Open menu", // nuevo
  "nav.closeMenu": "Close menu", // nuevo
  "nav.menu": "Menu", // nuevo
  "nav.actionRequired": "Action required", // nuevo · el punto rojo de Settings (PRD:338)
  "nav.opensInNewTab": "Opens in a new tab", // nuevo
  "a11y.skipToContent": "Skip to content", // nuevo

  /* -------------------------------------------- soporte · PRD §3.2 (PRD:340) */
  "support.label": "Support", // nuevo · el PRD describe la burbuja, no su label

  /* ----------------------------------------------------------------- tema */
  "theme.label": "Theme", // nuevo
  "theme.light": "Light", // nuevo
  "theme.dark": "Dark", // nuevo
  "theme.system": "System", // nuevo

  /* ------------------------------------------- Home · FR-030 (PRD:1027-1054) */
  "home.title": "Home", // literal (label de la ruta)
  "home.kpi.engagedLeads": "Engaged Leads", // literal PRD:1034
  "home.kpi.contentPosted": "Content Posted", // literal PRD:1034
  "home.kpi.totalViews": "Total Views", // literal PRD:1034
  "home.kpi.totalLikes": "Total Likes", // literal PRD:1034
  "home.kpi.totalComments": "Total Comments", // literal PRD:1034
  "home.tasks.title": "Tasks", // literal PRD:1035
  "home.tasks.completed": "Completed {count}", // literal PRD:1035 (`Completed N`)
  "home.tasks.suggested": "Suggested", // literal PRD:1035
  "home.tasks.replyToLeads": "Reply to leads", // literal PRD:1035
  "home.tasks.progress": "{done}/{total}", // literal PRD:1035 (`0/5`)
  "home.viewsHistory.title": "Views History", // literal PRD:1036
  "home.viewsHistory.enableAnalytics": "Enable website analytics", // literal PRD:1036
  "home.viewsHistory.monthly": "Monthly", // literal PRD:1036
  "home.trending.title": "Trending Content", // literal PRD:1037
  "home.faq.title": "FAQ", // literal PRD:1038 / F-037 PRD:470
  "home.faq.answerMissing":
    "The PRD records this question but not its answer. Nothing is written here on purpose.", // nuevo
  "home.kpi.unavailable": "Not available yet", // nuevo
  "home.kpi.partial":
    "Totals cover the first {limit} published posts. The API has no aggregate endpoint yet.", // nuevo

  /* --------------------------------------- huecos conocidos de la shell */
  // `nuevo`: el PRD describe la pantalla pero el contrato v1 no tiene endpoint.
  // Decir esto en pantalla es preferible a dibujar un número inventado.
  "placeholder.noEndpoint.title": "Not wired up yet", // nuevo
  "placeholder.noEndpoint.description":
    "The API contract has no endpoint for this yet. The screen is laid out; the data is not connected.", // nuevo
  "placeholder.notBuilt.title": "{screen} is not built yet", // nuevo
  "placeholder.notBuilt.description":
    "This route exists so navigation and guards work end to end. The screen lands with its own task.", // nuevo
  "placeholder.specLabel": "Spec", // nuevo
  "placeholder.taskLabel": "Task", // nuevo

  /* -------------------------------------------- errores sin copy en el PRD */
  // El PRD §19.6 da el **código** de estos errores pero no el texto de pantalla.
  // Todo lo de este bloque es `nuevo`.
  "error.badRequest.title": "That request wasn't valid",
  "error.conflict.title": "This changed somewhere else. Reload and try again.",
  "error.gone.title": "This is no longer available",
  "error.notFound.title": "We couldn't find that",
  "error.serviceUnavailable.title": "That service isn't responding. Try again shortly.",
  "error.contentStillBuilding.title": "This content is still building",
  "error.contentEditInProgress.title":
    "Another edit is in progress. Wait for it to finish.",
  "error.staleRevision.title": "You're editing an old version. Reload to get the latest.",
  "error.contentNotEditable.title": "This content can't be edited",
  "error.contentHasLinkedPosts.title":
    "Delete the linked posts first — cancelling them isn't enough.",
  "error.contentUnavailableForType.title": "That isn't available for this content type",
  "error.companyProfileNotReady.title": "Finish your profile in Brand to continue",
  "error.unsupportedContentState.title": "This content isn't in a state that allows that",
  "error.connectionAmbiguous.title": "Pick which connected account to post from",
  "error.postingModeNotSupported.title":
    "That posting mode isn't supported on this platform",
  "error.privacyLevelRequired.title": "Choose a privacy level to post directly",
  "error.invalidPrivacyLevel.title": "That privacy level isn't valid for this account",
  "error.privacyLevelNotAllowed.title":
    "Privacy level only applies when posting directly",
  "error.tiktokCreatorInfoUnavailable.title":
    "Couldn't load TikTok posting options. Reconnect TikTok in Settings, or retry.", // literal ERR-D09 PRD:3160
  "error.platformPostLimit.title": "You've hit this platform's posting limit",
  "error.maxAngles.title": "You've reached the maximum number of angles",
  "error.maxAnglesPerInfluencer.title":
    "You've reached the maximum number of angles for this influencer",
  "error.network.title": "We couldn't reach the server. Check your connection.",
  "error.invalidResponse.title": "The server sent something we couldn't read",
  "error.timeout.title": "That took too long. Try again.",

  /* ---------------------------------------------- salidas de un error · §19 */
  // `nuevo`: el PRD nombra la acción (`Upgrade`, `Reload`) dentro del copy de
  // cada error, pero no da un label de botón suelto para reutilizar.
  "action.reload": "Reload", // nuevo
  "action.goToBrand": "Go to Brand", // nuevo · ERR-P08 manda al perfil de empresa
  // El `resetAt` del 402 (§16.2) es lo que separa "no podés" de "podés el 15".
  "error.quota.resetsAt": "Your quota resets on {date}.", // nuevo

  /* ------------------------------------------------- Library · FR-100 §3.3 */
  "library.title": "Library", // literal (label de la ruta, PRD:304)
  "library.tab.myPosts": "My Posts", // literal PRD:332
  "library.tab.myContent": "My Content", // literal PRD:332
  "library.tab.myMediaBank": "My Media Bank", // literal PRD:332
  // PRD:1612 — el contador de la cabecera de `My Content` (`78 items`).
  "library.itemCount": "{count} items", // literal (forma)
  "library.itemCountOne": "1 item", // nuevo · el PRD sólo muestra el plural
  // El contador del PRD (`78 items`) es el total del workspace, y `GET /content`
  // no devuelve ningún total: sólo una página y `hasMore`. Mientras haya más,
  // decir `78 items` sería afirmar un número que nadie calculó.
  "library.itemCountPartial": "{count} items loaded", // nuevo
  // PRD:1612 — `Created: DD/MM/YY` en el pie de cada tarjeta.
  "library.card.created": "Created: {date}", // literal
  "library.loadMore": "Load more", // nuevo · el PRD no muestra el control de paginación de esta tab
  "library.loadingMore": "Loading more…", // nuevo
  "library.building": "Building…", // nuevo · estado `BUILDING` (DATA-008)
  "library.buildingHint":
    "This piece is still being built. The page checks again every few seconds.", // nuevo
  "library.failed": "Build failed", // nuevo · estado `FAILED`
  "library.empty.title": "No content yet", // nuevo · el PRD dice "estado vacío" sin dar el texto (PRD:2730)
  "library.empty.description":
    "Content you create in the Studio or approve in Blitz shows up here.", // nuevo
  "library.empty.action": "Create content", // nuevo
  // Un vacío con filtros puestos no es el mismo vacío: la salida es otra.
  "library.empty.filteredDescription":
    "No content matches these filters. Clear them to see everything.", // nuevo
  "library.empty.clearFilters": "Clear filters", // nuevo
  // PRD:1607 — los labels del badge de tipo, literales de la tarjeta de Library.
  "library.type.slideshow": "Slideshow", // literal
  "library.type.wallOfText": "Wall of Text", // literal
  "library.type.greenScreen": "Green Screen", // literal
  "library.type.videoHook": "Video Hook", // literal
  "library.type.custom": "Custom", // literal F-070 (PRD:532)
  // DATA-008 (PRD:2076) da el enum, no el texto de pantalla: los tres son `nuevo`.
  "library.status.building": "Building", // nuevo
  "library.status.created": "Created", // nuevo
  "library.status.failed": "Failed", // nuevo
  // El hueco de DATA-008: la tarjeta del PRD lleva `Created: DD/MM/YY` y el
  // contrato no publica ninguna fecha. Se dice una vez, no por tarjeta.
  "library.noCreatedAt":
    "The API doesn't return a creation date for content yet, so the cards don't show one.", // nuevo
  "library.filter.allTypes": "All types", // nuevo
  "library.filter.allStatuses": "All statuses", // nuevo
  "library.filter.typeLabel": "Type", // nuevo
  "library.filter.statusLabel": "Status", // nuevo
  "library.backToLibrary": "Back to Library", // nuevo
  "library.detail.notFound": "That content doesn't exist, or it isn't yours.", // nuevo · §9.2: ajeno e inexistente son lo mismo
  "library.detail.caption": "Caption", // nuevo · `generatedText` de DATA-008
  "library.detail.noCaption": "No caption was generated for this piece.", // nuevo
  "library.detail.remixSource": "Remixed from", // nuevo
  "library.detail.files": "{count} files", // nuevo
  "library.detail.noFiles": "This piece has no files yet.", // nuevo
  "library.detail.revision": "Revision {revision}", // nuevo
  "library.detail.openFile": "Open file {index}", // nuevo
  // Las dos tabs que esta tarea no cableó. Decirlo es mejor que una tab muerta.
  "library.tab.notWired": "{tab} is not wired up yet", // nuevo
  "library.tab.notWiredDescription":
    "The route and the API endpoint exist; this tab lands with its own task.", // nuevo
} as const;

export type WebMessageKey = keyof typeof webEn;
