/**
 * Catálogo de copy en inglés.
 *
 * Regla del proyecto (IMPL §4, i18n): el copy de UI vive en claves, no incrustado
 * en el JSX. Este archivo es el catálogo `en`; añadir un idioma es añadir otro
 * objeto con las mismas claves.
 *
 * **Procedencia.** Casi todo sale del PRD §19 (Error & Empty States) y §3.5
 * (toasts). El PRD marca con comillas invertidas el copy literal del producto
 * original y en cursiva lo que es una descripción del comportamiento. Aquí se
 * distingue lo mismo con dos marcas en el comentario de cada clave:
 *
 *   · `literal`     → copiado tal cual del PRD. **No se edita sin editar el PRD.**
 *   · `paráfrasis`  → el PRD lo da en cursiva (no es copy verbatim del original).
 *                      Se puede pulir; conviene confirmarlo contra el producto.
 *
 * Los huecos van con llaves —`{handle}`, `{count}`— donde el PRD escribe
 * `<handle>` o `<N>`. Es el único cambio respecto del texto del PRD.
 */

export const en = {
  /* ------------------------------------------------------------- genérico */
  "common.loading": "Loading...", // ERR-L02 · literal
  "common.tryAgain": "Try again", // §19.3 · literal
  "common.tryAgainTitleCase": "Try Again", // §19.3 · literal
  "common.cancel": "Cancel", // §3.4 M-01/M-02/M-03 · literal
  "common.close": "Close",
  "common.somethingWentWrong": "Something went wrong", // §19.3 · literal
  "common.somethingWentWrongContent":
    "Something went wrong while preparing your content. Please try again.", // §19.3 · literal
  "common.somethingWentWrongRun": "Something went wrong with this run. Please try again.", // §19.3 · literal

  /* ------------------------------------------------------ empty states §19.1 */
  "empty.aiStudio.title": "No generations yet. Start generating with a prompt below.", // ERR-E01 · literal
  "empty.inspiration.title": "No results", // ERR-E02 · literal
  "empty.inspiration.description": "Try a different search or clear your filters.", // ERR-E02 · paráfrasis
  "empty.inspirationSetup.title": "Inspiration is being set up", // ERR-E03 · literal
  "empty.inspirationSetup.description":
    "The library is not available yet. Check back soon.", // ERR-E03 · paráfrasis
  "empty.mediaBank.title": "No images uploaded yet", // ERR-E04 · literal
  "empty.posts.title": "No posts", // ERR-E05 · literal
  "empty.imagePicker.title": "No available images.", // ERR-E06 · literal
  "empty.audio.title": "No audio", // ERR-E07 · literal
  "empty.leads.description":
    "Try adjusting your filters or fetch new leads to discover conversations where your audience is seeking solutions.", // ERR-E08 · paráfrasis
  // ERR-E09 · el PRD trae el copy truncado (`<...> account in Settings or buy a
  // warmed account.`). El título es literal; la descripción reconstruye el
  // arranque de la frase y hay que confirmarla contra el producto original.
  "empty.warmedAccounts.title": "{count} accounts yet",
  "empty.warmedAccounts.description":
    "Connect an account in Settings or buy a warmed account.",
  "empty.workspaces.title": "No other workspace available", // ERR-E10 · literal
  "empty.blitzQueue.description":
    "The discovery queue has no ready items yet. Try again shortly.", // ERR-E11 · paráfrasis (la API devuelve 404 not_found)
  "empty.brandSources.title":
    "No sources yet. Add your website or a social profile so we can learn your brand.", // ERR-E12 · literal (EXTENSION)
  "empty.brandSources.action": "+ Add source", // ERR-E12 · literal (EXTENSION)
  "empty.socialSource.title":
    "@{handle} doesn't have enough posts yet. Add another source or describe your brand.", // ERR-E13 · literal (EXTENSION)

  /* ---------------------------------------------------- loading states §19.2 */
  "loading.studioGenerating": "Generating your content...", // ERR-L01 · literal
  "loading.studioGeneratingButton": "Generating...", // ERR-L01 · literal
  "loading.analytics": "Loading lifetime post breakdowns", // ERR-L03 · literal
  "loading.lead": "Loading lead...", // ERR-L04 · literal
  "loading.inspirationVideo": "Preparing video", // ERR-L05 · literal
  "loading.onboarding.analyzing": "Analyzing company profile...", // ERR-L06 · literal
  "loading.onboarding.processing": "Processing with AI...", // ERR-L06 · literal
  "loading.onboarding.creatingWorkspace": "Creating Workspace...", // ERR-L06 · literal
  "loading.onboarding.settingUp": "Setting up your workspace...", // ERR-L06 · literal
  "loading.onboarding.preparing": "Preparing workspace", // ERR-L06 · literal
  "loading.onboarding.completing": "Completing Setup...", // ERR-L06 · literal
  "loading.workspaceSwitch": "Switching workspace...", // ERR-L07 · literal
  "loading.aiStudioSlow":
    "Taking longer than expected. We'll keep working in the background.", // ERR-L09 · paráfrasis
  "loading.slideshowQueued": "Slideshow preparation is waiting to start.", // ERR-L10 · literal

  /* ------------------------------------------- unauthorized / not found §19.4 */
  "error.accessDenied.title": "Access Denied", // ERR-U01 · literal
  "error.accessDenied.description":
    "You don't have permission to view this lead. It may belong to another account.", // ERR-U01 · paráfrasis
  "error.leadNotFound.title": "Lead Not Found", // ERR-U02 · literal
  "error.leadNotFound.description":
    "This lead may have been deleted or is no longer available.", // ERR-U02 · paráfrasis
  "error.workspaceUnavailable.title": "Workspace Unavailable", // ERR-U03 · literal
  "error.workspaceUnavailable.description":
    "The workspace containing this lead has been deleted.", // ERR-U03 · paráfrasis
  "error.noCompanySelected.title": "No company selected", // ERR-U04 · literal
  "error.influencerNotFound.title":
    "We couldn't find this influencer. It may have been deleted.", // ERR-U05 · literal

  /* ------------------------------------------ integraciones caídas §19.5 */
  "error.connectionExpired.title": "Connection Expired", // ERR-D01 · literal
  "error.pausedReconnect.title": "Paused: reconnect needed", // ERR-D02 · literal
  "error.permissionsMissing.title": "Permissions Missing", // ERR-D03 · literal
  "error.permissionsMissing.action": "Reconnect to upgrade permissions", // ERR-D03 · literal
  "error.permissionDeclined.title":
    "You declined a permission Fastlane needs. Please try again and approve all requested permissions.", // ERR-D04 · literal
  "error.tiktokPermissions.title":
    "TikTok permissions are missing. Please disconnect and reconnect your account.", // ERR-D05 · literal
  "error.accountChanged.title": "Connected Account Changed", // ERR-D06 · literal
  "error.accountChanged.description":
    "A different Instagram account was connected. Open the connect flow again and choose the matching account.", // ERR-D06 · literal
  "error.linkedinExpiry.title":
    "LinkedIn connections last 60 days. Reconnect to keep posting without interruption.", // ERR-D07 · literal
  "error.noRedditConnection.title": "No active Reddit connection", // ERR-D08 · literal
  "error.tiktokOptions.title":
    "Couldn't load TikTok posting options. Reconnect TikTok in Settings, or retry.", // ERR-D09 · literal
  "error.instagramUnavailable.title":
    "Instagram connections are temporarily unavailable. Please try again later.", // ERR-D10 · literal
  "error.connectionUnconfirmed.title":
    "We could not confirm the connection yet. Refresh the page to retry, or contact support if this keeps happening.", // ERR-D11 · literal
  "error.connectUnavailable.title": "Connecting isn't available right now.", // ERR-D12 · literal
  "error.connectionLimit.title": "Connection limit reached", // ERR-D13 · literal
  "error.privateAccountRequired.title": "Private Account Required", // ERR-D14 · literal
  "error.privateAccountRequired.description":
    "Direct posting requires a private TikTok account. Your post was sent to your inbox instead.", // ERR-D14 · literal
  "error.inboxOnlyConnection.title":
    "Re-connect to enable direct posting with captions. Your current connection only supports inbox uploads.", // ERR-D15 · literal
  "error.privacyLevelUnavailable.title":
    "The selected privacy level is not available for your account. Your post was sent to your inbox instead.", // ERR-D16 · literal

  /* ------------------------------------------ brand sources §19.5.1 (EXTENSION) */
  "error.brand.sourceRequired.title": "Add a website or a social profile to continue", // ERR-B01
  "error.brand.unrecognized.title":
    "We couldn't tell what this is. Paste a website URL or a social profile link.", // ERR-B02
  "error.brand.whichPlatform.title": "Which platform is @{handle} on?", // ERR-B03
  "error.brand.handleNotFound.title":
    "We couldn't find @{handle} on {platform}. Check the spelling.", // ERR-B04
  "error.brand.privateProfile.title":
    "@{handle} is private, so we can't read it. Connect the account or paste your bio instead.", // ERR-B05
  // **El literal del PRD para ERR-B06 nombra el otro workspace, y acá no.**
  //
  // «This profile is already connected to another workspace» convierte el alta
  // en un buscador de clientes: probás `@nike`, leés «otro workspace», sabés
  // que Nike es cliente. La API ya devuelve la forma neutra —la misma que el
  // propio PRD eligió para el caso equivalente de la rama web (`FR-010`,
  // PRD:767)— y su cuerpo es byte a byte idéntico choques con una fuente tuya
  // o con la de otro.
  //
  // Si este copy siguiera nombrando el otro workspace, el filtrado volvería por
  // acá en cuanto la UI renderice por código de error, y la neutralidad de la
  // API no habría servido de nada.
  //
  // El usuario que choca consigo mismo lo resuelve mirando su propio listado,
  // que ya ve.
  "error.brand.alreadyConnected.title": "This profile is already registered.", // ERR-B06
  "error.brand.platformDown.title":
    "{platform} isn't responding right now. Try again in a few minutes or add a different source.", // ERR-B07
  "error.brand.backlogged.title":
    "We're reading a lot of profiles right now. We'll keep trying in the background.", // ERR-B08
  "error.brand.thinProfile.title":
    "We got the basics but not much else. A couple of quick answers will fix that.", // ERR-B09
  "error.brand.sourceLimit.title": "You can analyse up to 5 sources per workspace.", // ERR-B10
  "error.brand.refreshCooldown.title":
    "You've refreshed this source recently. Try again in {hours} hours.", // ERR-B11
  "error.brand.wholeProfile.title":
    "We'll analyse the whole @{handle} profile, not just that post.", // ERR-B12 · aviso, no error
  "error.brand.tooBroad.title":
    "Your posts cover a lot of ground. Tell us which part is the business.", // ERR-B13
  "error.brand.conflict.title": "This source suggests a different answer — replace?", // ERR-B14

  /* ------------------------------------------- fallos de procesamiento §19.6 */
  "error.noContentFiles.title":
    "No content files were found. Please try scheduling again.", // ERR-P09 · literal
  "error.trainingSet.title": "Could not prepare the training set. Please try again.", // ERR-P10 · literal
  "error.videoUnreadable.title":
    "We couldn't read this video's details. Try re-exporting it as MP4 or choose another file.", // ERR-P11 · literal
  "error.slideshowQueued.title": "Slideshow preparation is waiting to start.", // ERR-P12 · literal

  /* -------------------------------------------- rate limits y cuotas §19.8 */
  "error.rateLimited.title": "API rate limit exceeded", // ERR-R01 · literal
  "error.blitzQuota.title": "Daily blitz swipe limit reached", // ERR-R02 · literal
  "error.contentQuota.title": "Monthly content quota reached for your plan", // ERR-R03 · literal
  "error.trialQuota.title": "Trial content allowance reached", // ERR-R04 · literal
  "error.generationsInFlight.title":
    "You have 10 generations in flight. Wait for some to finish before starting another.", // ERR-R07 · literal
  "error.notEnoughCredits.title": "Not enough credits. Top up or upgrade to continue.", // ERR-R08 · literal
  "error.notEnoughCreditsRemaining.title":
    "Not enough credits to generate the remaining images.", // ERR-R08 · literal

  /* ---------------------------------------------------------- billing §19.9 */
  "billing.planLimitReached": "Plan content limit reached", // literal
  "billing.notIncluded": "This content isn't included in your plan.", // literal
  "billing.someNotIncluded": "Some items are not included in your plan", // literal
  "billing.viewOnly": "Your content is view-only. Upgrade to create and publish again.", // literal
  "billing.requiresSitePlan": "Requires a Site plan", // literal
  "billing.upgradeToUnlock": "Upgrade to unlock", // literal

  /* ------------------------------------------------------- media en uso §19.10 */
  "error.mediaInUse.title":
    "The asset is still referenced. Remove the dependency or delete the content before retrying.", // ERR-P/§19.10 · paráfrasis

  /* -------------------------------------------------------------- toasts §3.5 */
  "toast.buildingPost": "Building post!", // literal
  "toast.buildingPostTikTok":
    "Building post! It may take a few minutes to appear on TikTok.", // literal
  "toast.contentSaved": "Content saved!", // literal
  "toast.postingSoon": "Posting in ~5 minutes!", // literal
  "toast.allChangesSaved": "All changes saved", // literal
  "toast.subscriptionActivated": "Subscription activated!", // literal
  "toast.feedbackThanks": "Thanks for your feedback!", // literal
  "toast.workspaceReady": "Workspace ready!", // literal
  "toast.viewInLibrary": "View in Library", // literal · acción del toast

  /* ----------------------------------------------- copy propio de componentes */
  "pagination.label": "Pagination",
  "pagination.pageXofY": "Page {current} of {total}", // §3.4 M-01 · literal
  "pagination.previous": "Previous",
  "pagination.next": "Next",
  "pagination.goToPage": "Go to page {page}",
  "pagination.morePages": "More pages",
  "dialog.close": "Close",
  "drawer.close": "Close",
  "toast.dismiss": "Dismiss",
  "toast.region": "Notifications",
  "avatar.fallbackLabel": "{name} avatar",

  /* ------------------------------ Shell 2026 · PU-UI-001 (copy nuevo, no PRD) */
  // Todo este bloque lo escribió la sesión del sprint 1 de uso personal
  // (PRD §2.7 D-07, D-15; PLAN-USO-PERSONAL §7). Ninguna clave es literal.
  "nav.studio": "Studio",
  "nav.automations": "Automations",
  "nav.toolsLabel": "Tools",
  "nav.footerLabel": "Help and settings",
  "nav.search": "Search",
  "nav.searchShortcut": "Search or jump to…",
  "settings.nav.label": "Settings sections",
  "settings.nav.general": "General",
  "settings.nav.brands": "Brands",
  "settings.nav.models": "Models",
  "settings.nav.strategy": "Strategy", // PU-BRAND-002
  "settings.nav.integrations": "Integrations", // PU-PUB-002
  "settings.nav.connections": "Connections", // PU-PUB-002
  "settings.nav.notifications": "Notifications", // P5-NOTIF-002

  /* ------------------------- Marcas (workspaces) · PU-BRAND-001, D-07 (nuevo) */
  "brands.switcherLabel": "Switch brand",
  "brands.menuLabel": "Brands",
  "brands.new": "New brand",
  "brands.manage": "Manage brands",
  "brands.loading": "Loading brands…",
  "brands.loadError": "Couldn't load your brands.",
  "brands.empty": "No brands yet. Create the first one.",
  "brands.active": "Active",
  "brands.switch": "Switch",
  "brands.switched": "Switched to {name}",
  "brands.invalidReset":
    "That brand is no longer available. You're back on your default brand.",
  "brands.status.pending": "Not analysed yet",
  "brands.status.ready": "Analysed",
  "brands.status.failed": "Analysis failed",
  "brands.status.partial": "Partially analysed",
  "brands.page.title": "Brands",
  "brands.page.description":
    "Each brand is its own workspace: connections, strategy and queue.",
  "brands.page.standardMode": "Multiple brands are only available in personal mode.",
  "brands.create.title": "New brand",
  "brands.create.description":
    "Just a name for now. You'll teach FastGram about it on the Brand page.",
  "brands.create.nameLabel": "Brand name",
  "brands.create.namePlaceholder": "e.g. Acme Coffee",
  "brands.create.submit": "Create brand",
  "brands.name.required": "Enter a name.",
  "brands.name.tooLong": "Use 80 characters or fewer.",
  "brands.created.title": "Brand created",
  "brands.created.description":
    "\u201c{name}\u201d is ready. Analyse it now so FastGram learns its voice.",
  "brands.created.setUp": "Switch and analyse",
  "brands.created.later": "Later",
  "brands.rename": "Rename",
  "brands.rename.label": "New name for {name}",
  "brands.rename.save": "Save",
  "brands.renamed": "Brand renamed",
  "brands.delete": "Delete",
  "brands.delete.title": "Delete \u201c{name}\u201d?",
  "brands.delete.body":
    "Its connections, strategy and queue go with it. You can't undo this from the app.",
  "brands.delete.confirm": "Delete brand",
  "brands.delete.lastBrand":
    "You can't delete your only brand. Create another one first.",
  "brands.deleted": "Brand deleted",

  /* ------------------------------------------ Command palette ⌘K (nuevo) */
  "command.label": "Command palette",
  "command.placeholder": "Type a command or search…",
  "command.empty": "No results.",
  "command.group.brands": "Brands",
  "command.group.navigation": "Go to",
  "command.group.theme": "Theme",
  "command.switchTo": "Switch to {name}",
  "command.group.create": "Create", // nuevo · PU-BLITZ-003
  "command.createFromPrompt": "Create from prompt…", // nuevo · PU-BLITZ-003
  "command.saveInspiration": "Save inspiration from link…", // nuevo · Inspiration (OQ-13)
  "command.themeLight": "Use light theme",
  "command.themeDark": "Use dark theme",
  "command.themeSystem": "Match system theme",

  /* ------------------- Media Bank · subida · PU-MEDIA-001, FR-100 (nuevo) */
  // Copy nuevo, ninguna clave es literal del PRD. Prefijo `mediaUpload.` para no
  // chocar con las `media.*` del catálogo local de `apps/web`.
  "mediaUpload.upload": "Upload",
  "mediaUpload.inputLabel": "Upload images or videos",
  "mediaUpload.dropzone.title": "Drop images or videos here",
  "mediaUpload.dropzone.hint":
    "JPG, PNG or WebP up to {imageMax} MB · MP4 or MOV up to {videoMax} MB. Several at once.",
  "mediaUpload.dropzone.browse": "Browse files",
  "mediaUpload.dropzone.overlay": "Drop to upload",
  "mediaUpload.empty.description":
    "Drag images or videos here, or upload them from your computer. Once they're in, Blitz and the Studio can use them.",
  "mediaUpload.empty.action": "Upload media",
  "mediaUpload.queue.title": "Uploads",
  "mediaUpload.queue.progress": "{done} of {total} uploaded",
  "mediaUpload.queue.clear": "Clear finished",
  "mediaUpload.phase.queued": "Waiting…",
  "mediaUpload.phase.reserving": "Preparing…",
  "mediaUpload.phase.uploading": "Uploading {percent}%",
  "mediaUpload.phase.uploadingUnknown": "Uploading…",
  "mediaUpload.phase.finalizing": "Finishing…",
  "mediaUpload.phase.done": "Uploaded",
  "mediaUpload.phase.processing": "Uploaded · processing video…",
  "mediaUpload.phase.processingFailed": "Uploaded, but the video couldn't be processed",
  "mediaUpload.phase.cancelled": "Cancelled",
  "mediaUpload.progressLabel": "Upload progress for {name}",
  "mediaUpload.failed.transfer": "The upload was interrupted.",
  "mediaUpload.failed.finalize": "The file is up, but we couldn't finish adding it.",
  "mediaUpload.rejected.empty": "This file is empty.",
  "mediaUpload.rejected.tooLarge": "{size} MB — {kind} can be up to {max} MB.",
  "mediaUpload.rejected.unsupported": "Only JPG, PNG, WebP, MP4 and MOV files.",
  "mediaUpload.rejected.extensionMismatch": "The file extension doesn't match its type.",
  "mediaUpload.kind.image": "images",
  "mediaUpload.kind.video": "videos",
  "mediaUpload.retry": "Retry",
  "mediaUpload.retryAria": "Retry {name}",
  "mediaUpload.cancelAria": "Cancel upload of {name}",
  "mediaUpload.dismissAria": "Remove {name} from the list",
  "mediaUpload.categories.label": "Use it as",
  "mediaUpload.categories.groupLabel": "Categories for {name}",
  "mediaUpload.categories.save": "Save",
  "mediaUpload.categories.saved": "Categories saved",
  "mediaUpload.categories.skip": "Skip",
  "mediaUpload.categories.skipped":
    "No categories — Blitz won't pick it until you add some.",
  "mediaUpload.categories.applyToAll.image": "Apply to all {count} images",
  "mediaUpload.categories.applyToAll.video": "Apply to all {count} videos",
  "mediaUpload.categories.noneHint": "No categories: Blitz won't pick it automatically.",
  "mediaUpload.categories.saveFailed": "Couldn't save the categories.",
  "mediaUpload.category.slideshowImage": "Slideshow image",
  "mediaUpload.category.greenScreenBackground": "Green screen background",
  "mediaUpload.category.backgroundVideo": "Background video",
  "mediaUpload.category.hookVideo": "Hook video",
  "mediaUpload.category.greenScreenVideo": "Green screen video",
  "mediaUpload.card.actionsLabel": "Actions for {name}",
  "mediaUpload.card.editAria": "Edit categories of {name}",
  "mediaUpload.card.deleteAria": "Delete {name}",
  "mediaUpload.edit.title": "Edit categories",
  "mediaUpload.edit.description": "Categories decide where Blitz can use {name}.",
  "mediaUpload.edit.save": "Save categories",
  "mediaUpload.delete.title": "Delete “{name}”?",
  "mediaUpload.delete.body": "It leaves your Media Bank and Blitz stops picking it.",
  "mediaUpload.delete.confirm": "Delete",
  /* --------------------------- Editor · PU-EDIT-003/004, FR-051…053, FR-071 */
  // Copy nuevo salvo donde dice «literal» (el PRD da esos textos tal cual).
  "editor.title": "Edit content",
  "editor.back": "Back to the piece",
  "editor.loading": "Loading the editor…",
  "editor.notFound": "This piece doesn't exist or isn't in this brand.",
  "editor.notEditable": "This piece can't be edited here.",
  "editor.noBoxes": "This piece has no editable text boxes.",
  "editor.buildingBlocked": "This piece is building. You can edit it when it's ready.",
  "editor.failedBlocked": "This piece failed to build, so there's nothing to edit.",
  "editor.view.label": "View",
  "editor.view.preview": "Preview",
  "editor.view.rendered": "Rendered",
  "editor.rendered.empty": "No render yet.",
  "editor.rendered.stale": "This is the previous render. The new one is building.",
  "editor.canvas.label":
    "Canvas preview. Select a text box and drag it, or use the arrow keys (Shift moves 5%).",
  "editor.canvas.box": "Text box {n}: {text}",
  "editor.canvas.boxEmpty": "Text box {n} (empty)",
  "editor.canvas.resize": "Resize text box {n}",
  "editor.canvas.video": "Meme video. Drag to reposition.",
  "editor.canvas.mediaError": "Couldn't load this media.",
  "editor.canvas.noMedia": "No background",
  "editor.keyboardHint": "Arrows move 1% · Shift + arrows 5%",
  "editor.deleteNotAllowed":
    "Text boxes can't be removed from a piece; clear the text instead.",
  "editor.slides.label": "Slides",
  "editor.slides.item": "Slide {n}",
  "editor.slides.previous": "Previous slide",
  "editor.slides.next": "Next slide",
  "editor.slides.counter": "{current} / {total}",
  "editor.assets.title": "Assets",
  "editor.assets.video": "Video", // literal
  "editor.assets.audio": "Audio", // literal
  "editor.assets.imageSet": "Image Set", // literal
  "editor.assets.image": "Image",
  "editor.assets.background": "Background",
  "editor.assets.greenScreenVideo": "Green screen meme",
  "editor.assets.hookVideo": "Hook video",
  "editor.assets.demoVideo": "Demo video",
  "editor.assets.audioTrack": "Audio track", // literal
  "editor.assets.noAudio": "No audio", // literal
  "editor.assets.slideImage": "Slide {n} image",
  "editor.assets.swap": "Swap", // literal
  "editor.assets.changed": "Changed · save to apply",
  "editor.mention.label": "Mention your business?", // literal (MENTION YOUR BUSINESS?)
  "editor.mention.yes": "Yes", // literal
  "editor.mention.no": "No", // literal
  "editor.prompt.label": "Prompt", // literal
  "editor.prompt.placeholder": "Optional instructions for regeneration…", // literal
  "editor.prompt.counter": "{count}/{max}",
  "editor.prompt.tooLong": "Use {max} characters or fewer.",
  "editor.regenerate": "Regenerate Text", // literal
  "editor.regenerating": "Regenerating…",
  "editor.regenerate.dirty": "Save or discard your changes before regenerating.",
  "editor.regenerate.failed":
    "Couldn't regenerate the text. The previous version is still available.",
  "editor.text.title": "Text", // literal
  "editor.text.noSelection": "Select a text box on the canvas to style it.",
  "editor.text.content": "Content",
  "editor.text.applyAll": "Apply to all text boxes", // literal
  "editor.text.font": "Font",
  "editor.text.fontFallback":
    "This font isn't available to the render yet. It comes out in Inter.",
  "editor.text.weight": "Weight: {weight}", // literal `Weight: <Medium>`
  "editor.text.size": "Size: {size}px", // literal `Size: <18px>`
  "editor.text.width": "Width: {width}%",
  "editor.text.color": "Color", // literal
  "editor.text.stroke": "Stroke: {width}px", // literal `Stroke: <3px>`
  "editor.text.strokeColor": "Stroke Color", // literal
  "editor.text.background": "Background", // literal
  "editor.text.bgNone": "None", // literal
  "editor.text.bgPill": "Pill",
  "editor.text.bgFullWidth": "Full width",
  "editor.text.bgColor": "Background color",
  "editor.text.bgOpacity": "Opacity: {opacity}%",
  "editor.text.bgRenderNote":
    "The render draws any background as a solid pill for now: opacity and full width don't reach the video yet.",
  "editor.text.hex": "{label} hex",
  "editor.weight.300": "Light",
  "editor.weight.400": "Regular",
  "editor.weight.500": "Medium",
  "editor.weight.600": "Semibold",
  "editor.weight.700": "Bold",
  "editor.video.title": "Video", // literal
  "editor.video.zoom": "Zoom: {zoom}%", // literal `Zoom: 100%`
  "editor.video.reset": "Reset Position", // literal
  "editor.video.dragHint": "Drag video to reposition", // literal
  "editor.caption.title": "Caption",
  "editor.caption.unavailable":
    "A piece has no caption of its own: you write it per network when you schedule the post.",
  "editor.save": "Save changes",
  "editor.saving": "Saving…",
  "editor.discard": "Discard",
  "editor.done": "Done Editing", // literal
  "editor.unsaved": "Unsaved changes",
  "editor.rebuilding": "Rebuilding the piece with your changes…",
  "editor.rebuilt": "Render updated.",
  "editor.editFailed":
    "The last edit couldn't be rendered. The previous version is still available.",
  "editor.stale": "Someone else changed this piece. Reload to get the latest version.",
  "editor.reload": "Reload",
  "editor.invalidMedia": "Pick media from your Media Bank.",
  "editor.picker.selectVideo": "Select Video", // literal
  "editor.picker.swapImage": "Swap image for slide {n}", // literal
  "editor.picker.selectImage": "Select Image",
  "editor.picker.myVideos": "My Videos", // literal
  "editor.picker.myImages": "My Images", // literal
  "editor.picker.library": "Library", // literal
  "editor.picker.libraryEmpty": "There's no shared library yet. Use your own media.",
  "editor.picker.empty": "Nothing here yet. Upload media to your Media Bank first.",
  "editor.picker.filteredEmpty": "No media matches these filters.",
  "editor.picker.error": "Couldn't load your media.",
  "editor.picker.retry": "Try again",
  "editor.picker.filter": "Filter:", // literal
  "editor.picker.clear": "Clear", // literal
  "editor.picker.loadMore": "Load more",
  "editor.picker.cancel": "Cancel", // literal
  "editor.picker.swap": "Swap", // literal
  "editor.picker.selected": "New image selected", // literal
  "editor.picker.category.slideshowImage": "Slideshow image",
  "editor.picker.category.greenScreenBackground": "Green screen background",
  "editor.picker.category.backgroundVideo": "Background video",
  "editor.picker.category.hookVideo": "Hook video",
  "editor.picker.category.greenScreenVideo": "Green screen video",
  "editor.audio.title": "Select Audio", // literal
  "editor.audio.empty": "The shared audio library is empty.",
  "editor.audio.error": "Couldn't load the audio library.",
  // Por qué falló la última edición o el Regenerate: `lastEdit.failureReason`,
  // un código estable del worker (`apps/worker/src/content/build-handler.ts`).
  "editor.failure.llm_not_configured": "There's no AI model set up to write the text.",
  "editor.failure.llmLink": "Set one up in Settings → Models",
  "editor.failure.llm_failed": "The AI model didn't answer. Try again in a moment.",
  "editor.failure.copy_rejected":
    "The AI model's text didn't pass our checks, so we kept the previous one. Try again, or change the prompt.",
  "editor.failure.edit_not_renderable":
    "The render can't draw some of these changes yet. Undo the last change and save again.",
  /* ------------------------------- Today · PU-UI-002, PLAN-USO-PERSONAL §7 */
  // Copy nuevo, ninguna clave es literal del PRD salvo el camino de TikTok
  // (`Inbox → System notifications → Post`, FR-060 PRD:1410).
  "nav.today": "Today",
  "today.title": "Today",
  "today.greeting.morning": "Good morning",
  "today.greeting.afternoon": "Good afternoon",
  "today.greeting.evening": "Good evening",
  "today.subtitle.all": "{date} · all your brands",
  "today.subtitle.one": "{date}",
  "today.counter.posted": "Posted today",
  "today.counter.scheduled": "Scheduled today",
  "today.counter.approval": "Waiting for approval",
  "today.counter.failed": "Failed · last 7 days",
  "today.counter.unavailable": "Not available",
  "today.timeline.title": "Today's timeline",
  "today.timeline.empty": "Nothing is going out today.",
  "today.timeline.itemLabel": "{brand}, {network}, {time}, {status}. Open the piece",
  "today.status.planned": "Planned · no account yet",
  "today.status.scheduled": "Scheduled",
  "today.status.publishing": "Publishing…",
  "today.status.posted": "Posted",
  "today.status.failed": "Failed",
  "today.status.draft": "TikTok draft · finish in the app",
  "today.status.reconnect": "Needs reconnect",
  "today.viewPost": "View post",
  "today.failedFallback": "Open the piece to see what went wrong.",
  "today.drafts.title": "Finish these in the TikTok app",
  "today.drafts.body":
    "TikTok saved them as drafts. They aren't live until you post them yourself.",
  "today.drafts.step1": "Open the TikTok app on your phone.",
  "today.drafts.step2": "Go to Inbox → System notifications.", // literal (camino, PRD:1410)
  "today.drafts.step3": "Open the draft and tap Post.", // literal (`Post`, PRD:1410)
  "today.drafts.since": "Waiting since {date}",
  "today.drafts.markPosted": "Mark as posted",
  "today.drafts.marking": "Marking…",
  "today.drafts.marked": "Marked as posted.",
  "today.drafts.markFailed": "Couldn't mark it as posted.",
  "today.drafts.older":
    "{count} older drafts aren't listed here. Find them in the Calendar.",
  "today.approval.title": "Waiting for approval",
  "today.approval.cardsOne": "1 card",
  "today.approval.cardsMany": "{count} cards",
  "today.approval.none": "Nothing waiting",
  "today.approval.review": "Review",
  "today.approval.current": "Current brand",
  "today.failed.title": "Failed recently",
  "today.failed.empty": "Nothing failed in the last 7 days.",
  "today.failed.open": "Open",
  "today.empty.title": "A quiet day",
  "today.empty.body":
    "Nothing is scheduled for today. Approve a few ideas in Blitz or create one from a prompt.",
  "today.empty.blitz": "Open Blitz",
  "today.empty.prompt": "Create from prompt",
  "today.error": "Couldn't load today's plan.",
  "today.truncated":
    "One of your brands has more items than the calendar returns at once, so this list may be incomplete.",
  // Piloto automático · PU-AUTO-002/003 (D-08). Copy nuevo, nada literal del PRD.
  "autopilot.card.title": "Autopilot",
  "autopilot.card.subtitle": "What the autopilot did today",
  "autopilot.card.approved": "{count} approved",
  "autopilot.card.rejected": "{count} rejected",
  "autopilot.card.held": "{count} waiting for you",
  "autopilot.card.generated": "{count} generated",
  "autopilot.card.published": "{count} published",
  "autopilot.card.failed": "{count} failed",
  "autopilot.card.nothing": "Nothing decided yet today.",
  "autopilot.card.reviewRejected": "Review rejected ({count})",
  "autopilot.card.hideRejected": "Hide rejected",
  "autopilot.card.reviewHeld": "Review in Blitz",
  "autopilot.card.lastRun": "Last run {time}",
  "autopilot.card.neverRan": "Hasn't run yet.",
  "autopilot.card.error": "Couldn't load the autopilot summary.",
  "autopilot.card.retry": "Retry",
  "autopilot.card.truncated": "Long day: this list may be incomplete.",
  "autopilot.outcome.no_llm": "Paused: no text model set up (Settings → Models).",
  "autopilot.outcome.no_judgment":
    "Paused: no model for the pre-check (Settings → Models).",
  "autopilot.outcome.invalid_strategy":
    "Paused: its strategy couldn't be read. Save it again.",
  "autopilot.outcome.profile_not_ready": "Paused: finish the brand profile first.",
  "autopilot.outcome.error": "The last run failed. It retries on its own.",
  "autopilot.reason.off_brand": "Off-topic for the brand",
  "autopilot.reason.health_claim": "Health claim",
  "autopilot.reason.financial_claim": "Money or investment claim",
  "autopilot.reason.legal_claim": "Legal claim",
  "autopilot.reason.third_party_brand": "Mentions another brand",
  "autopilot.reason.incoherent": "Text doesn't read well",
  "autopilot.reason.wrong_language": "Wrong language",
  "autopilot.reason.unbuildable": "Couldn't be built (media missing)",
  "autopilot.reason.judgment_timeout": "Pre-check timed out",
  "autopilot.reason.judgment_unavailable": "Pre-check unavailable",
  "autopilot.banner.onOne": "Autopilot is on for this brand — 1 approved today",
  "autopilot.banner.onMany": "Autopilot is on for this brand — {count} approved today",
  "autopilot.banner.hint":
    "Pieces that pass the pre-check approve and schedule themselves. What's left here is for you.",
  "autopilot.banner.settings": "Autopilot settings",

  /* ------------- AI Studio · PU-LATER-005, PU-MODEL-003…005 (FR-090 adaptado) */
  "aiStudio.title": "AI Studio",
  "aiStudio.subtitle":
    "Generate images and clips for this brand with your own Higgsfield or fal account. Every result lands in the Media Bank.",
  "aiStudio.kind.label": "Type",
  "aiStudio.kind.image": "Image",
  "aiStudio.kind.video": "Video",
  "aiStudio.prompt.label": "Prompt",
  "aiStudio.prompt.placeholder":
    "Describe the image or clip: subject, setting, light and style.",
  "aiStudio.model.label": "Model",
  "aiStudio.model.docs": "Model docs",
  "aiStudio.aspect.label": "Aspect ratio",
  "aiStudio.aspect.fromImage": "Follows the start image",
  "aiStudio.count.label": "How many",
  "aiStudio.duration.label": "Duration",
  "aiStudio.duration.value": "{seconds}s",
  "aiStudio.image.label": "Start image URL",
  "aiStudio.image.hint":
    "A public https:// link the provider can download. Media Bank links only work with the public media tunnel on.",
  "aiStudio.estimate.label": "Estimated cost",
  "aiStudio.estimate.loading": "Estimating…",
  "aiStudio.estimate.idle": "Write a prompt to see the cost.",
  "aiStudio.estimate.provider": "Quoted by {provider} for your account",
  "aiStudio.estimate.priceList": "List price estimate · {basis}",
  "aiStudio.estimate.error": "Couldn't estimate the cost.",
  "aiStudio.estimate.overBudget": "Over this month's budget: {remaining} left.",
  "aiStudio.budget.label": "AI budget this month",
  "aiStudio.budget.value": "{spent} of {budget}",
  "aiStudio.budget.reserved": "{reserved} in progress",
  "aiStudio.budget.manage": "Manage budget",
  "aiStudio.generate": "Generate",
  "aiStudio.generating": "Starting…",
  "aiStudio.generate.error": "Couldn't start the generation.",
  "aiStudio.generate.budgetExceeded":
    "That would go over this month's AI budget. Raise it in Settings → Models or wait for next month.",
  "aiStudio.generate.started": "Generation started. It shows up below when it's ready.",
  "aiStudio.setup.title": "Connect an image or video model",
  "aiStudio.setup.body":
    "AI Studio uses your own Higgsfield or fal account. Add a key in Settings → Models to start.",
  "aiStudio.setup.action": "Open Settings → Models",
  "aiStudio.setup.kindMissing": "No {kind} model is set up yet.",
  "aiStudio.optionsError": "Couldn't load AI Studio.",
  "aiStudio.gallery.title": "Generations",
  "aiStudio.gallery.error": "Couldn't load your generations.",
  "aiStudio.status.queued": "Queued",
  "aiStudio.status.generating": "Generating",
  "aiStudio.status.ready": "Ready",
  "aiStudio.status.failed": "Failed",
  "aiStudio.status.nsfw": "Blocked",
  "aiStudio.status.canceled": "Canceled",
  "aiStudio.card.inMediaBank": "In Media Bank",
  "aiStudio.card.useInBlitz": "Use in Blitz",
  "aiStudio.card.cost": "≈ {cost}",
  "aiStudio.card.working": "The provider is working on it…",
  "aiStudio.error.nsfw_rejected":
    "The provider's content filter blocked the prompt or the result. You weren't charged.",
  "aiStudio.error.generation_failed":
    "The provider couldn't generate it. You weren't charged.",
  "aiStudio.error.provider_unavailable": "The provider is unavailable right now.",
  "aiStudio.error.quota_exceeded": "Your provider account is out of credits.",
  "aiStudio.error.budget_exceeded": "Over this month's AI budget.",
  "aiStudio.error.rate_limited": "The provider is busy. Try again in a moment.",
  "aiStudio.error.unauthorized":
    "The provider rejected the saved key. Check Settings → Models.",
  "aiStudio.error.bad_request": "The provider rejected the request.",
  "aiStudio.error.not_found": "The provider doesn't know that model or request.",
  "aiStudio.error.timeout": "The provider didn't finish in time. It may still be billed.",
  "aiStudio.error.provider_contract_violation":
    "The provider answered something unexpected.",
  "aiStudio.error.not_configured": "The model is no longer set up in Settings → Models.",
  "aiStudio.error.download_failed": "The result couldn't be copied to your storage.",

  /* --------- Analytics · P3-ANALYT-001/002 (FR-120, F-171, F-172), PU-AUTO-004 */
  "analytics.title": "Analytics", // literal nav PRD §3.2
  "analytics.subtitle": "Track your content performance across all platforms.", // literal FR-120
  "analytics.range.label": "Range", // nuevo
  "analytics.range.days": "{n} days", // literal FR-120 (`<N> days`)
  "analytics.scope.label": "Brands", // nuevo
  "analytics.scope.current": "This brand", // nuevo
  "analytics.scope.all": "All brands", // nuevo
  "analytics.sync.now": "Sync now", // nuevo
  "analytics.sync.queued": "Sync requested. New numbers show up in a few minutes.", // nuevo
  "analytics.sync.already": "A sync for this brand is already on its way.", // nuevo
  "analytics.sync.failed": "Couldn't request a sync. Try again in a moment.", // nuevo
  // NFR-016: "las métricas reflejan la última sincronización".
  "analytics.lastSynced": "Numbers as of the last sync, {ago}.", // nuevo
  "analytics.neverSynced": "No metrics have been synced for this range yet.", // nuevo
  "analytics.pendingSync":
    "{count} published posts are waiting for their first sync. They aren't counted as zero.", // nuevo · FR-120 criterio 2
  "analytics.totals.posts": "Posts", // nuevo
  "analytics.totals.views": "Views", // nuevo
  "analytics.totals.likes": "Likes", // nuevo
  "analytics.totals.comments": "Comments", // nuevo
  "analytics.totals.shares": "Shares", // nuevo
  "analytics.totals.engagement": "Engagement rate", // nuevo
  "analytics.totals.engagementHint":
    "(likes + comments + shares) ÷ views, over posts that report views.", // nuevo
  "analytics.totals.notReported": "Not reported by these networks", // nuevo
  "analytics.byNetwork.title": "By network", // nuevo
  "analytics.byNetwork.posts": "{network} posts", // literal F-171 (`TikTok posts`, …)
  "analytics.byNetwork.noMetrics": "No metrics via API", // nuevo
  "analytics.byFormat.title": "By content type", // nuevo
  "analytics.format.slideshow": "Slideshow", // literal F-172
  "analytics.format.wall-of-text": "Wall of Text", // literal F-172
  "analytics.format.green-screen": "Green Screen", // literal F-172
  "analytics.format.video-hook": "Hook & Demo", // literal F-172
  "analytics.format.custom": "Custom", // literal F-070
  "analytics.top.title": "Top posts", // nuevo
  "analytics.top.empty": "No synced posts in this range yet.", // nuevo
  "analytics.top.open": "Open on the platform", // nuevo
  "analytics.top.noCaption": "Untitled post", // nuevo
  "analytics.unsupported":
    "{networks}: posts published as drafts can't be measured through the API, so they stay without numbers.", // nuevo
  "analytics.xNote":
    "X metrics are read only when METRICS_X_ENABLED is on: X bills every post read.", // nuevo
  "analytics.issue.metrics_reconnect_required":
    "{count} posts: the account needs to be reconnected to read metrics.", // nuevo
  "analytics.issue.metrics_permission_missing":
    "{count} posts: the account didn't grant permission to read insights. Reconnect it to allow it.", // nuevo
  "analytics.issue.metrics_unavailable":
    "{count} posts: the platform didn't return metrics.", // nuevo
  "analytics.issue.not_found_on_platform":
    "{count} posts: no longer found on the platform.", // nuevo
  "analytics.issue.action": "Open Connections", // nuevo
  "analytics.truncated":
    "Some brands have more posts than this page reads. Totals are partial.", // nuevo
  "analytics.empty.title": "No metrics yet", // nuevo
  "analytics.empty.body":
    "No metrics yet: connect accounts and publish. Numbers show up here after the first sync.", // nuevo
  "analytics.empty.connect": "Connect accounts", // nuevo
  "analytics.error": "Couldn't load analytics.", // nuevo
  "analytics.mix.title": "Content mix", // nuevo
  "analytics.mix.hint": "The format weights Blitz uses to generate for this brand.", // nuevo
  "analytics.mix.autotune": "Auto-tune content mix", // nuevo
  "analytics.mix.autotuneHint":
    "Once a week, moves up to 10 points toward the formats that engage best on each network. Formats at 0 stay off, and every other format keeps at least 5.", // nuevo
  "analytics.mix.autotuneFailed": "Couldn't change auto-tune. Try again.", // nuevo
  "analytics.mix.lastRun": "Last check {when}: {outcome}.", // nuevo
  "analytics.mix.neverRun": "Not checked yet. The first check runs within the hour.", // nuevo
  "analytics.mix.outcome.changed": "adjusted", // nuevo
  "analytics.mix.outcome.single_active_format": "only one format is on", // nuevo
  "analytics.mix.outcome.insufficient_data": "not enough measured posts yet", // nuevo
  "analytics.mix.outcome.no_significant_difference": "no clear winner, left as is", // nuevo
  "analytics.mix.history": "Changes", // nuevo
  "analytics.mix.historyEmpty": "No automatic changes yet.", // nuevo
  "analytics.mix.change": "{date} · by auto-tune", // nuevo
  "analytics.mix.samples": "{n} measured posts", // nuevo
  "analytics.mix.error": "Couldn't load the content mix.", // nuevo

  /* ------- Inspiration · tablero de referencias propio · FR-040 adaptado (nuevo) */
  // `OQ-13`: sin catálogo de terceros. Lo marcado `literal` sale de FR-040.
  "inspiration.title": "Inspiration", // literal PRD:342
  "inspiration.subtitle":
    "Your own board of references. Save posts you like and remix them for this brand.", // nuevo
  "inspiration.save": "Save inspiration", // nuevo
  "inspiration.searchLabel": "Search inspiration", // literal FR-040
  "inspiration.clearSearch": "Clear search", // literal FR-040
  "inspiration.clearAll": "Clear all", // literal §12
  "inspiration.filter.format": "Format", // nuevo
  "inspiration.filter.tag": "Filter by tag", // nuevo (FR-040 dice «Filter by niche»)
  "inspiration.filter.all": "All", // nuevo
  "inspiration.format.video": "Video", // nuevo
  "inspiration.format.slideshow": "Slideshow", // nuevo
  "inspiration.format.image": "Image", // nuevo
  "inspiration.format.text": "Text", // nuevo
  "inspiration.error": "We could not load inspiration right now. Try again in a moment.", // literal FR-040
  "inspiration.emptyBoard.title": "No references yet", // nuevo
  "inspiration.emptyBoard.description":
    "Paste a link to a TikTok, Reel, Short or post you like. We read what's public and keep it here to remix.", // nuevo
  "inspiration.page": "Page {page}", // nuevo
  "inspiration.card.pending": "Reading the link…", // nuevo
  "inspiration.card.failed": "Couldn't read this link. You can still remix it.", // nuevo
  "inspiration.card.open": "Open original", // literal FR-040
  "inspiration.card.remix": "Remix this", // literal FR-040
  "inspiration.card.delete": "Delete", // nuevo
  "inspiration.card.deleteFailed": "Couldn't delete it. Try again.", // nuevo
  "inspiration.card.views": "{count} views", // nuevo
  "inspiration.card.likes": "{count} likes", // nuevo
  "inspiration.card.fromMediaBank": "From your Media Bank", // nuevo
  "inspiration.card.untitled": "Untitled reference", // nuevo
  "inspiration.card.onScreen": "On screen: {text}", // nuevo
  "inspiration.saveDialog.title": "Save inspiration", // nuevo
  "inspiration.saveDialog.description":
    "We read the title, caption, author and public counts without logging in. Transcripts aren't read.", // nuevo
  "inspiration.saveDialog.fromLink": "From a link", // nuevo
  "inspiration.saveDialog.fromMediaBank": "From my Media Bank", // nuevo
  "inspiration.saveDialog.urlLabel": "Link", // nuevo
  "inspiration.saveDialog.tagsLabel": "Tags", // nuevo
  "inspiration.saveDialog.tagsHint": "Optional. Separate with commas, up to {max}.", // nuevo
  "inspiration.saveDialog.saveClip": "Also save the video to my Media Bank", // nuevo
  "inspiration.saveDialog.rights":
    "Only save what you have the right to use. You're responsible for what you publish.", // nuevo · D-12
  "inspiration.saveDialog.pickClip": "Pick a clip", // nuevo
  "inspiration.saveDialog.mediaEmpty":
    "Your Media Bank is empty. Upload a clip in Library first.", // nuevo
  "inspiration.saveDialog.submit": "Save", // nuevo
  "inspiration.saveDialog.saving": "Saving…", // nuevo
  "inspiration.saveDialog.unsupportedUrl":
    "That link can't be read. Paste a public http(s) link.", // nuevo
  "inspiration.remix.title": "Remix this", // literal FR-040
  "inspiration.remix.description":
    "We'll write new pieces for this brand that borrow the post's hook, format and tone — never its words. They land at the top of Blitz.", // nuevo
  "inspiration.remix.noteLabel": "Note (optional)", // nuevo
  "inspiration.remix.notePlaceholder": "e.g. make it about our winter menu", // nuevo
  "inspiration.remix.formatLabel": "Format", // nuevo
  "inspiration.remix.formatAuto": "Match the reference", // nuevo
  "inspiration.remix.countLabel": "How many", // nuevo
  "inspiration.remix.submit": "Remix", // nuevo
  "inspiration.remix.running": "Writing your remixes…", // nuevo
  "inspiration.remix.done": "Your remixes are at the top of Blitz.", // nuevo
  "inspiration.remix.openBlitz": "Open Blitz", // nuevo
  "inspiration.remix.noteTooShort": "Write at least {min} characters, or leave it empty.", // nuevo
  /* ---------- Influencers · PU-LATER-004 (FR-080…FR-083 adaptados, Soul ID) */
  "influencers.title": "Influencers", // literal FR-080
  "influencers.subtitle": "Persistent AI characters — train once, generate endlessly.", // literal FR-080
  "influencers.new": "New influencer", // literal FR-080 (`+ New influencer`)
  "influencers.empty.title": "No influencers yet", // nuevo
  "influencers.empty.body":
    "Create a character from 4–20 photos of the same person. Their images can then show up in Blitz.", // nuevo
  "influencers.error": "Couldn't load your influencers.", // nuevo
  "influencers.setup.title": "Influencers need Higgsfield", // nuevo
  "influencers.setup.body":
    "Characters are created with Higgsfield Soul ID. Set Higgsfield as the image or video provider in Settings → Models.", // nuevo
  "influencers.setup.action": "Open Settings → Models", // nuevo
  "influencers.budget.exhausted":
    "This month's AI budget is used up. Raise it in Settings → Models to create a character.", // nuevo
  "influencers.status.generating_variations": "Uploading photos", // nuevo
  "influencers.status.training": "Training", // nuevo
  "influencers.status.ready": "Active", // literal FR-080 (badge `ACTIVE`)
  "influencers.status.failed": "Failed", // nuevo
  "influencers.status.inactive": "Inactive", // nuevo
  "influencers.progress": "{progress}%", // nuevo
  "influencers.failure.not_configured":
    "Higgsfield is no longer set up in Settings → Models.", // nuevo
  "influencers.failure.references_missing":
    "Some reference photos are gone from the Media Bank. Create the influencer again.", // nuevo
  "influencers.failure.upload_failed": "The photos couldn't be sent to Higgsfield.", // nuevo
  "influencers.failure.training_failed": "Higgsfield couldn't train this character.", // nuevo
  "influencers.failure.quota_exceeded": "Your Higgsfield account is out of credits.", // nuevo
  "influencers.failure.unauthorized":
    "Higgsfield rejected the saved key. Check Settings → Models.", // nuevo
  "influencers.failure.rate_limited": "Higgsfield is busy. Try again in a moment.", // nuevo
  "influencers.failure.provider_unavailable": "Higgsfield is unavailable right now.", // nuevo
  "influencers.failure.bad_request": "Higgsfield rejected the request.", // nuevo
  "influencers.failure.timeout": "Higgsfield didn't finish in time.", // nuevo
  "influencers.failure.provider_contract_violation":
    "Higgsfield answered something unexpected.", // nuevo
  "influencers.wizard.title": "New influencer ({step}/3)", // literal FR-080
  "influencers.wizard.back": "Back", // literal FR-080
  "influencers.wizard.next": "Next", // literal FR-080
  "influencers.wizard.cancel": "Cancel", // nuevo
  "influencers.wizard.create": "Create influencer", // literal FR-080
  "influencers.wizard.creating": "Creating…", // nuevo
  "influencers.wizard.name": "Name", // literal FR-080 (`NAME`)
  "influencers.wizard.traitsHint":
    "Optional. They label the character and drive Blitz's gender filter; the look comes from the photos.", // nuevo
  "influencers.wizard.gender": "Gender", // literal FR-080
  "influencers.wizard.gender.none": "Not set", // nuevo
  "influencers.wizard.gender.female": "Female", // nuevo
  "influencers.wizard.gender.male": "Male", // nuevo
  "influencers.wizard.gender.other": "Other", // nuevo
  "influencers.wizard.age": "Age", // literal FR-080
  "influencers.wizard.age.set": "Set an age", // nuevo
  "influencers.wizard.ethnicity": "Ethnicity", // literal FR-080
  "influencers.wizard.details": "Additional details (optional)", // literal FR-080
  "influencers.wizard.detailsPlaceholder":
    "e.g. freckles, athletic build, curly red hair", // literal FR-080
  "influencers.wizard.photos.title": "Reference photos", // nuevo
  "influencers.wizard.photos.hint":
    "Pick {min}–{max} photos of the same person from the Media Bank: different angles and light, one face, no filters.", // nuevo
  "influencers.wizard.photos.count": "{count} selected", // nuevo
  "influencers.wizard.photos.empty":
    "The Media Bank has no images yet. Upload photos in the Library first.", // nuevo
  "influencers.wizard.photos.upload": "Upload in the Library", // nuevo
  "influencers.wizard.photos.more": "Load more", // nuevo
  "influencers.wizard.photos.error": "Couldn't load the Media Bank.", // nuevo
  "influencers.wizard.confirm.body":
    "Higgsfield will create {name} from {count} photos. It usually takes a few minutes; you can leave this page.", // nuevo
  "influencers.wizard.confirm.cost": "Cost", // literal FR-080 (`COST`)
  "influencers.wizard.confirm.costUnknown":
    "Not published by Higgsfield. It's charged to your Higgsfield credits and isn't counted in FastGram's budget.", // nuevo
  "influencers.wizard.error": "Couldn't create the influencer.", // nuevo
  "influencers.detail.back": "Influencers", // literal FR-081 (`‹ Influencers`)
  "influencers.detail.notFound":
    "We couldn't find this influencer. It may have been deleted.", // literal FR-080
  "influencers.detail.error": "Couldn't load this influencer.", // nuevo
  "influencers.detail.training":
    "Higgsfield is creating this character. Images can be generated once it's active.", // nuevo
  "influencers.detail.blitz": "Configure in Blitz →", // literal FR-081
  "influencers.detail.blitzHint":
    "Images generated here go to this influencer's slideshow set. Blitz uses them when Influencer frequency picks this character.", // nuevo
  "influencers.images.title": "Images", // literal FR-081
  "influencers.images.empty":
    "No images yet. Describe a scene below to generate the first ones.", // nuevo
  "influencers.images.error": "Couldn't load the images.", // nuevo
  "influencers.images.prompt": "Prompt", // nuevo
  "influencers.images.placeholder.female": "e.g. her at the beach", // literal FR-081
  "influencers.images.placeholder.male": "e.g. him at the beach", // literal FR-081
  "influencers.images.placeholder.other": "e.g. at the beach, golden hour", // nuevo
  "influencers.images.aspect": "Aspect ratio", // nuevo
  "influencers.images.count": "How many", // nuevo
  "influencers.images.generate": "Generate", // literal FR-081
  "influencers.images.generating": "Starting…", // nuevo
  "influencers.images.started": "Generating. The images show up here when they're ready.", // nuevo
  "influencers.images.failedToStart": "Couldn't start the generation.", // nuevo
  "influencers.images.estimate": "Estimated cost", // nuevo
  "influencers.images.estimating": "Estimating…", // nuevo
  "influencers.images.estimateIdle": "Write a prompt to see the cost.", // nuevo
  "influencers.images.overBudget": "Over this month's budget: {remaining} left.", // nuevo
  "influencers.images.budgetExceeded":
    "That would go over this month's AI budget. Raise it in Settings → Models or wait for next month.", // nuevo
  "influencers.images.pending": "Higgsfield is working on it…", // nuevo
  "influencers.images.video":
    "Video and Talking Head aren't available: Higgsfield doesn't document them with a character through its API.", // nuevo

  // Engagement (Reddit) · FR-140, MOD-014, P4-ENGAGE-006…012. `literal` = texto
  // de la UI de Fastlane citado en el PRD (FR-140 / F-197 / F-200); `nuevo` = nuestro.
  "engagement.connect": "Connect Reddit Account", // literal FR-140
  "engagement.noConnection": "No active Reddit connection", // literal FR-140
  "engagement.connectedAs": "Connected as u/{username}", // nuevo
  "engagement.reconnect": "Reconnect", // nuevo
  "engagement.disconnect": "Disconnect", // nuevo
  "engagement.expired":
    "Your Reddit connection expired. Reconnect it to keep discovering and sending.", // nuevo
  "engagement.policy.title": "Reddit API access needs Reddit's approval", // nuevo
  "engagement.policy.body":
    "Reddit requires explicit approval before any app uses its Data API, and written approval for commercial use. Until your app is approved, add posts by link, copy the reply and post it yourself — everything else works the same.", // nuevo
  "engagement.policy.link": "Read Reddit's Responsible Builder Policy", // nuevo
  "engagement.app.title": "Your Reddit app", // nuevo
  "engagement.app.hint":
    "Create a “web app” at reddit.com/prefs/apps and set this redirect URI:", // nuevo
  "engagement.app.clientId": "Client ID", // nuevo
  "engagement.app.clientSecret": "Client secret", // nuevo
  "engagement.app.secretSaved": "Saved — leave empty to keep it", // nuevo
  "engagement.app.username": "Your Reddit username (for the User-Agent)", // nuevo
  "engagement.app.save": "Save app", // nuevo
  "engagement.app.saved": "Reddit app saved", // nuevo
  "engagement.app.scopes": "Permissions requested: {scopes}", // nuevo
  "engagement.settings.subredditsTitle": "Configure discovery subreddits", // literal FR-140
  "engagement.settings.subreddits": "Subreddits (one per line or comma separated)", // nuevo
  "engagement.settings.keywords": "Keywords (optional — posts must mention one)", // nuevo
  "engagement.settings.discoveryEnabled": "Discover new leads every hour", // nuevo
  "engagement.settings.replyTitle": "Reply Settings", // literal FR-140
  "engagement.settings.tone": "Tone", // nuevo
  "engagement.settings.tone.casual": "Casual — sounds like a regular Redditor", // nuevo
  "engagement.settings.tone.professional":
    "Proper capitalization, polished, business-appropriate", // literal FR-140
  "engagement.settings.tone.friendly_expert":
    "Friendly expert — a practitioner helping a peer", // nuevo
  "engagement.settings.customRules": "Custom rules", // nuevo
  "engagement.settings.customRulesPlaceholder":
    "e.g. Never promise results. Always suggest a free option first.", // nuevo
  "engagement.settings.allowLinks":
    "Allow one link to our website when it genuinely helps", // nuevo
  "engagement.settings.save": "Save Changes", // literal FR-140
  "engagement.settings.saved": "Changes saved", // nuevo
  "engagement.settings.invalidSubreddits": "These subreddit names aren't valid: {names}", // nuevo
  "engagement.settings.invalidKeywords":
    "These keywords are too short or too long: {names}", // nuevo
  "engagement.discovery.run": "Fetch new leads", // nuevo
  "engagement.discovery.queued": "Discovering new Reddit leads", // literal FR-140
  "engagement.discovery.lastRun": "Last run {when}", // nuevo
  "engagement.discovery.rateLimited": "Rate limited - will retry {when}", // literal FR-140
  "engagement.discovery.needsSetup":
    "Connect Reddit and add subreddits to discover leads automatically.", // nuevo
  "engagement.views.all": "All Leads", // nuevo
  "engagement.views.top": "Top Scored Leads", // literal FR-140
  "engagement.views.engaged": "Most Engaged Leads", // literal FR-140
  "engagement.unseenOnly": "Unseen only", // literal FR-140
  "engagement.search": "Search leads", // nuevo
  "engagement.newActivity": "New activity", // literal FR-140
  "engagement.addManual": "Add a post by link", // nuevo
  "engagement.addManual.url": "Reddit post link", // nuevo
  "engagement.addManual.title": "Post title", // nuevo
  "engagement.addManual.body": "Post text (optional)", // nuevo
  "engagement.addManual.submit": "Add lead", // nuevo
  "engagement.addManual.invalidUrl":
    "Paste the link of a Reddit post (reddit.com/r/…/comments/…).", // nuevo
  "engagement.empty.title": "No leads yet", // nuevo
  "engagement.empty.body":
    "Try adjusting your filters or fetch new leads to discover conversations where your audience is seeking solutions.", // literal FR-140
  "engagement.list.error": "Couldn't load the leads.", // nuevo
  "engagement.tier.top": "Top", // nuevo
  "engagement.tier.general": "Lead", // nuevo
  "engagement.tier.pending": "Scoring…", // nuevo
  "engagement.tier.unscored": "Not scored", // nuevo
  "engagement.tier.manual": "Added by you", // nuevo
  "engagement.score": "Score {score}", // nuevo
  "engagement.comments": "{count} comments", // nuevo
  "engagement.selectLead": "Pick a lead to see the post and write a reply.", // nuevo
  "engagement.detail.title": "Post Details", // literal FR-140
  "engagement.detail.back": "Back to Leads", // literal FR-140
  "engagement.detail.viewOnReddit": "View on Reddit", // literal FR-140
  "engagement.detail.delete": "Delete lead", // literal FR-140
  "engagement.detail.notFoundTitle": "Lead Not Found", // literal FR-140
  "engagement.detail.notFoundBody":
    "This lead may have been deleted or is no longer available.", // literal FR-140
  "engagement.detail.error": "Couldn't load this lead.", // nuevo
  "engagement.detail.topComments": "Top comments", // nuevo
  "engagement.why.title": "Why this lead?", // literal FR-140
  "engagement.why.pending": "The explanation appears once the lead is scored.", // nuevo
  "engagement.why.buyingSignal": "Buying signal", // nuevo
  "engagement.why.fitToAudience": "Fits your audience", // nuevo
  "engagement.why.hasProblem": "Has a problem you solve", // nuevo
  "engagement.why.replyWelcome": "A reply is welcome", // nuevo
  "engagement.why.alreadyAnswered": "Already answered", // nuevo
  "engagement.reply.title": "Your reply", // nuevo
  "engagement.reply.generate": "Generate AI reply", // literal FR-140
  "engagement.reply.regenerate": "Regenerate reply", // literal FR-140
  "engagement.reply.generating": "Writing a reply…", // nuevo
  "engagement.reply.failed":
    "Couldn't write a reply. Try again, or check that a text model is set in Settings → Models.", // nuevo
  "engagement.reply.placeholder": "Write a helpful reply, or generate one.", // nuevo
  "engagement.reply.saveDraft": "Save draft", // nuevo
  "engagement.reply.issue.empty": "The reply is empty.", // nuevo
  "engagement.reply.issue.too_long": "The reply is too long for a Reddit comment.", // nuevo
  "engagement.reply.issue.brand_without_disclosure":
    "You mention the brand without saying you're affiliated. Add a line like “full disclosure, I work on it”.", // nuevo
  "engagement.reply.issue.contains_link":
    "The reply has a link. Links are off for this brand — make sure it helps.", // nuevo
  "engagement.send": "Send", // nuevo
  "engagement.send.confirmTitle": "Post this reply on Reddit?", // nuevo
  "engagement.send.confirmBody":
    "It will be posted from u/{username} as a comment on this thread. FastGram never posts without you pressing Send.", // nuevo
  "engagement.send.confirm": "Post comment", // nuevo
  "engagement.send.sent": "Reply posted. Tracking conversation now.", // literal FR-140 (2.ª frase)
  "engagement.send.unknown":
    "Reddit didn't answer in time. The comment may have been posted — check the thread before trying again.", // nuevo
  "engagement.copyOpen": "Copy & open thread", // nuevo
  "engagement.copyOpen.copied":
    "Reply copied. Paste it on Reddit, then mark it as posted.", // nuevo
  "engagement.markSent": "I posted it", // nuevo
  "engagement.markSent.url": "Link to your comment (optional)", // nuevo
  "engagement.markSent.done": "Marked as posted. The ban meter counts it.", // nuevo
  "engagement.blocked.reddit_app_not_configured":
    "Add your Reddit app to send from here. You can still copy the reply.", // nuevo
  "engagement.blocked.reddit_not_connected":
    "Connect a Reddit account to send from here. You can still copy the reply.", // nuevo
  "engagement.blocked.reddit_reconnect_required":
    "Your Reddit connection expired. Reconnect it to send.", // nuevo
  "engagement.blocked.ban_meter_danger":
    "Sending is off: your ban meter is in Danger. Stop replying through FastGram and let the account recover.", // nuevo
  "engagement.blocked.reply_blocked": "Fix the issues above before sending.", // nuevo
  "engagement.error.reddit_rejected": "Reddit didn't accept it.", // nuevo
  "engagement.error.reddit_unavailable":
    "Reddit isn't answering right now. Try again in a minute.", // nuevo
  "engagement.error.reddit_rate_limited":
    "Reddit is rate limiting this account. Wait a few minutes.", // nuevo
  "engagement.error.lead_locked": "This thread no longer accepts comments.", // nuevo
  "engagement.error.oauth_state_wrong_brand":
    "That login was started from another brand. Switch back and try again.", // nuevo
  "engagement.error.oauth_state_invalid":
    "That login link expired or was already used. Try connecting again.", // nuevo
  "engagement.error.oauth_denied": "Reddit didn't grant access.", // nuevo
  "engagement.error.generic": "Something went wrong. Try again.", // nuevo
  "engagement.connected": "Reddit connected as u/{username}", // nuevo
  "engagement.sync": "Sync with Reddit", // literal FR-140
  "engagement.sync.done": "Thread state verified and updated.", // literal FR-140
  "engagement.sync.queued": "Checking the thread on Reddit…", // nuevo
  "engagement.thread.new": "Not replied yet", // nuevo
  "engagement.thread.tracking": "Tracking conversation", // nuevo
  "engagement.thread.comment_missing":
    "Your comment isn't visible in the thread — it may have been removed or spam-filtered.", // nuevo
  "engagement.thread.locked": "Thread locked", // nuevo
  "engagement.thread.repliesToUs": "{count} direct replies to you", // nuevo
  "engagement.thread.noDirectReplies":
    "Activity found from you on this post, but none are direct replies to this specific lead. Make sure you're replying to the right comment/post.", // literal FR-140 (adaptado)
  "engagement.sent.title": "Sent replies", // nuevo
  "engagement.sent.tone.value_add": "Value", // nuevo
  "engagement.sent.tone.subtle_mention": "Subtle", // nuevo
  "engagement.sent.tone.direct_promo": "Direct", // nuevo
  "engagement.sent.tone.pending": "Not classified yet", // nuevo
  "engagement.banMeter.title": "Ban risk", // nuevo
  "engagement.banMeter.refresh": "Refresh ban meter", // literal FR-140
  "engagement.banMeter.level.safe": "Safe - Healthy engagement pattern", // literal FR-140
  "engagement.banMeter.level.caution": "Caution - Monitor engagement", // literal FR-140
  "engagement.banMeter.level.warning": "Warning - High risk, reduce promotional content", // literal FR-140
  "engagement.banMeter.level.danger":
    "Danger - Very high risk, stop promotional engagement", // literal FR-140
  "engagement.banMeter.recommendation.safe":
    "Keep up the good work. Continue providing value-first content.", // literal FR-140
  "engagement.banMeter.recommendation.caution":
    "Your engagement shows some concerning patterns. Minor adjustments recommended.", // literal FR-140
  "engagement.banMeter.recommendation.warning":
    "Balance promotional content with more value-add contributions. Monitor your visibility.", // literal FR-140
  "engagement.banMeter.recommendation.danger":
    "High risk detected. You're likely being spam-filtered on some subreddits. Stop replying through FastGram. Focus only on normal Reddit activity — browse, upvote, and scroll to let your account reputation recover.", // literal FR-140 (con nuestra marca en lugar de «Fastlane»)
  "engagement.banMeter.ratio": "Aim for 60-70% value, 20-30% subtle, 10-20% direct.", // literal FR-140 / F-200
  "engagement.banMeter.perPromo":
    "We recommend at least 3-4 value-add replies for every promotional one.", // literal FR-140 (recortado)
  "engagement.banMeter.counts":
    "Last {days} days: {value} value · {subtle} subtle · {direct} direct", // nuevo
  "engagement.banMeter.unlabeled":
    "{count} replies not classified yet — they don't count until they are.", // nuevo
  "engagement.banMeter.smallSample":
    "Few replies so far: the meter uses the 3-to-1 rule until there are more.", // nuevo
  "engagement.banMeter.promoRatio": "{percent}% promotional", // nuevo
  "engagement.insights.title": "How your replies read", // nuevo
  "engagement.insights.body":
    "The model only labels each sent reply as value, subtle or direct. The percentages and the level are counted by FastGram, never guessed by a model.", // nuevo

  // Automations · FR-150, MOD-015 (F-210…F-220), P3-AUTO-001…013. `literal` =
  // copy de la UI de Fastlane citado en FR-150 (UI del wizard y detalle);
  // `nuevo` = nuestro.
  "automations.title": "Automations", // literal (sidebar)
  "automations.subtitle":
    "Plan weeks of content at once, review every post, then launch.", // nuevo
  "automations.new": "New automation", // literal FR-150
  "automations.list.label": "Your campaigns", // nuevo
  "automations.list.error": "We couldn't load your automations.", // nuevo
  "automations.empty.title": "No automations yet", // nuevo
  "automations.empty.description":
    "Set up a campaign once and FastGram drafts every post for the weeks you choose. Nothing goes out until you launch it.", // nuevo
  "automations.row.meta": "Starts {start} · {weeks} wk · {perDay} per account per day", // nuevo
  "automations.status.draft": "Draft", // nuevo
  "automations.status.generating": "Generating", // nuevo
  "automations.status.review": "In review", // nuevo
  "automations.status.building": "Building", // literal FR-150 (estado `building`)
  "automations.status.active": "Active", // nuevo
  "automations.status.completed": "Completed", // nuevo
  "automations.status.cancelled": "Cancelled", // nuevo
  "automations.status.failed": "Failed", // nuevo
  "automations.progress.generated": "{done} of {total} generated", // nuevo
  "automations.progress.ready": "{done} of {total} ready", // nuevo
  "automations.progress.scheduled": "{done} of {total} scheduled", // nuevo
  "automations.progress.slots": "{done} of {total}", // nuevo
  "automations.slot.pending": "Waiting", // nuevo
  "automations.slot.generating": "Generating", // nuevo
  "automations.slot.ready": "Ready", // nuevo
  "automations.slot.rerolling": "Re-rolling", // nuevo
  "automations.slot.failedGen": "Couldn't generate", // nuevo
  "automations.slot.queuedBuild": "Queued", // nuevo
  "automations.slot.building": "Building", // nuevo
  "automations.slot.scheduled": "Scheduled", // nuevo
  "automations.slot.failed": "Failed", // nuevo
  "automations.slot.wontPost": "Won't post", // literal FR-150
  "automations.failure.noUniqueContent":
    "Every draft repeated something you already posted.", // nuevo (no_unique_content)
  "automations.failure.noDemoVideo":
    "Hook demo videos need a demo video in your Media Bank.", // nuevo (no_demo_video)
  "automations.failure.noMedia": "Your Media Bank has no media for this format.", // nuevo
  "automations.failure.noLlm":
    "No text model is set up. Add one in Settings → Models and create the campaign again.", // nuevo
  "automations.failure.copy":
    "The model didn't return usable copy. Re-roll to try again.", // nuevo
  "automations.failure.quota": "This campaign used all its generations.", // nuevo
  "automations.failure.mediaGone": "Some media of this post was deleted. Re-roll it.", // nuevo
  "automations.failure.build": "This post couldn't be built.", // nuevo
  "automations.failure.allBuilds": "None of the posts could be built.", // nuevo
  "automations.failure.generic": "Something went wrong with this post.", // nuevo
  "automations.blocked.noContentType":
    "Select at least one content type in the content mix.", // nuevo (AUTOMATION_NO_CONTENT_TYPE_SELECTED)
  "automations.blocked.demoVideo":
    "Hook demo videos need a demo video in your Media Bank (category hook-video).", // nuevo (AUTOMATION_VIDEO_HOOK_NEEDS_DEMO_VIDEO)
  "automations.blocked.youtube":
    "YouTube can't publish slideshows as Shorts. Set Slideshow to 0% or remove YouTube.", // nuevo
  "automations.blocked.noDestinations": "Add at least one account.", // nuevo
  "automations.blocked.noMedia":
    "A format in your mix has no media in your Media Bank. Add some or set it to 0%.", // nuevo
  "automations.blocked.past":
    "Every posting time of this campaign is already in the past. Move the start date.", // nuevo
  "automations.blocked.locked": "The configuration is locked once generation starts.", // nuevo
  "automations.blocked.excludedType": "That format isn't part of this campaign's mix.", // nuevo
  "automations.blocked.editInEditor":
    "This post is already open in the editor: edit its text there.", // nuevo
  "automations.wizard.subtitle":
    "Choose where and how often to post, and what kind of content. You'll review every post before anything goes out.", // nuevo
  "automations.wizard.progress": "Automation setup progress", // literal FR-150
  "automations.wizard.step.basics": "Schedule", // nuevo
  "automations.wizard.step.accounts": "Accounts", // nuevo
  "automations.wizard.step.content": "Content", // nuevo
  "automations.wizard.step.review": "Review", // nuevo
  "automations.wizard.name": "Campaign name", // literal FR-150
  "automations.wizard.namePlaceholder": "October on socials", // nuevo
  "automations.wizard.start": "Start date", // nuevo
  "automations.wizard.timezone": "Time zone", // nuevo
  "automations.wizard.weeks": "Campaign length in weeks", // literal FR-150
  "automations.wizard.perDay": "posts per account per day", // literal FR-150
  "automations.wizard.strategyTimes": "Use this brand's posting times", // nuevo
  "automations.wizard.time": "Posting time {n}", // nuevo
  "automations.wizard.accountsHint":
    "Pick an account per network. Without an account yet, plan it: the posts are reserved on the calendar and go out once you connect that network.", // nuevo
  "automations.wizard.connectionsError": "We couldn't load your connected accounts.", // nuevo
  "automations.wizard.destinationFor": "Where to post on {network}", // nuevo
  "automations.wizard.dontPost": "Don't post here", // nuevo
  "automations.wizard.planned": "Plan without an account", // nuevo
  "automations.wizard.mix": "Content mix", // literal FR-055
  "automations.wizard.zeroExcluded":
    "A format at 0% is never used, not even as a fallback: if its media runs out, the campaign posts less.", // nuevo (AI-012)
  "automations.wizard.youtubeSlideshow":
    "YouTube destinations need Slideshow at 0%: slideshows can't be published as Shorts.", // nuevo
  "automations.wizard.removeSlideshow": "Set Slideshow to 0%", // nuevo
  "automations.wizard.videoHookHint": "Needs a demo video in your Media Bank.", // nuevo
  "automations.wizard.remix": "Remix ratio", // literal FR-150
  "automations.wizard.ownMedia": "Own media percentage", // literal FR-150
  "automations.wizard.influencer": "Influencer frequency", // literal FR-150
  "automations.wizard.topics": "Topics", // nuevo
  "automations.wizard.topicsPlaceholder":
    "One per line — e.g. Brewing guides, Behind the roast", // nuevo
  "automations.wizard.summary.schedule": "Schedule", // nuevo
  "automations.wizard.summary.scheduleValue":
    "{weeks} wk from {start}, {perDay} per account per day", // nuevo
  "automations.wizard.summary.accounts": "Accounts", // nuevo
  "automations.wizard.summary.posts": "Posts", // nuevo
  "automations.wizard.summary.postsValue": "{pieces} pieces · {posts} posts", // nuevo
  "automations.wizard.tiktokMode": "TikTok posting mode", // literal FR-150
  "automations.wizard.tiktokInbox": "Send to Inbox", // literal FR-060
  "automations.wizard.tiktokDirect": "Post Directly", // literal FR-060
  "automations.wizard.youtubePrivacy": "YouTube privacy", // literal FR-150
  "automations.wizard.ytPublic": "Public", // nuevo
  "automations.wizard.ytUnlisted": "Unlisted", // nuevo
  "automations.wizard.ytPrivate": "Private", // nuevo
  "automations.wizard.aiLabel": "Add the AI-generated content label", // nuevo
  "automations.wizard.aiLabelHint":
    "Adds the AI-generated content label to eligible Instagram and TikTok posts. This cannot be changed after launch.", // literal FR-150
  "automations.wizard.problem.name": "Give the campaign a name.", // nuevo
  "automations.wizard.problem.start": "Pick a start date.", // nuevo
  "automations.wizard.problem.accounts": "Choose at least one account.", // nuevo
  "automations.wizard.problem.mix": "Select at least one content type.", // nuevo
  "automations.wizard.problem.youtube": "YouTube destinations need Slideshow at 0%.", // nuevo
  "automations.wizard.back": "Back", // nuevo
  "automations.wizard.next": "Continue", // nuevo
  "automations.wizard.saveDraft": "Save draft", // nuevo
  "automations.wizard.generate": "Generate", // literal FLOW-004
  "automations.toast.saved": "Draft saved", // nuevo
  "automations.toast.generating": "Generating your posts…", // nuevo
  "automations.toast.slotSaved": "Post updated", // nuevo
  "automations.toast.rerolling": "Re-rolling this post…", // nuevo
  "automations.toast.cancelled": "Automation cancelled", // nuevo
  "automations.edit.title": "Edit {name}", // nuevo
  "automations.edit.back": "Back to the campaign", // nuevo
  "automations.detail.error": "We couldn't load this automation.", // nuevo
  "automations.detail.notFound": "Automation not found", // nuevo
  "automations.detail.notFound.body":
    "It may have been deleted, or it belongs to another brand.", // nuevo
  "automations.detail.slotsError": "We couldn't load the posts of this campaign.", // nuevo
  "automations.detail.editSetup": "Edit setup", // nuevo
  "automations.detail.continue": "Continue to launch", // literal FR-150
  "automations.detail.cancel": "Cancel automation", // literal FR-150
  "automations.detail.delete": "Delete automation", // nuevo
  "automations.detail.rename": "Rename automation", // literal FR-150
  "automations.detail.saveName": "Save name", // literal FR-150
  "automations.detail.cancelRename": "Cancel rename", // literal FR-150
  "automations.detail.nameLabel": "Campaign name", // literal FR-150
  "automations.detail.plannedTag": "planned", // nuevo
  "automations.detail.generating":
    "Drafting your posts. You can leave this page: they keep generating.", // nuevo
  "automations.detail.postLaunch":
    "Your posts are building and publishing in the background, no further action needed. You can follow progress and analytics on the campaign page, and cancel at any time.", // literal FR-150 (post-lanzamiento, completado)
  "automations.detail.draftHint":
    "This campaign is a draft. Generate it to draft every post, then review them here.", // nuevo
  "automations.detail.noSlots": "This campaign has no posts.", // nuevo
  "automations.stats.published": "Published", // nuevo
  "automations.stats.pending": "Pending", // nuevo
  "automations.stats.failed": "Failed", // nuevo
  "automations.stats.views": "Views", // nuevo
  "automations.stats.likes": "Likes", // nuevo
  "automations.stats.comments": "Comments", // nuevo
  "automations.view.label": "Campaign views", // nuevo
  "automations.view.calendar": "Calendar view", // literal FR-150
  "automations.view.grid": "Grid view", // literal FR-150
  "automations.view.week": "Week {n}", // nuevo
  "automations.view.noPosts": "No posts", // nuevo
  "automations.view.openSlot": "{time} · {type} · {status}", // nuevo
  "automations.slotDialog.title": "Post details", // literal FR-150
  "automations.slotDialog.editPost": "Edit post", // literal FR-150
  "automations.slotDialog.inEditor":
    "This post is open in the editor: change its text there.", // nuevo
  "automations.slotDialog.text": "Text {n}", // nuevo
  "automations.slotDialog.captions": "Captions", // nuevo
  "automations.slotDialog.caption": "{network} caption", // nuevo
  "automations.slotDialog.description": "{network} description", // nuevo
  "automations.slotDialog.adjustSchedule": "Adjust schedule", // literal FR-150
  "automations.slotDialog.timezone": "Times are in {tz}.", // nuevo
  "automations.slotDialog.posts": "Posts", // nuevo
  "automations.slotDialog.openPost": "Open post", // nuevo
  "automations.slotDialog.metrics": "{views} views · {likes} likes · {comments} comments", // nuevo
  "automations.slotDialog.rerollType": "Format for the re-roll", // nuevo
  "automations.slotDialog.sameType": "Same format", // nuevo
  "automations.slotDialog.reroll": "Re-roll this suggestion", // literal FR-150
  "automations.slotDialog.rerollHint":
    "Re-rolling discards this suggestion for good and uses one of the campaign's generations.", // nuevo
  "automations.slotDialog.remove": "Remove suggestion", // literal FR-150
  "automations.slotDialog.confirmRemove": "Confirm remove", // literal FR-150
  "automations.slotDialog.openEditor": "Open in editor", // nuevo
  "automations.slotDialog.save": "Save changes", // nuevo
  "automations.launch.title": "Continue to launch", // literal FR-150
  "automations.launch.validating":
    "Validating your campaign against your plan and accounts.", // literal FR-150
  "automations.launch.ready": "Ready to launch", // literal FR-150
  "automations.launch.allGood":
    "Everything checks out. Your posts will be reserved on launch.", // literal FR-150
  "automations.launch.summary": "{pieces} pieces, {posts} posts across your accounts.", // nuevo
  "automations.launch.blockers": "What's blocking the launch", // nuevo
  "automations.launch.checkFailed": "Couldn't finish checking this campaign", // literal FR-150
  "automations.launch.checkFailed.body":
    "Try again. If this keeps happening, reduce the campaign size.", // literal FR-150
  "automations.launch.launch": "Launch campaign", // literal FR-150
  "automations.launch.done": "Campaign launched", // nuevo
  "automations.gate.notInReview": "Not ready for launch", // nuevo
  "automations.gate.notInReview.body": "Only a campaign in review can be launched.", // nuevo
  "automations.gate.generating": "Content is still generating", // literal FR-150
  "automations.gate.generating.body":
    "Wait for generation or re-rolls to finish, then try again.", // literal FR-150
  "automations.gate.noReady": "No posts to launch", // nuevo
  "automations.gate.noReady.body":
    "Re-roll the posts that failed, or create the campaign again.", // nuevo
  "automations.gate.noDestinations": "No accounts", // nuevo
  "automations.gate.noDestinations.body": "Add at least one account to this campaign.", // nuevo
  "automations.gate.destination": "An account isn't available", // nuevo
  "automations.gate.destination.body":
    "Reconnect it in Settings → Connections, or cancel and set the campaign up again.", // nuevo
  "automations.gate.past": "Some posts are in the past", // nuevo
  "automations.gate.past.body": "Adjust schedule on those posts, or remove them.", // nuevo
  "automations.gate.limits": "Posting limit conflicts", // literal FR-150
  "automations.gate.limits.body":
    "Reduce the length, posts per day, or accounts to continue.", // literal FR-150
  "automations.gate.youtube": "Slideshows can't go to YouTube", // nuevo
  "automations.gate.youtube.body": "Re-roll or remove the slideshow posts.", // nuevo
  "automations.gate.budget": "More content saves needed", // literal FR-150
  "automations.gate.budget.body":
    "Reduce the length, posts per day, or accounts to continue.", // literal FR-150
  "automations.gate.aiLabel": "No destination supports the AI label", // nuevo
  "automations.gate.aiLabel.body":
    "No current campaign destination supports this label. Turn it off before launching.", // literal FR-150
  "automations.confirm.cancel.title": "Cancel this automation?", // nuevo
  "automations.confirm.cancel.body":
    "Scheduled posts are revoked and nothing else goes out. Posts already published stay live. This can't be undone.", // nuevo (F-219)
  "automations.confirm.delete.title": "Delete this automation?", // nuevo
  "automations.confirm.delete.body":
    "The campaign and its drafts are deleted. Pieces already created stay in your Library.", // nuevo
  "automations.confirm.keep": "Keep it", // nuevo
  "error.automationNoContentType.title": "Select at least one content type", // nuevo (AUTOMATION_NO_CONTENT_TYPE_SELECTED)
  "error.automationDemoVideo.title": "Add a demo video first", // nuevo (AUTOMATION_VIDEO_HOOK_NEEDS_DEMO_VIDEO)
} as const;

export type MessageKey = keyof typeof en;
export type Messages = Record<MessageKey, string>;
