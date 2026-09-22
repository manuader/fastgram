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

  /* ------------------------------------------- status page · F-255 (PRD:721) */
  // El PRD dice "estado del servicio" y no da ni un texto, así que todo este
  // bloque es `nuevo`. Lo que sí es normativo es lo que **no** dice: ninguna
  // de estas cadenas nombra una dependencia interna. El porqué está en
  // `lib/status/health.ts`.
  "status.title": "Status", // literal (label de la ruta, PRD:259)
  "status.ok.title": "All systems operational", // nuevo
  "status.ok.description": "FastGram is running normally.", // nuevo
  "status.degraded.title": "Partial degradation", // nuevo
  "status.degraded.description":
    "Some features may be unavailable or slower than usual. The rest of FastGram is working.", // nuevo
  "status.unavailable.title": "Major outage", // nuevo
  "status.unavailable.description": "FastGram can't serve requests right now.", // nuevo
  "status.checkedAt": "Last checked at {time} UTC", // nuevo
  "status.scope":
    "This page reports the overall state of the service. It doesn't break it down by component.", // nuevo

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

  /* --------------------------------- My Posts · F-120, FR-100 (PRD:1603-1611) */
  "posts.filter.statusLabel": "Status", // nuevo
  "posts.filter.allStatuses": "All statuses", // nuevo
  // PRD:1605 — el contador de la derecha de la cabecera (`101 posts`).
  "posts.count": "{count} posts", // literal (forma)
  "posts.countOne": "1 post", // nuevo · el PRD sólo muestra el plural
  // `GET /posts` no devuelve un total, sólo una página y `hasMore`: decir
  // `101 posts` con más páginas por venir sería afirmar un número que nadie
  // calculó. Mismo criterio que en `My Content` y el Media Bank.
  "posts.countPartial": "{count} posts loaded", // nuevo
  "posts.loadMore": "Load more", // nuevo
  "posts.loadingMore": "Loading more…", // nuevo

  "posts.empty.title": "No posts", // literal §12 (PRD:2729)
  "posts.empty.description":
    "Schedule a piece of content and the post shows up here with its metrics.", // nuevo
  "posts.empty.action": "Create content", // nuevo
  "posts.empty.filteredDescription":
    "No posts match this status. Clear the filter to see everything.", // nuevo
  "posts.empty.clearFilter": "Clear filter", // nuevo

  // El hueco declarado de esta tab: `GET /posts` no publica nada de la pieza
  // más allá de su id, así que el thumbnail y el badge de tipo de PRD:1607-1608
  // no se pueden dibujar sin una petición por post.
  "posts.noContentFields":
    "Posts don't carry the thumbnail or the content type yet, so those aren't shown here.", // nuevo

  "posts.platform.tiktok": "TikTok", // literal
  "posts.platform.instagram": "Instagram", // literal
  "posts.platform.youtube": "YouTube", // literal
  "posts.platform.reddit": "Reddit", // literal

  // Los diez estados de FR-060 (PRD:1387). El enum es normativo; el texto de
  // pantalla no está en el PRD, así que los diez son `nuevo`.
  "posts.status.building": "Building", // nuevo
  "posts.status.created": "Created", // nuevo
  "posts.status.scheduled": "Scheduled", // nuevo
  "posts.status.uploading": "Uploading to TikTok", // nuevo
  "posts.status.inUserInbox": "Waiting in your TikTok inbox", // nuevo · PRD:1390
  "posts.status.posted": "Posted", // nuevo
  "posts.status.failed": "Failed", // nuevo
  "posts.status.deleted": "Deleted", // nuevo
  "posts.status.awaitingReconnect": "Waiting for reconnect", // nuevo · PRD:1391
  "posts.status.cancelled": "Cancelled", // nuevo

  "posts.account.oauth": "Connected account", // nuevo
  "posts.account.warmed": "Warmed account", // nuevo

  // PRD:1608 — `Posted: DD/MM/YY` y `Scheduled: hh:mm am/pm, DD/MM/YY`. El
  // `UTC` del segundo lo agrega esta sesión: ver `lib/library/posts.ts`.
  "posts.postedAt": "Posted: {date}", // literal PRD:1608
  "posts.scheduledAt": "Scheduled: {time} UTC, {date}", // literal (forma) + zona

  // PRD:1610 — `views N · likes N · comments N`, con iconos.
  "posts.metric.views": "views {count}", // literal
  "posts.metric.likes": "likes {count}", // literal
  "posts.metric.comments": "comments {count}", // literal

  "posts.viewOnPlatform": "View on {platform}", // nuevo

  // Las tres notas que FR-060 documenta con consecuencia. La de TikTok es la
  // cara: reprogramar con el flag puesto crea un duplicado (PRD:1392).
  "posts.notice.inUserInbox":
    "TikTok accepted it as a draft. It isn't live until you open the app and post it from Inbox → System notifications.", // nuevo · PRD:1390
  "posts.notice.tiktokDelayed":
    "TikTok is processing this one slowly — it usually publishes on its own within 48h. Don't reschedule it, that would post it twice.", // nuevo · PRD:1392
  "posts.notice.cancelling": "Cancelling. It resolves on its own; retrying doesn't help.", // nuevo · PRD:1395

  /* ------------------------------------ Media Bank · FR-100 (PRD:1618-1626) */
  "media.filter.typeLabel": "Type", // nuevo
  "media.filter.allTypes": "All", // literal PRD:1623 (segmented `All · Images · Videos`)
  "media.type.image": "Images", // literal PRD:1623
  "media.type.video": "Videos", // literal PRD:1623
  "media.itemCount": "{count} items", // literal PRD:1623 (`41 items`)
  "media.itemCountOne": "1 item", // nuevo · el PRD sólo muestra el plural
  // Mismo motivo que en `My Content`: `GET /media` no devuelve un total, sólo
  // una página y `hasMore`. Decir `41 items` con más páginas por venir sería
  // afirmar un número que nadie calculó.
  "media.itemCountPartial": "{count} items loaded", // nuevo
  "media.loadMore": "Load more", // nuevo
  "media.loadingMore": "Loading more…", // nuevo
  // ERR-E04 (PRD §19.1) — literal. El PRD dice `No images uploaded yet` aunque
  // el bank acepte también video: es el copy observado y no se corrige.
  "media.empty.title": "No images uploaded yet", // literal ERR-E04
  "media.empty.description":
    "Upload images or videos and they show up here, ready for Blitz and the Studio.", // nuevo
  "media.empty.filteredDescription":
    "No media matches this filter. Clear it to see everything.", // nuevo
  "media.empty.clearFilters": "Clear filter", // nuevo
  "media.uploadHint":
    "Uploading happens from this screen in its own task; this one lists what's already there.", // nuevo
  // PRD:1626 — el pie de cada tarjeta es `<size> MB · <fecha>`.
  "media.card.meta": "{size} MB · {date}", // literal (forma)
  "media.category.uncategorized": "Uncategorized", // literal PRD:1626
  "media.category.slideshowImage": "slide", // literal PRD:1628 (badge de la grid)
  "media.category.greenScreenBackground": "green screen bg", // nuevo
  "media.category.backgroundVideo": "bg", // literal PRD:1626
  "media.category.hookVideo": "hook", // literal PRD:1626
  "media.category.greenScreenVideo": "green screen", // nuevo
  // DATA-010 (PRD:2093) da el enum, no el texto de pantalla: los tres son `nuevo`.
  "media.status.processing": "Processing", // nuevo
  "media.status.failed": "Upload failed", // nuevo
  "media.status.ready": "Ready", // nuevo
  "media.videoNoPreview": "Video", // nuevo · el contrato no publica poster de video
  "media.durationLabel": "Duration {duration}", // nuevo · sólo para lectores de pantalla

  /* --------------------------------- Blitz Settings · FR-055 (PRD:1255-1300) */
  "prefs.title": "Blitz Settings", // literal (label de la ruta, PRD:260)
  // PRD:1265 — el banner persistente de auto-guardado, literal.
  "prefs.saved": "All changes saved", // literal
  "prefs.pending": "Unsaved changes", // nuevo
  "prefs.pendingHint": "They'll be saved automatically in a moment.", // nuevo
  "prefs.saving": "Saving…", // nuevo
  "prefs.saveFailedHint": "Your change is still here — it just isn't saved yet.", // nuevo
  "prefs.blocked":
    "{group} doesn't add up to 100 yet, so it isn't being saved. Adjust it to continue.", // nuevo
  "prefs.group.contentMix": "Content mix", // literal PRD:1263
  "prefs.group.textStyleWeights": "Caption style mix", // literal PRD:1277

  "prefs.section.contentMix": "Content mix", // literal PRD:1263
  "prefs.section.contentMixHint":
    "How often Blitz picks each format. The four always add up to 100 — moving one rebalances the rest.", // nuevo
  "prefs.section.ratios": "Sources & tone", // nuevo
  "prefs.section.influencers": "Influencers", // literal PRD:1259
  "prefs.section.captions": "Captions", // nuevo
  "prefs.section.captionsHint":
    "A style mix fixes the look of every generated caption. Off means Blitz picks.", // nuevo

  "prefs.mix.slideshow": "Slideshow", // literal PRD:1263
  "prefs.mix.wallOfText": "Wall of text", // literal PRD:1263
  "prefs.mix.greenScreen": "Green screen", // literal PRD:1263
  "prefs.mix.videoHook": "Hook demo videos", // literal PRD:1263

  "prefs.ratio.remix": "Remix ratio", // literal PRD:1270
  "prefs.ratio.ownMedia": "Own media vs shared library", // literal PRD:1271
  "prefs.ratio.mentionBusiness": "Mention business", // literal PRD:1272
  "prefs.ratio.influencerChance": "Influencer frequency", // literal PRD:1260
  "prefs.ratio.influencerChanceHint":
    "What share of Blitz suggestions feature one of your trained influencers.", // literal PRD:1260

  "prefs.smartText": "Smart text positioning", // literal PRD:1274
  "prefs.smartTextHint":
    "Let the renderer move captions away from faces and busy parts of the frame.", // nuevo
  "prefs.gender.label": "Gender filter", // literal PRD:1275
  "prefs.gender.any": "No filter", // nuevo · el `null` de FR-055
  "prefs.gender.man": "Man", // literal PRD:1275
  "prefs.gender.woman": "Woman", // literal PRD:1275

  "prefs.styleMix.toggle": "Caption style mix", // literal PRD:1277
  "prefs.styleMix.off": "Off — Blitz picks a style per generation.", // nuevo
  "prefs.style.tiktokClassic": "TikTok classic", // literal PRD:1279 (id `tiktok-classic`)
  "prefs.style.boldImpact": "Bold impact", // literal PRD:1279
  "prefs.style.snapchat": "Snapchat", // literal PRD:1279
  "prefs.style.whiteBox": "White box", // literal PRD:1279
  "prefs.style.yellowPop": "Yellow pop", // literal PRD:1279
  "prefs.style.cleanKaraoke": "Clean karaoke", // literal PRD:1279
  "prefs.style.scriptPlayful": "Script playful", // literal PRD:1279

  // FR-055 regla 1 (PRD:1283) — lo que el usuario necesita saber al guardar.
  "prefs.application":
    "Changes apply to future generations only. The {count} items already queued are kept.", // nuevo
  // Los dos huecos declarados de esta pantalla.
  "prefs.angleWeightsMissing":
    "Angle weights are part of these settings but aren't edited here yet: they have to cover every active angle, and this screen has no way to list them.", // nuevo
  "prefs.sum": "{sum} / 100", // nuevo
} as const;

export type WebMessageKey = keyof typeof webEn;
