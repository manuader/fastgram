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
  "nav.inspiration": "Inspiration", // literal (sidebar de Fastlane)
  "nav.blitz": "Blitz", // literal
  "nav.aiStudio": "AI Studio", // literal
  "nav.influencers": "Influencers", // literal
  "nav.models": "Models", // nuevo (sprint 8, K): biblioteca de modelos del dueño
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
  // El `resetAt` del 429 de cuota (§16.2, ERR-R02/R03) es lo que separa "no
  // podés" de "podés el 15".
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
  "library.detail.edit": "Edit", // nuevo · PU-EDIT-003
  "brandKit.generate": "Generate brand backgrounds", // nuevo · PU-MEDIA-002
  "brandKit.queued":
    "Generating {images} images and {videos} looping videos in your brand colors. They show up here in about a minute.", // nuevo
  "brandKit.failed":
    "Couldn't start the background generator. Is the render service running?", // nuevo
  "library.detail.openFile": "Open file {index}", // nuevo
  /* ------------------ Import from link · PU-MEME-001/002/003 (D-12) */
  "mediaImport.open": "Import from link", // nuevo
  "mediaImport.title": "Import from a link", // nuevo
  "mediaImport.description":
    "Paste a link to a clip (TikTok, YouTube, X…). It's downloaded into your Media Bank and labeled automatically.", // nuevo
  "mediaImport.urlLabel": "Link", // nuevo
  "mediaImport.kindLabel": "What to import", // nuevo
  "mediaImport.kind.video": "Video", // nuevo
  "mediaImport.kind.audio": "Audio", // nuevo
  "mediaImport.categoriesLabel": "Use it as", // nuevo
  "mediaImport.foregroundHint":
    "Green screen video = a clip to overlay on your brand backgrounds. If it isn't green, its background is removed with fal (Settings → Models → Background removal).", // nuevo
  "mediaImport.audioHint":
    "Audio goes to your brand's audio library (Library → Audio), ready to pick in the editor.", // nuevo · sprint 7, migración 0025
  "mediaImport.rights":
    "You're responsible for having the rights to publish what you import.", // nuevo · D-12
  "mediaImport.submit": "Import", // nuevo
  "mediaImport.close": "Close", // nuevo
  "mediaImport.another": "Import another", // nuevo
  "mediaImport.state.queued": "Waiting for the worker…", // nuevo
  "mediaImport.state.downloading": "Downloading…", // nuevo
  "mediaImport.state.processing": "Imported. Preparing the video…", // nuevo
  "mediaImport.state.done": "Imported to your Media Bank.", // nuevo
  "mediaImport.state.audioDone": "Audio imported to your audio library.", // nuevo
  "mediaImport.background.pending": "Removing the background…", // nuevo
  "mediaImport.background.greenScreen":
    "Green screen detected: it's keyed out when the video is rendered.", // nuevo
  "mediaImport.background.removed": "Background removed: a cutout copy was added.", // nuevo
  "mediaImport.background.needs":
    "Needs background removal: configure fal in Settings → Models.", // nuevo
  "mediaImport.background.failed":
    "Background removal failed. The original clip is still in your Media Bank.", // nuevo
  "mediaImport.tagging.pending": "Labeling…", // nuevo
  "mediaImport.tagging.skipped": "Not labeled: no vision model is configured.", // nuevo
  "mediaImport.tagging.failed": "Labeling failed. The clip was imported anyway.", // nuevo
  "mediaImport.tagsLine": "{emotion} · {tags}", // nuevo
  "mediaImport.error.unsupportedUrl":
    "That link can't be imported. Use a public http(s) link to a single clip.", // nuevo
  "mediaImport.error.tooLong": "That clip is too long. The limit is 3 minutes.", // nuevo
  "mediaImport.error.tooLarge": "That clip is too large. The limit is 50 MB.", // nuevo
  "mediaImport.error.downloadFailed":
    "The download failed. The site may be blocking it: try again later or use another link.", // nuevo
  "mediaImport.statusCheckFailed": "Couldn't check the import. Retrying…", // nuevo
  "media.card.tagsLabel": "Tags: {tags}", // nuevo · PU-MEME-003

  /* ------------------------------ Calendar · F-140..F-143, FR-110 (PRD:1653) */
  "calendar.title": "Calendar", // literal (label de la ruta, PRD:305)
  "calendar.prevMonth": "Previous month", // nuevo · el `‹` de PRD:1655 no tiene texto
  "calendar.nextMonth": "Next month", // nuevo · el `›` de PRD:1655 no tiene texto
  // PRD:1657 — `Su Mo Tu We Th Fr Sa`. El nombre completo es el `abbr` del
  // `<th>`, para que un lector de pantalla no lea "Su".
  "calendar.weekday.su": "Su", // literal PRD:1657
  "calendar.weekday.mo": "Mo", // literal PRD:1657
  "calendar.weekday.tu": "Tu", // literal PRD:1657
  "calendar.weekday.we": "We", // literal PRD:1657
  "calendar.weekday.th": "Th", // literal PRD:1657
  "calendar.weekday.fr": "Fr", // literal PRD:1657
  "calendar.weekday.sa": "Sa", // literal PRD:1657
  "calendar.weekday.sunday": "Sunday", // nuevo
  "calendar.weekday.monday": "Monday", // nuevo
  "calendar.weekday.tuesday": "Tuesday", // nuevo
  "calendar.weekday.wednesday": "Wednesday", // nuevo
  "calendar.weekday.thursday": "Thursday", // nuevo
  "calendar.weekday.friday": "Friday", // nuevo
  "calendar.weekday.saturday": "Saturday", // nuevo
  // F-142 (PRD:610) — `(N posts)` junto al número de día.
  "calendar.dayCount": "({count} posts)", // literal F-142
  "calendar.dayCountOne": "(1 post)", // nuevo · el PRD sólo muestra el plural
  // El nombre de la celda para un lector de pantalla: el número suelto no dice
  // de qué mes es, y el `(N posts)` visible no dice de qué día.
  "calendar.dayLabel": "{date}, {count} posts", // nuevo
  "calendar.dayLabelOne": "{date}, 1 post", // nuevo
  "calendar.dayLabelNone": "{date}, no posts", // nuevo
  "calendar.dayLabelToday": "Today, {label}", // nuevo
  // F-141 (PRD:1659) — `TikTok: Slideshow`, `Instagram: Wall of Te…`.
  "calendar.chip.withType": "{platform}: {type}", // literal (forma) PRD:1659
  "calendar.chip.label": "{title}, {time}, {status}", // nuevo · sólo lectores de pantalla
  // F-143 (PRD:1655) — `✓ 36` · `📥 0` · `📅 19`. Los iconos no tienen nombre
  // en el PRD; éstos son los que se leen en voz alta y en el `title`.
  "calendar.counters.label": "Post totals", // nuevo
  "calendar.counter.posted": "{count} posted", // nuevo
  "calendar.counter.inbox": "{count} in inbox", // nuevo
  "calendar.counter.scheduled": "{count} scheduled", // nuevo
  "calendar.counter.atLeast": "At least {count}", // nuevo · ver `truncated`
  // Ver la cabecera de `lib/calendar/calendar.ts`: la API no publica la zona
  // del usuario, así que se usa la del navegador, y se dice.
  "calendar.timeZone": "Days and times are in your browser's time zone ({zone}).", // nuevo
  // Ver `lib/calendar/data.ts`: `GET /posts` no filtra por fecha y ordena por
  // creación, así que la vista pide hasta un tope y, si lo alcanza, lo dice.
  "calendar.truncated":
    "Showing the {count} most recently created posts. Older ones aren't loaded, so some days and totals may be missing posts.", // nuevo
  "calendar.typesPartial":
    "Some posts don't show their content type because it couldn't be loaded.", // nuevo
  "calendar.empty.title": "No posts", // literal ERR-E05 (PRD:3106)
  "calendar.empty.description": "Nothing is scheduled or posted in {month}.", // nuevo
  "calendar.empty.truncatedDescription":
    "Nothing loaded for {month}. Older posts aren't loaded, so this month may not be empty.", // nuevo
  // `PU-CAL-002` — vistas semana/mes, filtro de marcas, arrastre y slots
  // planificados. Todo `nuevo`: el PRD no tiene nada de esto.
  "calendar.view.label": "Calendar view", // nuevo
  "calendar.view.week": "Week", // nuevo
  "calendar.view.month": "Month", // nuevo
  "calendar.prevWeek": "Previous week", // nuevo
  "calendar.nextWeek": "Next week", // nuevo
  "calendar.weekTitle": "{start} – {end}", // nuevo
  "calendar.scope.label": "Which brands", // nuevo
  "calendar.scope.current": "This brand", // nuevo
  "calendar.scope.all": "All brands", // nuevo
  "calendar.timeZoneBrand": "Days and times are in {brand}'s time zone ({zone}).", // nuevo
  "calendar.dragHint":
    "Drag anything that hasn't gone out to another day to move it. It keeps its time of day.", // nuevo
  "calendar.moveFailed": "That couldn't be moved. It may have already gone out.", // nuevo
  "calendar.chip.planned": "Planned", // nuevo · slot sin cuenta conectada
  "calendar.chip.plannedHint":
    "Planned: it becomes a post once this brand connects {network}.", // nuevo
  "calendar.rangeTruncated":
    "There are more items in this range than the calendar shows. Narrow it to the week view.", // nuevo
  "calendar.empty.weekDescription": "Nothing is scheduled or posted this week.", // nuevo
  "calendar.keyboardHint":
    "Keyboard: Space picks a post up, the arrows move it and Space drops it; E opens it.", // nuevo · P5-A11Y-001
  "calendar.autoschedule.done": "Scheduled on {networks} · first {when}", // nuevo · `useAutoschedule`

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
  "posts.platform.x": "X", // literal · D-09
  "posts.platform.threads": "Threads", // literal · D-09
  "posts.platform.facebook": "Facebook", // literal · D-09
  "posts.platform.linkedin": "LinkedIn", // literal · PU-LATER-002

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

  /* ------------------- Content Studio · custom upload · F-083 (PRD:525) ---- */
  // El PRD describe la capacidad ("Subir video propio como contenido") y los
  // límites de §9.8, pero **no da copy de pantalla** para ninguno de los pasos:
  // todo lo de este bloque es `nuevo`. Lo único literal es el `50` del tope, y
  // ni siquiera se escribe acá — se interpola desde `@fastgram/contracts`.
  "studio.custom.fileLabel": "Video file", // nuevo
  "studio.custom.limitHint": "MP4 or MOV, up to {max} MB.", // nuevo · {max} sale de NFR-013
  // La tarjeta del formato dice "video or image" (PRD:536) y la API no tiene
  // por dónde recibir una imagen como contenido. Se dice en vez de dejar que
  // alguien elija un PNG y descubra el motivo en un error.
  "studio.custom.videoOnly":
    "Images aren't accepted here yet — custom content is video only. Images go to the Media Bank.", // nuevo

  "studio.custom.reject.empty": "That file is empty, so there's nothing to upload.", // nuevo
  "studio.custom.reject.tooLarge":
    "{name} is {size} MB and the limit is {max} MB, so it wasn't uploaded.", // nuevo
  "studio.custom.reject.unsupportedType": "Only MP4 and MOV videos are accepted.", // nuevo
  "studio.custom.reject.extensionMismatch":
    "The extension of {name} doesn't match what's inside it. Export it again as MP4 or MOV.", // nuevo

  "studio.custom.step.reserving": "Getting the upload ready…", // nuevo
  "studio.custom.step.uploading": "Uploading {name} — {percent}%", // nuevo
  "studio.custom.step.uploadingUnknown": "Uploading {name}…", // nuevo
  "studio.custom.step.finalizing": "Almost there — creating the piece…", // nuevo
  "studio.custom.progressLabel": "Upload progress", // nuevo
  "studio.custom.cancel": "Cancel upload", // nuevo

  "studio.custom.transferFailed.title": "The video didn't reach storage", // nuevo
  "studio.custom.transferFailed.description":
    "Nothing was created and nothing was charged. Trying again starts the upload over.", // nuevo
  // El caso que justifica que haya dos mensajes de fallo: acá el archivo YA
  // está subido y reintentar no vuelve a mandarlo.
  "studio.custom.finalizeFailed.title":
    "The video is uploaded, but the piece isn't created yet", // nuevo
  "studio.custom.finalizeFailed.description":
    "Only the last step failed. Finishing doesn't upload the file again, and it won't be charged twice.", // nuevo
  "studio.custom.finishUpload": "Finish upload", // nuevo
  // §9.8: la reserva vive lo que su URL firmada (1 h). Caducada, el paso 3
  // devuelve `410` para siempre y lo único que queda es subir otra vez.
  "studio.custom.expired.title": "The upload window expired", // nuevo
  "studio.custom.expired.description":
    "Reservations last an hour. Nothing was created — uploading again starts a fresh one.", // nuevo

  "studio.custom.done.title": "Video uploaded", // nuevo
  // FR-070 (PRD:1463): MOV→MP4 y el thumbnail los hace el servidor, así que la
  // pieza nace en `BUILDING`. Decir "listo" mandaría a ver algo que no está.
  "studio.custom.done.description":
    "It's building now — the server normalizes the video and makes the thumbnail. It shows up in your Library when that finishes.", // nuevo
  "studio.custom.done.goToLibrary": "Go to Library", // nuevo
  "studio.custom.uploadAnother": "Upload another", // nuevo

  /* --------------------------- Onboarding · paso 1 · FR-011.2 (PRD:826-833) */
  // Los literales son de `FR-011.2` (EXTENSION) y de `FR-010` (PRD:743-767).
  "onboarding.source.title": "Where can we learn about your brand?", // literal PRD:828
  "onboarding.source.subtitle":
    "Paste your website, your Instagram, TikTok, X, YouTube or LinkedIn — whatever describes you best.", // literal PRD:828
  "onboarding.source.placeholder": "yoursite.com, instagram.com/yourbrand, or @yourbrand", // literal PRD:829
  "onboarding.source.inputLabel": "Website, social profile or @handle", // nuevo · el PRD no da label, sólo placeholder
  "onboarding.source.chipsLabel": "Platform", // nuevo · sólo para lectores de pantalla
  "onboarding.source.analyse": "Analyse", // literal PRD:831
  "onboarding.source.analysing": "Adding…", // nuevo · el botón mientras corre el POST
  "onboarding.source.addAnother": "Add another source", // literal PRD:833
  "onboarding.source.continue": "Continue", // nuevo · el PRD no da el botón para salir del paso
  "onboarding.source.detecting": "Checking…", // nuevo · estado `detecting` de FR-011.8
  "onboarding.source.added": "Your sources", // nuevo
  "onboarding.source.alreadyAdded": "This one is already among your sources.", // nuevo · `available: false` de /resolve
  // `needs_lookup`: la API responde 503 sin `details.code`. El texto es el del
  // servidor (`brand.ts`, `requireResolved`), copiado acá para no enseñar el
  // `message` crudo: el PRD no trae copy para este caso.
  "onboarding.source.postLinkUnsupported":
    "We can't resolve a post link to its profile yet. Paste the profile link instead.", // nuevo
  // FR-010 (PRD:767) — los tres rechazos SSRF de la rama web, literales. La API
  // los manda como `bad_request` sin `details.code`; ver `lib/brand/errors.ts`.
  "onboarding.validation.localhost": "Localhost URLs are not allowed", // literal PRD:767
  "onboarding.validation.privateIp": "Private IP addresses are not allowed", // literal PRD:767
  "onboarding.validation.blocked": "Blocked URL for security reasons", // literal PRD:767

  // Los chips de FR-011.2 (PRD:830), literales. `other_url` y `manual` no
  // tienen chip ni nombre en el PRD.
  "brand.sourceType.website": "Website", // literal PRD:830
  "brand.sourceType.instagram": "Instagram", // literal PRD:830
  "brand.sourceType.tiktok": "TikTok", // literal PRD:830
  "brand.sourceType.x": "X", // literal PRD:830
  "brand.sourceType.youtube": "YouTube", // literal PRD:830
  "brand.sourceType.linkedin": "LinkedIn", // literal PRD:830
  "brand.sourceType.otherUrl": "Link", // nuevo
  "brand.sourceType.manual": "Description", // nuevo

  // FR-011.8 (PRD:941) da los estados, no su texto: todos `nuevo`.
  "brand.status.pending": "Queued", // nuevo · `queued` de FR-011.8
  "brand.status.analyzing": "Analyzing", // nuevo
  "brand.status.ready": "Ready", // nuevo
  "brand.status.partial": "Partial", // nuevo
  "brand.status.failed": "Failed", // nuevo
  "brand.status.stale": "Needs a refresh", // nuevo
  // Un worker sin la configuración de `brand-source-analysis` no la monta, y
  // entonces una fuente se queda en `pending`. Esto es lo que se ve
  // pasados los 3 min de FR-011.12 crit. 9 — que no empezó, no que "sigue".
  "brand.pendingTooLong":
    "The analysis hasn't started yet. It's still queued — you can keep going with setup meanwhile.", // nuevo
  // `unsupported_platform` no tiene copy en §19.5.1. FR-011.4 pide que al
  // degradar a D la UI «lo diga explícitamente y pida la ayuda concreta». En el
  // onboarding (paso 4) no hay panel para pegar la bio, así que se pide la
  // ayuda que ahí sí funciona: una web. «Add a different one» era falso: otra
  // red social puede fallar igual. En `/brand` va la variante `…Assist`.
  "brand.failure.unsupportedPlatform":
    "We can't read {platform} profiles yet, so this source won't shape your brand profile. If you have a website, add it instead.", // nuevo
  // La misma falla en `/brand`, donde abajo sí está el panel del tier D
  // (`AssistedSourcePanel`): el copy invita a usarlo en vez de mandar a la web.
  "brand.failure.unsupportedPlatformAssist":
    "We can't read {platform} profiles on our own yet. Paste your bio and a few recent captions below and we'll build your brand profile from them.", // nuevo
  // FR-011.2 (PRD:835) — sub-pasos de Instagram en Fase 1, literales.
  "brand.substep.readingProfile": "Reading profile", // literal PRD:835
  "brand.substep.readingPosts": "Reading recent posts", // literal PRD:835
  "brand.substep.readingOnScreenText": "Reading on-screen text", // literal PRD:835
  "brand.substep.buildingProfile": "Building your brand profile", // literal PRD:835
  "brand.substep.label": "What the analysis does", // nuevo · sólo para lectores de pantalla
  // La API publica el estado de la fuente, no el del sub-paso: marcar checks
  // sería inventarlos. Ver `lib/onboarding/processing.ts`.
  "brand.substep.noProgress": "We can't show which of these is running yet.", // nuevo

  /* ------------------------------------ /brand · FR-020 (PRD:996-1025) */
  // La cabecera del PRD es `<Company>'s Company Profile` (PRD:1003). Ningún
  // endpoint de brand trae el nombre de la empresa, así que va sin él.
  "brand.profile.title": "Company Profile", // nuevo · ver nota
  "brand.profile.subtitle":
    "We've analysed your business to understand how to do the best marketing for you. Please review your profile and make any changes.", // literal PRD:1003
  "brand.section.identity": "Identity & Product", // literal PRD:1004
  "brand.section.market": "Market & Competition", // literal PRD:1005
  "brand.section.voice": "Tone & Audience", // nuevo · la sección es INFERRED (PRD:1006)
  "brand.field.coreIdentity": "CORE IDENTITY", // literal PRD:1004
  "brand.field.productOffering": "PRODUCT OFFERING", // literal PRD:1004
  "brand.field.uniqueBenefits": "UNIQUE BENEFITS", // literal PRD:1004
  "brand.field.problemSolution": "PROBLEM SOLUTION", // literal PRD:1004
  "brand.field.marketAndCompetition": "MARKET & COMPETITION", // nuevo · el PRD nombra la sección, no el subcampo
  "brand.field.businessCategories": "CATEGORIES", // nuevo
  "brand.field.toneOfVoice": "TONE OF VOICE", // nuevo
  "brand.field.targetAudience": "TARGET AUDIENCE", // nuevo
  "brand.field.empty": "Not filled in yet", // nuevo
  "brand.field.categoriesHint": "Separate categories with commas.", // nuevo
  "brand.field.counter": "{count} / {max}", // nuevo
  // FR-020 Validation: *"INFERRED límite 4 000 caracteres"*. La API no lo aplica.
  "brand.field.tooLong": "Keep this under {max} characters.", // nuevo
  "brand.edit": "Edit", // literal PRD:1003
  "brand.editSection": "Edit {section}", // nuevo · nombre accesible de cada `Edit`
  "brand.save": "Save", // nuevo
  "brand.saving": "Saving…", // nuevo · estado `saving` de FR-020
  "brand.saved": "Saved", // nuevo · estado `saved` de FR-020 ("confirmación")
  // F-022 — `brandRevision` es un entero que sube en cada guardado.
  "brand.revision": "Revision {revision}", // nuevo
  // No hay `expectedBrandRevision` en `PATCH /brand/profile`: esto avisa, no
  // protege. Ver la cabecera de `lib/brand/profile.ts`.
  "brand.revisionMoved":
    "This profile changed while you had this section open. Saving only sends the fields you changed here.", // nuevo
  "brand.profile.pending":
    "We haven't built your profile yet. It fills in as your sources finish analysing.", // nuevo
  "brand.profile.failed":
    "We couldn't build your profile from your sources. You can still fill in the sections below yourself.", // nuevo
  // FR-011.2 (PRD:837) — badge de origen. Las dos formas son literales del
  // ejemplo del PRD (`from @mimarca on Instagram`, `from miproducto.com`).
  "brand.origin.social": "from {handle} on {platform}", // literal (forma) PRD:837
  "brand.origin.domain": "from {domain}", // literal (forma) PRD:837
  "brand.origin.platformOnly": "from your {platform} source", // nuevo · fuente sin handle
  "brand.origin.edited": "Edited by you", // nuevo · `editedByUser`
  "brand.origin.removed": "from a source you removed", // nuevo · `sourceId` huérfano (FR-011.11)
  // PRD:837 dice que el badge es *"clicable para ver el extracto exacto"*. El
  // extracto vive en el snapshot y ningún endpoint lo devuelve.
  "brand.origin.noExcerpt": "We can't show the excerpt each field came from yet.", // nuevo
  // FR-011.2 (PRD:838) — `high` / `medium` / `low`, literales.
  "brand.confidence.high": "high", // literal PRD:838
  "brand.confidence.medium": "medium", // literal PRD:838
  "brand.confidence.low": "low", // literal PRD:838
  "brand.confidence.label": "Confidence: {level}", // nuevo
  "brand.conflict": "Other sources disagree: {sources}", // nuevo · `conflictsWith` (FR-011.6)
  "brand.quickCheck.title": "Worth a quick check", // literal PRD:840
  "brand.quickCheck.body":
    "We guessed these. Fix anything that's off — it shapes every post we write for you.", // literal PRD:840
  // FR-020 / FR-011.6 — el re-análisis no pisa lo editado. La mitad que falta
  // (ver la propuesta y aceptarla, ERR-B14) no tiene endpoint: se dice.
  "brand.editedKept":
    "Fields you edited stay as you wrote them: re-analysing a source won't overwrite them.", // nuevo
  "brand.proposalsUnavailable":
    "If a source suggests a different answer for one of them, we can't show you the suggestion yet.", // nuevo

  /* ------------------------- /brand · tarjeta Brand sources · F-024 (PRD:844) */
  "brand.sources.title": "Brand sources", // literal PRD:844
  "brand.sources.reanalyse": "Re-analyse", // literal PRD:844
  "brand.sources.setPrimary": "Set as primary", // literal PRD:844
  "brand.sources.remove": "Remove", // literal PRD:844
  "brand.sources.menu": "More actions for {source}", // nuevo · nombre accesible del `⋯`
  "brand.sources.primary": "Primary", // nuevo
  "brand.sources.lastAnalysed": "Last analysed {date}", // nuevo
  "brand.sources.neverAnalysed": "Not analysed yet", // nuevo
  // `stale` (FR-011.8): *"el análisis tiene más de 90 días; se ofrece `Re-analyse`"*.
  "brand.sources.staleOffer": "This analysis is more than 90 days old.", // nuevo
  "brand.sources.working": "Working…", // nuevo · la acción de la fila en vuelo
  // `409` + `ERR-B01` del `DELETE` (§9.14: *"Rechazado si es la única fuente y
  // el perfil quedaría sin origen"*). El texto es el del servidor, copiado acá
  // para no pintar el `message` crudo; el literal de ERR-B01 es de onboarding.
  "brand.sources.onlySource":
    "This is the only source behind your brand profile. Add another one first.", // nuevo
  // `403` del `DELETE` — FR-011.10, sólo el owner quita la primaria.
  "brand.sources.ownerOnly": "Only the workspace owner can remove the primary source.", // nuevo
  "brand.sources.gone": "This source isn't there anymore. The list has been refreshed.", // nuevo
  // NFR-005: re-analizar no se reintenta a ciegas.
  "brand.sources.checkStatus":
    "We didn't retry, so it won't count twice. The list shows the source's current status.", // nuevo
  "brand.sources.removeTitle": "Remove {source}?", // nuevo
  // FR-011.11: el perfil materializado no se toca al borrar la fuente.
  "brand.sources.removeBody":
    "Your brand profile keeps what it already learned from this source.", // nuevo
  // La API promueve la más antigua de las que quedan (`DELETE` en brand.ts).
  "brand.sources.removePrimaryBody":
    "It's your primary source, so your oldest remaining source becomes primary.", // nuevo
  "brand.sources.addTitle": "Add a source", // nuevo
  // P1-BRAND-014 — tier D asistido. FR-011.4: al degradar a D la UI «lo dice
  // explícitamente y pide la ayuda concreta». El título es el del brief.
  "brand.assist.title": "Paste your bio and a few recent captions", // nuevo
  "brand.assist.body":
    "We couldn't read this profile on our own. Paste what's on it and we'll build your brand profile from that.", // nuevo
  "brand.assist.bio": "Bio", // nuevo
  "brand.assist.captions": "Recent captions", // nuevo
  "brand.assist.captionsHint":
    "One caption per block — leave an empty line between captions. Up to {max}.", // nuevo
  "brand.assist.submit": "Use this text", // nuevo
  "brand.assist.submitting": "Sending…", // nuevo
  "brand.assist.sent": "Got it. We're building your profile from what you pasted.", // nuevo
  "brand.assist.empty": "Paste your bio or at least one caption.", // nuevo
  "brand.assist.bioTooLong": "Keep the bio under {max} characters.", // nuevo
  "brand.assist.captionTooLong": "Caption {index} is longer than {max} characters.", // nuevo
  // ── Sprint 7, segunda tanda (H): sub-pasos reales del análisis (P1-ONB-005) ──
  "brand.phase.title": "Analysis progress", // nuevo · nombre accesible de la lista
  "brand.phase.starting": "Starting the analysis…", // nuevo · `analyzing` sin fase todavía
  "brand.phase.collecting.website": "Reading the site", // nuevo
  "brand.phase.collecting.social": "Reading the profile and recent posts", // nuevo
  "brand.phase.reading_links": "Following the links in the bio", // nuevo
  "brand.phase.synthesizing": "Writing your brand profile", // nuevo
  "brand.phase.verifying": "Checking each field against the source", // nuevo
  "brand.phase.done": "done", // nuevo · lectores de pantalla
  "brand.phase.current": "in progress", // nuevo · lectores de pantalla
  "brand.phase.pending": "to do", // nuevo · lectores de pantalla
  // ── P1-ONB-007 / FR-011.5.1: oferta post-análisis (copy propuesto del PRD) ──
  "brand.offer.title": "Your brand profile is ready", // nuevo
  "brand.offer.bodyHandle":
    "Connect @{handle} to publish from it — and bring your photos and videos with you.", // literal FR-011.5.1
  "brand.offer.bodyGeneric":
    "Connect your accounts to publish from them — and bring your photos and videos with you.", // nuevo · sin handle
  "brand.offer.connect": "Connect accounts", // nuevo
  "brand.offer.importHint":
    "Importing is optional: nothing is imported unless you tick the box in the next step.", // nuevo
  "brand.offer.dismiss": "Not now", // nuevo
  "brand.offer.dismissFailed": "That didn't work. Try again.", // nuevo
  "brand.assist.tooManyCaptions": "That's {count} captions. Paste up to {max}.", // nuevo
  /* ---------------- brand · sprint 7 (agente D): inteligencia de marca */
  // Todo `nuevo` salvo lo marcado: el PRD no trae copy para estas tarjetas.
  "brand.reload": "Reload", // nuevo
  "brand.revisionConflict":
    "Your brand profile changed in another tab. Reload to see the latest version.", // nuevo · P1-BRANDPG-004
  "brand.proposals.title": "Suggested updates", // nuevo · P1-BRANDPG-005
  "brand.proposals.body":
    "A source found a different answer for fields you edited. Nothing changes until you decide.", // nuevo
  "brand.proposals.suggests": "This source suggests a different answer — replace?", // literal ERR-B14
  "brand.proposals.yours": "Yours", // nuevo
  "brand.proposals.fromSource": "From your {platform} source", // nuevo
  "brand.proposals.emptyValue": "(empty)", // nuevo
  "brand.proposals.accept": "Replace", // nuevo
  "brand.proposals.dismiss": "Keep mine", // nuevo
  "brand.profiling.title": "About your business", // nuevo · F-006
  "brand.profiling.body": "Six quick answers that shape what we write for you.", // nuevo
  "brand.profiling.ownerRole": "Select your role", // literal PRD:766
  "brand.profiling.teamSize": "How big is your current team?", // literal PRD:766
  "brand.profiling.businessModel": "Business model", // literal PRD:766
  "brand.profiling.businessCategories": "Business category (select all that apply)", // literal PRD:766
  "brand.profiling.monthlyRevenueBand": "What is your current monthly revenue?", // literal PRD:766
  "brand.profiling.expectations":
    "What do you expect from the platform? Select all that apply", // literal PRD:766
  "brand.profiling.selectOne": "Select one", // literal PRD:766
  "brand.profiling.other": "Other", // nuevo
  "brand.profiling.otherPlaceholder": "Tell us", // nuevo
  "brand.profiling.otherPlaceholderMany": "Other (comma-separated)", // nuevo
  "brand.profiling.missing.ownerRole": "Please select your role", // literal PRD:789
  "brand.profiling.missing.teamSize": "Please select your team size", // literal PRD:789
  "brand.profiling.missing.businessModel": "Please select your business model", // literal PRD:789
  "brand.profiling.missing.businessCategories":
    "Please select at least one business category", // literal PRD:789
  "brand.profiling.missing.monthlyRevenueBand": "Please select your monthly revenue", // literal PRD:789
  "brand.profiling.saved": "Saved", // nuevo
  "brand.logo.title": "Logo", // nuevo · P1-ONB-003 (`Company Logo (optional)`)
  "brand.logo.none": "No logo yet — the brand switcher shows your initials.", // nuevo
  "brand.logo.shown": "Shown in the brand switcher.", // nuevo
  "brand.logo.placeholder": "Logo", // nuevo
  "brand.logo.alt": "Brand logo", // nuevo
  "brand.logo.upload": "Upload logo", // nuevo
  "brand.logo.replace": "Replace", // nuevo
  "brand.logo.remove": "Remove", // nuevo
  "brand.logo.saved": "Logo updated", // nuevo
  "brand.logo.badType": "Use a PNG, JPEG or WebP image.", // nuevo
  "brand.logo.tooBig": "That image is too large even after resizing. Try a simpler logo.", // nuevo
  "brand.logo.unreadable": "We couldn't read that image.", // nuevo
  "brand.screenshots.hint":
    "Or upload up to {max} screenshots of your profile: we'll read the text into the bio field so you can check it.", // nuevo · P1-BRAND-014
  "brand.screenshots.upload": "Upload screenshots", // nuevo
  "brand.screenshots.reading": "Reading {done} of {total}…", // nuevo
  "brand.screenshots.tooMany": "Only the first {max} screenshots were read.", // nuevo
  "brand.screenshots.badType": "Screenshot {n} isn't a PNG, JPEG or WebP image.", // nuevo
  "brand.screenshots.tooBig": "Screenshot {n} is too large to read.", // nuevo
  "brand.screenshots.noText": "We found no text in screenshot {n}.", // nuevo
  "brand.screenshots.failed": "Screenshot {n} couldn't be read.", // nuevo
  "brand.angles.title": "Content angles", // nuevo · FR-056
  "brand.angles.body":
    "Themes your content keeps coming back to. Weights decide how often each one shows up in Blitz.", // nuevo
  "brand.angles.generate": "Suggest an angle", // nuevo · AI-005
  "brand.angles.generating": "Thinking…", // nuevo
  "brand.angles.suggestion": "Suggested angle — edit it before saving if you like", // nuevo
  "brand.angles.saveSuggestion": "Save angle", // nuevo
  "brand.angles.discard": "Discard", // nuevo
  "brand.angles.cancel": "Cancel", // nuevo
  "brand.angles.fieldTitle": "Title", // nuevo
  "brand.angles.fieldDescription": "Description", // nuevo
  "brand.angles.fieldAudience": "Target audience", // nuevo
  "brand.angles.audience": "For: {audience}", // nuevo
  "brand.angles.inactive": "Inactive", // nuevo
  "brand.angles.delete": "Delete", // nuevo
  "brand.angles.restore": "Restore", // nuevo
  "brand.angles.weight": "Weight", // nuevo
  "brand.angles.weightsSum": "Weights must add up to 100 (now {sum}).", // nuevo · FR-055
  "brand.angles.saveWeights": "Save weights", // nuevo
  "brand.angles.emptyTitle": "No content angles yet", // nuevo
  "brand.angles.emptyBody":
    "Suggest one from your brand profile — or from your best-performing posts once there are metrics.", // nuevo
  "onboarding.source.postAuthorUnknown":
    "We can't tell who posted this link. Paste the profile link instead, or paste your bio.", // nuevo · P1-BRAND-005

  /* --------------------------- Onboarding · paso 4 · FR-010 (PRD:748, 760) */
  "onboarding.processing.done": "Brand analysis finished", // nuevo · ver `ProcessingStep`
  "onboarding.processing.needsSupport":
    "Your company profile needs support before setup can finish.", // literal PRD:760
  "onboarding.processing.noSources": "There are no brand sources to analyse yet.", // nuevo
  // Los cinco pasos de FR-010 (PRD:743-749), para el aviso de paso sin construir.
  "onboarding.step.brandSource": "Brand source", // literal PRD:743
  "onboarding.step.companyDetails": "Company details", // literal PRD:746
  "onboarding.step.profiling": "Profiling", // literal PRD:747
  "onboarding.step.processing": "Processing", // literal PRD:748
  "onboarding.step.ready": "Path hint", // literal PRD:749

  /* ------------- Audio de la marca · sprint 7 (FR-053, migración 0025) */
  "audio.picker.search": "Search your audio", // nuevo
  "audio.picker.empty":
    "Your brand's audio library is empty. Upload a track here or import one from a link.", // nuevo
  "audio.picker.noMatches": "No tracks match “{q}”.", // nuevo
  "audio.picker.error": "Couldn't load your audio library.", // nuevo
  "audio.picker.hint": "The track plays from the start and loops until the video ends.", // nuevo · ver `formats.ts` del render
  "audio.picker.hintGreenScreen":
    "The clip keeps its own sound at full volume; the track plays underneath at 30%.", // nuevo
  "audio.preview.play": "Play {title}", // nuevo
  "audio.preview.pause": "Pause {title}", // nuevo
  "audio.preview.failed": "This track can't be played in the browser.", // nuevo
  "audio.upload": "Upload audio", // nuevo
  "audio.uploading": "Uploading…", // nuevo
  "audio.upload.formats": "MP3, M4A, AAC or WAV · up to {max} MB", // nuevo
  "audio.upload.error.too_large": "That file is over {max} MB.", // nuevo
  "audio.upload.error.unsupported_type": "Use an MP3, M4A, AAC or WAV file.", // nuevo
  "audio.upload.error.empty": "That file is empty.", // nuevo
  "audio.upload.error.failed": "The upload failed. Try again.", // nuevo
  "audio.panel.title": "Audio", // nuevo
  "audio.panel.description":
    "Music for your videos. Pick a track in the editor, or let Blitz add one to new video pieces.", // nuevo
  "audio.panel.emptyTitle": "No audio yet", // nuevo
  "audio.panel.emptyBody":
    "Upload a track, or use Import from link → Audio to bring one from TikTok or YouTube.", // nuevo
  "audio.panel.retry": "Retry", // nuevo
  "audio.panel.loadMore": "Load more", // nuevo
  "audio.panel.rename": "Rename", // nuevo
  "audio.panel.renameLabel": "Track name", // nuevo
  "audio.panel.save": "Save", // nuevo
  "audio.panel.cancel": "Cancel", // nuevo
  "audio.panel.delete": "Delete", // nuevo
  "audio.panel.confirmDelete":
    "Delete “{title}”? Pieces that already use it keep their sound.", // nuevo
  "audio.panel.autoUse": "Use in Blitz", // nuevo
  "audio.panel.autoUseHint":
    "New video pieces from Blitz get one of the tracks marked “Use in Blitz”, at random.", // nuevo
  "audio.panel.origin.upload": "Uploaded", // nuevo
  "audio.panel.origin.import": "Imported", // nuevo
  "audio.panel.actionFailed": "That didn't work. Try again.", // nuevo
  // ── Sprint 7, segunda tanda (H): extraer el audio de un video del Media Bank ──
  "audio.panel.origin.extracted": "From a video", // nuevo
  "audio.extract.open": "Extract from a video", // nuevo
  "audio.extract.title": "Extract audio from a video", // nuevo
  "audio.extract.description":
    "Pick a video from your Media Bank. Its sound becomes a track in this library. Videos up to {minutes} minutes.", // nuevo
  "audio.extract.search": "Search videos", // nuevo
  "audio.extract.empty": "No videos in your Media Bank yet.", // nuevo
  "audio.extract.noMatches": "No videos match “{q}”.", // nuevo
  "audio.extract.loadError": "We couldn't load your videos.", // nuevo
  "audio.extract.retry": "Retry", // nuevo
  "audio.extract.tooLong": "longer than {minutes} min", // nuevo
  "audio.extract.start": "Extract audio", // nuevo
  "audio.extract.running": "Extracting the audio…", // nuevo
  "audio.extract.done": "Done. The track is in your audio library.", // nuevo
  "audio.extract.close": "Close", // nuevo
  "audio.extract.error.media_not_found": "That video isn't in your Media Bank anymore.", // nuevo
  "audio.extract.error.no_audio": "That video has no sound.", // nuevo
  "audio.extract.error.too_long": "That video is longer than {minutes} minutes.", // nuevo
  "audio.extract.error.too_large": "That video file is too big to process.", // nuevo
  "audio.extract.error.extract_failed": "We couldn't extract the audio. Try again.", // nuevo
  "audio.extract.error.start": "We couldn't start the extraction. Try again.", // nuevo

  // ── Sprint 7 (F): Content Studio, Media Bank y posts propios ──
  "studio.hub.description":
    "Build a piece by hand from your Media Bank, or let AI write it.", // nuevo
  "studio.hub.base": "Base formats", // nuevo
  "studio.hub.ai": "AI formats", // nuevo
  "studio.hub.aiDescription": "Generated with image and video models.", // nuevo
  "studio.modes": "Studio mode", // nuevo
  "studio.mode.create": "Create New", // literal F-072
  "studio.mode.remix": "Remix", // literal F-071
  "studio.steps": "Steps", // nuevo
  "studio.step.media": "Media", // nuevo
  "studio.step.text": "Text", // nuevo
  "studio.step.style": "Style", // nuevo
  "studio.step.done": "done", // nuevo · lectores de pantalla
  "studio.step.pending": "to do", // nuevo · lectores de pantalla
  "studio.slot.slides": "Slide images", // nuevo
  "studio.slot.video": "Video", // nuevo
  "studio.slot.backgroundVideo": "Background video", // nuevo
  "studio.slot.greenScreenVideo": "Meme clip (green screen)", // nuevo
  "studio.slot.image": "Background image", // nuevo
  "studio.slot.hookVideo": "Hook video", // nuevo
  "studio.slot.demoVideo": "Demo video", // literal F-079
  "studio.slot.choose": "Choose", // nuevo
  "studio.slot.change": "Change", // nuevo
  "studio.slot.empty": "Nothing picked yet.", // nuevo
  "studio.demoGuide":
    "Record your app demo vertically (9:16), 5–15 seconds, showing one feature end to end.", // nuevo · F-079 sin URL de guía
  "studio.text.mode": "How to write the text", // nuevo
  "studio.text.write": "Write it", // nuevo
  "studio.text.ai": "Generate with AI", // nuevo
  "studio.text.aiPrompt": "What should it say?", // nuevo
  "studio.text.aiPlaceholder": "e.g. 3 mistakes people make when they start running", // nuevo
  "studio.text.mentionBusiness": "Mention my business", // nuevo
  "studio.text.aiHint":
    "Your text model (Settings → Models) writes it right before the video is built.", // nuevo
  "studio.text.slide": "Slide {n}", // nuevo
  "studio.text.caption": "Text", // nuevo
  "studio.text.slideHint": "One text per slide, up to {max} slides.", // nuevo
  "studio.style.preset": "Text style", // nuevo
  "studio.style.aspectRatio": "Aspect ratio", // nuevo
  "studio.preview": "Preview", // nuevo
  "studio.preview.aiText": "AI will write this text", // nuevo
  "studio.preview.placeholder": "Your text", // nuevo
  "studio.preview.slides": "{count} slides", // nuevo
  "studio.preview.note": "A rough preview. The editor shows the real piece.", // nuevo
  "studio.save": "Save", // literal F-081
  "studio.clear": "Clear", // literal F-082
  "studio.cancel": "Cancel", // nuevo
  "studio.retry": "Retry", // nuevo
  "studio.saveDisabledHint": "Complete the three steps to save.", // nuevo · F-073
  "studio.picker.search": "Search your media", // literal PRD («Search your images»)
  "studio.picker.error": "We couldn't load your media.", // nuevo
  "studio.picker.empty": "No ready media of this type yet.", // nuevo
  "studio.picker.filteredEmpty": "Nothing matches.", // nuevo
  "studio.picker.clearFilters": "Clear filters", // nuevo
  "studio.picker.goToLibrary": "Upload in the Library", // nuevo
  "studio.picker.selectedCount": "{count} of {max} selected", // nuevo
  "studio.picker.use": "Use", // nuevo
  "studio.remix.intro":
    "Pick a reference from Inspiration. Remixes land in Blitz, adapted to this brand.", // nuevo
  "studio.remix.search": "Search Inspiration", // nuevo
  "studio.remix.error": "We couldn't load Inspiration.", // nuevo
  "studio.remix.empty": "No references saved yet.", // nuevo
  "studio.remix.goToInspiration": "Save one in Inspiration", // nuevo
  "studio.remix.untitled": "Untitled", // nuevo
  "studio.remix.action": "Remix this", // nuevo
  "studio.remix.prev": "Previous", // nuevo
  "studio.remix.next": "Next", // nuevo
  "mediaBank.back": "← Back", // nuevo · FR-100.1
  "mediaBank.search.placeholder": "Search by name or tag", // nuevo
  "mediaBank.filter.categoryLabel": "Category", // nuevo
  "mediaBank.filter.allCategories": "All categories", // literal PRD:1623
  "mediaBank.tags.label": "Tags (comma separated)", // nuevo
  "mediaBank.tags.placeholder": "e.g. office, pov, summer", // nuevo
  "mediaBank.tags.filterLabel": "Filter by tag", // nuevo
  "mediaBank.hdrKept": "HDR · original kept", // nuevo
  "mediaBank.hdrKept.hint":
    "This HDR video couldn't be converted to SDR on this machine. Colors may look washed out.", // nuevo
  "mediaBank.sets.title": "Your sets", // literal PRD:1620
  "mediaBank.sets.new": "+ New set", // literal PRD:1620
  "mediaBank.sets.count": "{count} items", // nuevo
  "mediaBank.sets.kind.slideshow": "SLIDESHOW", // literal PRD:1620
  "mediaBank.sets.kind.video": "VIDEO", // literal PRD:1620
  "mediaBank.sets.kind.curated": "CURATED", // literal PRD:1620
  "mediaBank.sets.kindLabel": "Set type", // nuevo
  "mediaBank.sets.deleteAria": "Delete set {name}", // nuevo
  "mediaBank.sets.deleteConfirm": "Delete the set “{name}”? Its media stay in the bank.", // nuevo
  "mediaBank.sets.loadError": "We couldn't load your sets.", // nuevo
  "mediaBank.sets.creating": "CREATING SET", // literal PRD:1651
  "mediaBank.sets.selected": "{count} selected", // literal PRD:1651 (forma)
  "mediaBank.sets.selectedNeed": "{count} selected (need {missing} more)", // literal PRD:1651
  "mediaBank.sets.nameLabel": "Set name", // literal PRD:1652
  "mediaBank.sets.namePlaceholder": "Set name (e.g. 'Bedroom shots')", // literal PRD:1652
  "mediaBank.sets.cancel": "✕ Cancel", // literal PRD:1653
  "mediaBank.sets.save": "✓ Save", // literal PRD:1653
  "mediaBank.sets.selectAria": "Select {name}", // nuevo
  "ownPosts.open": "Import my posts", // nuevo · FR-011.5.1
  "ownPosts.title": "Import your own posts", // nuevo
  "ownPosts.description":
    "Bring your latest posts into the Media Bank so Blitz can use real brand media. Nothing is imported unless you confirm.", // nuevo
  "ownPosts.source": "From", // nuevo
  "ownPosts.source.connection": "A connected account (Instagram, YouTube)", // nuevo
  "ownPosts.source.profile": "A public profile link (TikTok, YouTube)", // nuevo
  "ownPosts.account": "Account", // nuevo
  "ownPosts.accountsError": "We couldn't load your connected accounts.", // nuevo
  "ownPosts.noAccounts":
    "No connected Instagram or YouTube account. Connect one in Settings → Connections, or use a profile link.", // nuevo
  "ownPosts.profileUrl": "Profile link", // nuevo
  "ownPosts.profileHint":
    "Read without logging in. Some sites block this; if so, connect the account.", // nuevo
  "ownPosts.limit": "How many posts", // nuevo
  "ownPosts.consent": "Yes, import my posts into the Media Bank", // nuevo · opt-in, desmarcado
  "ownPosts.start": "Import", // nuevo
  "ownPosts.running": "Importing… you can close this, it keeps going.", // nuevo
  "ownPosts.done":
    "Imported {imported}, skipped {skipped} already here, {failed} failed.", // nuevo
  "ownPosts.close": "Close", // nuevo
  "ownPosts.error.unsupportedPlatform":
    "That network isn't supported for importing posts.", // nuevo
  "ownPosts.error.unsupportedUrl": "That link can't be read.", // nuevo
  "ownPosts.error.connectionUnavailable": "Reconnect the account and try again.", // nuevo
  "ownPosts.error.listingFailed": "We couldn't read the posts from that profile.", // nuevo
  "ownPosts.error.nothingFound": "No posts found.", // nuevo
  "ownPosts.error.generic": "The import failed.", // nuevo
  /* ------------------------------ Schedule · sprint 7 (publish-flow) · FR-060 */
  "schedule.title": "Schedule post", // nuevo
  "schedule.description":
    "Pick the networks, check each caption and choose when it goes out.", // nuevo
  "schedule.networks": "Networks", // nuevo
  "schedule.noNetworks":
    "This brand has no connected networks and none in its strategy. Connect an account in Settings → Connections.", // nuevo
  "schedule.unconnectedHint":
    "In the strategy but not connected: {networks}. Auto-slot plans them, and they go out once you connect them.", // nuevo
  "schedule.notConnected": "Not connected", // nuevo
  "schedule.alreadyScheduled": "Already scheduled", // nuevo
  "schedule.account": "{network} account", // nuevo
  "schedule.captionField": "Caption", // nuevo
  "schedule.titleField": "Title", // nuevo
  "schedule.descriptionField": "Description", // nuevo
  "schedule.counter": "{count}/{max}", // nuevo · el `Caption 0/2200` de F-153
  "schedule.emptyCaption": "Empty caption: the post goes out with no text.", // nuevo
  "schedule.improve": "Improve", // nuevo
  "schedule.regenerate": "Regenerate", // nuevo
  "schedule.ai.notConfigured":
    "No text model is set up. Choose one in Settings → Models.", // nuevo
  "schedule.ai.failed": "The text model didn't answer. Try again.", // nuevo
  "schedule.ai.rejected": "The model's answer couldn't be used. Try again.", // nuevo
  "schedule.igFormat": "Post this slideshow as", // nuevo · F-158
  "schedule.igFormat.carousel": "Carousel", // literal F-158
  "schedule.igFormat.reel": "Reel (video)", // nuevo · F-158 `reel`
  "schedule.aiLabel": "Label as AI-generated content", // nuevo · NFR-024
  "schedule.tiktokInbox":
    "Goes to your TikTok inbox as a draft. Pick privacy and sound when you finish it in the app.", // nuevo · D-10
  "schedule.xNoLinks": "Links are removed on X (a post with a link costs much more).", // nuevo
  "schedule.when": "When · {timezone}", // nuevo
  "schedule.date": "Date", // nuevo
  "schedule.time": "Time", // nuevo
  "schedule.useSuggested": "Next free slot", // nuevo
  "schedule.inPast": "Pick a time in the future, or use Post now.", // nuevo
  "schedule.problem.noneSelected": "Select at least one network.", // nuevo
  "schedule.problem.noConnection": "{network} has no connected account.", // nuevo
  "schedule.problem.tooLong": "The {network} text is over the limit.", // nuevo
  "schedule.cancel": "Cancel", // nuevo
  "schedule.postNow": "Post now", // nuevo · F-157
  "schedule.submit": "Schedule", // nuevo
  "schedule.toast.postingNow": "Publishing now on {count} network(s)", // nuevo
  "schedule.toast.scheduled": "Scheduled on {count} network(s) · {when}", // nuevo
  "schedule.acceptCustom": "Schedule…", // nuevo
  "schedule.acceptCustomDescription": "Choose networks, captions and time yourself.", // nuevo
  "postEdit.title": "Post", // nuevo
  "postEdit.description": "Edit the caption or time, or retry a failed post.", // nuevo
  "postEdit.otherBrand":
    "This post belongs to another brand. Switch to it to edit the post.", // nuevo
  "postEdit.save": "Save changes", // nuevo
  "postEdit.cancelPost": "Cancel post", // nuevo
  "postEdit.retryNow": "Retry now", // nuevo
  "postEdit.reschedule": "Reschedule", // nuevo
  "postEdit.confirmNotPublished": "I checked the account: it wasn't published", // nuevo · NFR-015
  "postEdit.confirmNotPublishedHint":
    "The platform may have published it anyway. Retrying without checking can post it twice.", // nuevo
  "postEdit.needsConfirmation": "Confirm you checked the account before retrying.", // nuevo
  "postEdit.toast.saved": "Post updated", // nuevo
  "postEdit.toast.retried": "Post queued again", // nuevo
  "postEdit.toast.cancelled": "Post cancelled", // nuevo
  "library.detail.schedule": "Schedule", // nuevo
  "library.detail.autoslot": "Auto-slot", // nuevo · PU-CAL-001
  "library.detail.autoslotNothing":
    "Nothing to schedule: it's already on every network of the strategy.", // nuevo
  "today.failed.retry": "Retry", // nuevo
  "today.failed.reschedule": "Reschedule", // nuevo
  "posts.actions.retry": "Retry", // nuevo · PRD:1611
  "posts.actions.reschedule": "Reschedule", // literal PRD:1611
  "posts.actions.edit": "Edit", // nuevo
  "posts.actions.cancel": "Cancel", // literal PRD:1611
  "posts.refreshMetrics": "Refresh Metrics", // literal PRD:1605
  "posts.refreshQueued": "Refreshing metrics… they'll update in a moment.", // nuevo
  "posts.select.start": "Select", // literal PRD:1605
  "posts.select.done": "Done", // nuevo
  "posts.select.one": "Select this post", // nuevo
  "posts.select.toolbar": "Selected posts", // nuevo
  "posts.select.count": "{count} selected", // nuevo
  "posts.select.all": "Select all", // nuevo
  "posts.select.cancel": "Cancel selected", // nuevo
  "posts.select.delete": "Delete", // nuevo
  "posts.select.deleteTitle": "Delete {count} post(s)?", // nuevo
  "posts.select.deleteBody":
    "They're removed from FastGram. A post already published stays on the platform.", // nuevo
  "posts.select.cancelled": "{count} post(s) cancelled", // nuevo
  "posts.select.deleted": "{count} post(s) deleted", // nuevo
  "posts.select.batchFailed":
    "Nothing changed: {count} of the selected posts can't be changed in their current state.", // nuevo · ERR-F01
  /* ------ Sprint 7 (agente G): formatos generativos, influencers, AI Studio */
  // Copy nuevo; nada literal del PRD salvo donde dice «literal».
  "formats.counter": "{count}/{max}", // nuevo
  "formats.notGenerative": "This isn't a generative format.", // nuevo
  "formats.blocked.title": "Not available yet", // nuevo
  "formats.setup.title": "Set up a video model first", // nuevo
  "formats.setup.body":
    "Generative formats need a text-to-video model (Higgsfield, fal or ComfyUI) in Settings → Models.", // nuevo
  "formats.narrationMissing":
    "This format normally has a voice-over. FastGram has no voice model yet, so the on-screen text carries the message.", // nuevo
  "formats.overlay.label": "Text on the video", // nuevo
  "formats.overlay.placeholder": "e.g. POV: you finally fixed your morning routine", // nuevo
  "formats.topic.label": "Scene details (optional)", // nuevo
  "formats.topic.placeholder": "e.g. a jar of protein powder on the counter", // nuevo
  "formats.brand.label": "Let what the brand offers shape the scene", // nuevo
  "formats.estimate.idle": "Write the text to see the cost.", // nuevo
  "formats.run.queued": "Queued", // nuevo
  "formats.run.generating": "Generating the clip", // nuevo
  "formats.run.building": "Putting your text on it", // nuevo
  "formats.run.ready": "Ready", // nuevo
  "formats.run.failed": "It didn't work", // nuevo
  "formats.run.nsfw": "Blocked by the provider's content filter", // nuevo
  "formats.run.wait":
    "Clips take a few minutes. You can leave this page: it keeps going in the background.", // nuevo
  "formats.run.openEditor": "Open in editor", // nuevo
  "formats.run.again": "Make another", // nuevo
  /* ------ Sprint 8 (agente L): formatos con voz, character swap, talking head */
  "speaking.setup.title": "Set up fal in Settings → Models", // nuevo
  "speaking.setup.body":
    "Voice formats need a fal voice model and a fal talking-avatar model (Speech and Avatar). The fal key you already use for images or video works.", // nuevo
  "speaking.setup.swapBody":
    "Character swap needs a fal character-swap model (Swap). The fal key you already use for images or video works.", // nuevo
  "speaking.portrait.label": "Who speaks", // nuevo
  "speaking.portrait.pick": "Use a portrait from the Media Bank", // nuevo
  "speaking.portrait.pickTitle": "Pick a portrait", // nuevo
  "speaking.portrait.noModels":
    "No models in your library yet. Pick a clear, front-facing portrait from the Media Bank.", // nuevo
  "speaking.portrait.libraryDown":
    "Your model library didn't load. You can still use a portrait from the Media Bank.", // nuevo
  "speaking.demo.label": "Your video", // nuevo
  "speaking.video.pick": "Pick a video", // nuevo
  "speaking.video.change": "Change video", // nuevo
  "speaking.script.label": "Script", // literal F-098
  "speaking.script.placeholder": "What the speaker says, word for word.", // nuevo
  "speaking.script.onTarget": "{words} words · target {min}-{max}", // nuevo
  "speaking.script.topic": "Topic for a generated script (optional)", // nuevo
  "speaking.script.topicPlaceholder": "e.g. why invoices get paid late", // nuevo
  "speaking.script.generate": "Generate script", // nuevo
  "speaking.script.noWriter":
    "Set up a text model in Settings → Models to generate scripts.", // nuevo
  "speaking.script.failed": "Couldn't write a script. Try again or write your own.", // nuevo
  "speaking.voice.label": "Voice", // nuevo
  "speaking.voice.model": "The model's voice ({voice})", // nuevo
  "speaking.voice.default": "Default voice ({voice})", // nuevo
  "speaking.language.label": "Language", // literal F-098
  "speaking.caption.label": "Caption overlay", // literal F-098
  "speaking.estimate.idle": "Pick who speaks and write the script to see the cost.", // nuevo
  "speaking.estimate.voice": "Voice {usd} · {basis}", // nuevo
  "speaking.estimate.video": "Video {usd} · {basis}", // nuevo
  "speaking.run.voice": "Recording the voice", // nuevo
  "speaking.run.video": "Generating the video", // nuevo
  "speaking.run.building": "Putting it together", // nuevo
  "speaking.run.wait":
    "Voice and video take a few minutes. You can leave this page: it keeps going in the background.", // nuevo
  "speaking.swap.source": "Video to swap the character in", // nuevo
  "speaking.swap.sourceHint":
    "Up to {seconds} seconds, from your Media Bank. One clear person on screen works best.", // nuevo
  "speaking.swap.noAudio":
    "The finished piece has no sound: FastGram's renderer doesn't carry a video's own audio. Add music in the editor.", // nuevo
  "speaking.talkingHead.history": "Talking head videos", // nuevo
  "speaking.talkingHead.empty": "No talking head videos with this model yet.", // nuevo
  "speaking.talkingHead.notReady": "This model isn't ready yet", // nuevo
  "speaking.talkingHead.notReadyBody":
    "Talking head videos use its main portrait once it's ready.", // nuevo
  "aiStudio.image.pick": "Pick from Media Bank", // nuevo
  "aiStudio.image.pickTitle": "Pick a start image", // nuevo
  "aiStudio.image.picked": "From your Media Bank", // nuevo
  "aiStudio.image.remove": "Remove", // nuevo
  "influencers.tabs.images": "Images", // literal FR-081
  "influencers.tabs.videos": "Videos", // literal FR-081
  "influencers.tabs.configuration": "Configuration", // literal FR-081
  "influencers.images.animateHint": "Animate any image from its tile.", // nuevo · sprint 8: el talking head vive en el detalle del modelo
  "influencers.videos.empty": "No videos yet. Animate an image from the Images tab.", // nuevo
  "influencers.videos.pending": "Animating…", // nuevo
  "influencers.videos.hint":
    "Videos join this influencer's video set, which Blitz uses as a source.", // nuevo
  "influencers.animate.action": "Animate", // literal FR-081
  "influencers.animate.title": "Animate this image", // literal FR-081
  "influencers.animate.prompt": "Motion", // nuevo
  "influencers.animate.placeholder":
    "describe the motion (optional, e.g. slow zoom on the face)", // literal FR-082
  "influencers.animate.generate": "Generate video", // literal FR-082
  "influencers.animate.noModels":
    "Animating needs Higgsfield as the image or video provider in Settings → Models.", // nuevo
  "influencers.animate.started": "Video generating. It shows up here when it's ready.", // nuevo
  "influencers.templates.label": "Template", // literal FR-081
  "influencers.templates.placeholder": "Pick a template…", // nuevo
  "influencers.templates.error": "Templates couldn't load", // nuevo
  "influencers.templates.edit": "Edit templates", // nuevo
  "influencers.templates.title": "Prompt templates", // nuevo
  "influencers.templates.hint":
    "Picking a template replaces the prompt. {subject} becomes her, him or them.", // nuevo
  "influencers.templates.name": "Template name", // nuevo
  "influencers.templates.prompt": "Template prompt", // nuevo
  "influencers.templates.remove": "Remove template", // nuevo
  "influencers.templates.add": "Add template", // nuevo
  "influencers.templates.new": "New template", // nuevo
  "influencers.templates.save": "Save", // nuevo
  "influencers.templates.reset": "Restore defaults", // nuevo
  "influencers.templates.saveError": "The templates couldn't be saved.", // nuevo
  "influencers.config.saved": "All changes saved", // literal FR-083
  "influencers.config.saving": "Saving…", // nuevo
  "influencers.config.saveError": "That change couldn't be saved.", // nuevo
  "influencers.config.angles": "Content angles", // literal FR-083
  "influencers.config.anglesHint":
    "Blitz copy with this influencer sticks to these angles (up to {max}).", // nuevo
  "influencers.config.anglesEmpty":
    "No content angles yet. Create them in Blitz settings.", // nuevo
  "influencers.config.accounts": "Publishing accounts", // literal FR-083
  "influencers.config.accountsHint":
    "Platform accounts this influencer publishes through.", // literal FR-083
  "influencers.config.accountsEmpty":
    "No connected accounts. Connect one in Settings → Connections.", // nuevo
  "influencers.config.slideshowSets": "Slideshow sets", // literal FR-083
  "influencers.config.slideshowSetsHint":
    "Image sources for influencer-flavoured slideshows", // literal FR-083
  "influencers.config.videoSets": "Video sets", // literal FR-083
  "influencers.config.videoSetsHint":
    "Background / hook video source for wall of text and video hook", // literal FR-083
  "influencers.config.setsEmpty": "No sets yet. Generating images or videos creates one.", // nuevo
  "influencers.config.set": "{name} · {count}", // nuevo
  "influencers.regenerate.action": "Regenerate", // literal FR-080
  "influencers.base.modeLabel": "How to make the character", // nuevo
  "influencers.base.modePhotos": "Use my photos", // nuevo
  "influencers.base.modeDescribe": "Generate base image", // literal FR-080
  "influencers.base.describeFirst":
    "Go back and describe the character (gender, age, ethnicity or details) to generate a base image.", // nuevo
  "influencers.base.intro":
    "We'll generate a base character from your description. The character is created from this image.", // nuevo
  "influencers.base.alt": "Generated base character", // nuevo
  "influencers.base.generate": "Generate base image", // nuevo
  "influencers.base.regenerate": "Regenerate", // literal FR-080
  "influencers.base.instructions": "Regeneration instructions (optional)", // literal FR-080
  "influencers.base.instructionsPlaceholder":
    "e.g. curlier hair, softer features, in a coffee shop", // literal FR-080
  "influencers.base.newPerson":
    "Regenerations produce a brand-new person, not edits to this one.", // literal FR-080
  "influencers.base.cost": "About {cost} per image", // nuevo
  /* ------ Sprint 7, segunda tanda (I): formatos IA desde «Create from prompt» */
  "prompt.gen.option": "{label} · AI video", // nuevo
  "prompt.gen.optionDisabled": "{label} · needs a video model", // nuevo
  "prompt.gen.estimating": "Checking what this clip costs…", // nuevo
  "prompt.gen.confirm":
    "This clip costs about {cost}. It lands in your Library, not in the deck.", // nuevo
  "prompt.gen.generate": "Generate video", // nuevo
  "prompt.gen.estimateFailed": "Couldn't check the cost of that clip. Try again.", // nuevo
  "prompt.gen.startFailed": "Couldn't start that video. Try again.", // nuevo
  "prompt.gen.ready": "Your video is ready in your Library.", // nuevo
  "prompt.gen.statusFailed":
    "Lost track of that video. Check your Library in a few minutes.", // nuevo
  /* ------ Sprint 8 (K): biblioteca de modelos del dueño. Todo `nuevo`. */
  "charModels.title": "Models",
  "charModels.subtitle":
    "Your model library. Import a model once and use it consistently across any of your brands.",
  "charModels.fromLibrary": "From library",
  "charModels.back": "← All models",
  "charModels.loading": "Loading…",
  "charModels.cancel": "Cancel",
  "charModels.save": "Save",
  "charModels.saveFailed": "Couldn't save that. Try again.",
  "charModels.training": "Training the model on Higgsfield… {progress}%",
  "charModels.setup.title": "Set up Higgsfield first",
  "charModels.setup.body":
    "Models use Higgsfield Soul ID to stay consistent. Set Higgsfield as your image or video provider in Settings → Models.",
  "charModels.setup.action": "Open Settings → Models",
  "charModels.empty.title": "No models yet",
  "charModels.empty.body":
    "Import a model from photos, a Soul ID you already have, or one of your influencers.",
  "charModels.brands.none": "Not assigned to any brand",
  "charModels.brands.list": "In {brands}",
  "charModels.brands.title": "Brands",
  "charModels.brands.body":
    "Assign the model to the brands that should use it. Each brand gets it as a ready influencer — no retraining.",
  "charModels.brands.notReady": "You can assign the model once training is done.",
  "charModels.brands.save": "Save brands",
  "charModels.source.photos": "Trained from photos",
  "charModels.source.soul": "Imported Soul ID",
  "charModels.source.influencer": "Promoted from an influencer",
  "charModels.import.open": "Import model",
  "charModels.import.title": "Import a model",
  "charModels.import.fromBrand":
    "Photos come from the Media Bank of {brand}, your active brand.",
  "charModels.import.name": "Name",
  "charModels.import.nameOptional": "Name (optional)",
  "charModels.import.tab.photos": "From photos",
  "charModels.import.tab.soul": "Paste a Soul ID",
  "charModels.import.tab.influencer": "From an influencer",
  "charModels.import.photos.hint":
    "Pick {min}–{max} clear photos of the same person. We copy them to your library and train a Soul ID on Higgsfield.",
  "charModels.import.photos.label": "Reference photos",
  "charModels.import.photos.budget":
    "This month's AI budget is used up. Raise it in Settings → Models to train a model.",
  "charModels.import.soul.label": "Soul ID",
  "charModels.import.soul.hint":
    "The id of a character you already trained in your Higgsfield account. We check it with Higgsfield before saving.",
  "charModels.import.soul.portrait": "Portrait",
  "charModels.import.influencer.label": "Influencer",
  "charModels.import.influencer.placeholder": "Select…",
  "charModels.import.influencer.empty":
    "No ready influencers in this brand that aren't in the library yet.",
  "charModels.import.influencer.hint":
    "Reuses the influencer's Soul ID — no retraining. It stays assigned to this brand.",
  "charModels.import.submit": "Import",
  "charModels.import.submitTrain": "Import and train",
  "charModels.import.failed": "Couldn't import the model. Try again.",
  "charModels.picker.noBrand": "Pick a brand first.",
  "charModels.picker.empty": "No ready images in this brand's Media Bank yet.",
  "charModels.picker.upload": "Upload in Library",
  "charModels.picker.count": "{count} of {max}",
  "charModels.details.title": "Details",
  "charModels.details.age": "Age",
  "charModels.details.style": "Style",
  "charModels.details.stylePlaceholder": "e.g. streetwear, clean girl, techy",
  "charModels.details.notes": "Notes",
  "charModels.details.notesPlaceholder": "Who they are, what they like, where they film",
  "charModels.details.notesHint":
    "Blitz reads these to pick the best model for each brand and angle.",
  "charModels.voice.title": "Voice",
  "charModels.voice.body":
    "The voice used when this model speaks in videos (fal text-to-speech).",
  "charModels.voice.model": "Voice model",
  "charModels.voice.voice": "Voice",
  "charModels.voice.hint":
    "fal has no voice list endpoint: suggestions are the voices its docs show. Any voice name or id your fal account supports works.",
  "charModels.voice.save": "Save voice",
  "charModels.voice.remove": "Remove voice",
  "charModels.voice.short": "Voice: {voice}",
  "charModels.delete.open": "Delete model",
  "charModels.delete.confirm": "Delete for good",
  "charModels.delete.body":
    "The model leaves your library and is deactivated in its brands. What it already generated stays in each brand's Media Bank.",
  "charModels.ugc.title": "Generate UGC",
  "charModels.ugc.titleFor": "Generate UGC for {brand}",
  "charModels.ugc.assignFirst":
    "Assign the model to a brand to generate content with it.",
  "charModels.ugc.brand": "Brand",
  "charModels.ugc.count": "Images",
  "charModels.ugc.prompt": "Scene",
  "charModels.ugc.promptPlaceholder":
    "Casual selfie in a kitchen holding a matte black water bottle, natural light",
  "charModels.ugc.productNote":
    "Higgsfield can't place your product photo in the image: describe it here, then add the product photo as a slide when you create the piece.",
  "charModels.ugc.generate": "Generate",
  "charModels.ugc.cost": "About {cost}",
  "charModels.ugc.estimateFailed": "Couldn't check the cost. Try again.",
  "charModels.ugc.failedToStart": "Couldn't start that. Try again.",
  "charModels.ugc.results": "Generated in this brand",
  "charModels.ugc.empty": "Nothing generated with this model in this brand yet.",
  "charModels.ugc.pending": "{count} in progress…",
  "charModels.ugc.createPiece": "Create piece",
  "charModels.ugc.animate": "Animate",
  "charModels.ugc.pieceCreated": "The piece is building in {brand}'s Library.",
  "charModels.ugc.openLibrary": "Open Library",
  "charModels.piece.title": "Create a piece",
  "charModels.piece.bodyImage":
    "A slideshow: the model first, then up to 3 product photos from the brand's Media Bank. One text per slide.",
  "charModels.piece.bodyVideo": "A wall of text over the video.",
  "charModels.piece.products": "Product photos",
  "charModels.piece.textModel": "Text on the model slide",
  "charModels.piece.textProduct": "Text on product slide {n}",
  "charModels.piece.create": "Create piece",
  "charModels.piece.failed": "Couldn't create the piece. Try again.",
} as const;

export type WebMessageKey = keyof typeof webEn;
