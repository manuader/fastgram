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
} as const;

export type MessageKey = keyof typeof en;
export type Messages = Record<MessageKey, string>;
