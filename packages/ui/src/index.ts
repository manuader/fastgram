/**
 * `@fastgram/ui` es **el único paquete que exporta `.ts` crudo**, y es a propósito.
 *
 * `P0-REPO-013` hizo que todos los demás emitan `dist`, porque Node no puede
 * importar `.ts` desde `node_modules` y sin eso el binario compilado no arranca.
 * Acá no aplica: el único consumidor es `apps/web`, que es Next.js y **empaqueta**
 * — nunca hay un `import` de este paquete resolviéndose en Node en runtime.
 *
 * Emitirlo igual costaría un paso de build por cambio de componente y no compraría
 * nada: con `jsx: "preserve"` la salida son `.jsx` que igual necesitan un bundler,
 * y cambiar a `react-jsx` sólo para el `dist` haría que lo que se testea y lo que
 * se sirve pasen por transformaciones distintas.
 *
 * Si algún día un proceso de Node importa esto, deja de ser la excepción.
 */

export { cn } from "./cn.js";

/* ------------------------------------------------------------------ copy */
export {
  createTranslator,
  emptyStatePresets,
  en,
  errorStatePresets,
  interpolate,
  resolveStatePreset,
  t,
} from "./i18n/index.js";
export type {
  EmptyStatePresetId,
  ErrorStatePresetId,
  MessageKey,
  Messages,
  MessageVars,
  ResolvedState,
  StatePreset,
} from "./i18n/index.js";

/* --------------------------------------------------------------- helpers */
export {
  FOCUSABLE_SELECTOR,
  getFocusableElements,
  resolveTrapTarget,
} from "./lib/focus.js";
export { getInitials } from "./lib/initials.js";
export { getPaginationRange, PAGINATION_ELLIPSIS } from "./lib/pagination.js";
export type { PaginationItem, PaginationRangeOptions } from "./lib/pagination.js";
export { nextRovingIndex } from "./lib/roving.js";
export type { Orientation } from "./lib/roving.js";

/* ----------------------------------------------------------- componentes */
export { Avatar } from "./components/avatar/Avatar.js";
export type { AvatarProps } from "./components/avatar/Avatar.js";
export { avatarVariants } from "./components/avatar/avatar.variants.js";

export { Badge } from "./components/badge/Badge.js";
export type { BadgeProps } from "./components/badge/Badge.js";
export { badgeVariants, PLATFORM_TONES } from "./components/badge/badge.variants.js";
export type { PlatformTone } from "./components/badge/badge.variants.js";

export { Button } from "./components/button/Button.js";
export type { ButtonProps } from "./components/button/Button.js";
export { buttonVariants } from "./components/button/button.variants.js";

export {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "./components/card/Card.js";
export type { CardProps, CardTitleProps } from "./components/card/Card.js";
export { cardVariants } from "./components/card/card.variants.js";

export { Checkbox } from "./components/checkbox/Checkbox.js";
export type { CheckboxProps } from "./components/checkbox/Checkbox.js";

export {
  Dialog,
  DialogBody,
  DialogClose,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "./components/dialog/Dialog.js";
export type { DialogCloseProps, DialogProps } from "./components/dialog/Dialog.js";
export { dialogVariants } from "./components/dialog/dialog.variants.js";
export { useModal } from "./components/dialog/use-modal.js";
export type { UseModalOptions, UseModalResult } from "./components/dialog/use-modal.js";

export {
  Drawer,
  DrawerBody,
  DrawerClose,
  DrawerDescription,
  DrawerFooter,
  DrawerHeader,
  DrawerTitle,
} from "./components/drawer/Drawer.js";
export type { DrawerCloseProps, DrawerProps } from "./components/drawer/Drawer.js";
export { drawerVariants } from "./components/drawer/drawer.variants.js";

export { EmptyState } from "./components/empty-state/EmptyState.js";
export type { EmptyStateProps } from "./components/empty-state/EmptyState.js";
export { emptyStateVariants } from "./components/empty-state/empty-state.variants.js";

export { ErrorState } from "./components/error-state/ErrorState.js";
export type { ErrorStateProps } from "./components/error-state/ErrorState.js";
export { errorStateVariants } from "./components/error-state/error-state.variants.js";

export { Input } from "./components/input/Input.js";
export type { InputProps } from "./components/input/Input.js";
export { inputVariants } from "./components/input/input.variants.js";

export { Pagination } from "./components/pagination/Pagination.js";
export type { PaginationProps } from "./components/pagination/Pagination.js";
export { paginationVariants } from "./components/pagination/pagination.variants.js";

export { Select } from "./components/select/Select.js";
export type { SelectOption, SelectProps } from "./components/select/Select.js";
export { selectVariants } from "./components/select/select.variants.js";

export { Skeleton, SkeletonText } from "./components/skeleton/Skeleton.js";
export type { SkeletonProps, SkeletonTextProps } from "./components/skeleton/Skeleton.js";
export { skeletonVariants } from "./components/skeleton/skeleton.variants.js";

export { Spinner } from "./components/spinner/Spinner.js";
export type { SpinnerProps } from "./components/spinner/Spinner.js";
export { spinnerVariants } from "./components/spinner/spinner.variants.js";

export { Switch } from "./components/switch/Switch.js";
export type { SwitchProps } from "./components/switch/Switch.js";
export { switchVariants } from "./components/switch/switch.variants.js";

export { Tabs, TabsContent, TabsList, TabsTrigger } from "./components/tabs/Tabs.js";
export type {
  TabsContentProps,
  TabsProps,
  TabsTriggerProps,
} from "./components/tabs/Tabs.js";

export { Textarea } from "./components/textarea/Textarea.js";
export type { TextareaProps } from "./components/textarea/Textarea.js";
export { textareaVariants } from "./components/textarea/textarea.variants.js";

export { Toaster, ToastProvider, useToast } from "./components/toast/Toast.js";
export type {
  ToastContextValue,
  ToasterProps,
  ToastProviderProps,
} from "./components/toast/Toast.js";
export { createToastStore } from "./components/toast/toast-store.js";
export type {
  Toast,
  ToastAction,
  ToastOptions,
  ToastStore,
  ToastStoreConfig,
  ToastTone,
} from "./components/toast/toast-store.js";
export { toastVariants } from "./components/toast/toast.variants.js";

export { Tooltip } from "./components/tooltip/Tooltip.js";
export type { TooltipProps } from "./components/tooltip/Tooltip.js";
export { tooltipVariants } from "./components/tooltip/tooltip.variants.js";
