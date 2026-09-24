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
} as const;

export type MessageKey = keyof typeof en;
export type Messages = Record<MessageKey, string>;
