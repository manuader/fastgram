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
  "error.brand.alreadyConnected.title":
    "This profile is already connected to another workspace.", // ERR-B06
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
} as const;

export type MessageKey = keyof typeof en;
export type Messages = Record<MessageKey, string>;
