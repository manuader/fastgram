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

export { cn } from "./cn";

/* ------------------------------------------------------------------ copy */
export {
  createTranslator,
  emptyStatePresets,
  en,
  errorStatePresets,
  interpolate,
  resolveStatePreset,
  t,
} from "./i18n/index";
export type {
  EmptyStatePresetId,
  ErrorStatePresetId,
  MessageKey,
  Messages,
  MessageVars,
  ResolvedState,
  StatePreset,
} from "./i18n/index";

/* --------------------------------------------------------------- helpers */
export { FOCUSABLE_SELECTOR, getFocusableElements, resolveTrapTarget } from "./lib/focus";
export { getInitials } from "./lib/initials";
export { getPaginationRange, PAGINATION_ELLIPSIS } from "./lib/pagination";
export type { PaginationItem, PaginationRangeOptions } from "./lib/pagination";
export { nextRovingIndex } from "./lib/roving";
export type { Orientation } from "./lib/roving";

/* ----------------------------------------------------------- componentes */
export { Avatar } from "./components/avatar/Avatar";
export type { AvatarProps } from "./components/avatar/Avatar";
export { avatarVariants } from "./components/avatar/avatar.variants";

export { Badge } from "./components/badge/Badge";
export type { BadgeProps } from "./components/badge/Badge";
export { badgeVariants, PLATFORM_TONES } from "./components/badge/badge.variants";
export type { PlatformTone } from "./components/badge/badge.variants";

export { Button } from "./components/button/Button";
export type { ButtonProps } from "./components/button/Button";
export { buttonVariants } from "./components/button/button.variants";

export {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "./components/card/Card";
export type { CardProps, CardTitleProps } from "./components/card/Card";
export { cardVariants } from "./components/card/card.variants";

export { Checkbox } from "./components/checkbox/Checkbox";
export type { CheckboxProps } from "./components/checkbox/Checkbox";

export {
  Dialog,
  DialogBody,
  DialogClose,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "./components/dialog/Dialog";
export type { DialogCloseProps, DialogProps } from "./components/dialog/Dialog";
export { dialogVariants } from "./components/dialog/dialog.variants";
export { useModal } from "./components/dialog/use-modal";
export type { UseModalOptions, UseModalResult } from "./components/dialog/use-modal";

export {
  Drawer,
  DrawerBody,
  DrawerClose,
  DrawerDescription,
  DrawerFooter,
  DrawerHeader,
  DrawerTitle,
} from "./components/drawer/Drawer";
export type { DrawerCloseProps, DrawerProps } from "./components/drawer/Drawer";
export { drawerVariants } from "./components/drawer/drawer.variants";

export { EmptyState } from "./components/empty-state/EmptyState";
export type { EmptyStateProps } from "./components/empty-state/EmptyState";
export { emptyStateVariants } from "./components/empty-state/empty-state.variants";

export { ErrorState } from "./components/error-state/ErrorState";
export type { ErrorStateProps } from "./components/error-state/ErrorState";
export { errorStateVariants } from "./components/error-state/error-state.variants";

export { Input } from "./components/input/Input";
export type { InputProps } from "./components/input/Input";
export { inputVariants } from "./components/input/input.variants";

export { Pagination } from "./components/pagination/Pagination";
export type { PaginationProps } from "./components/pagination/Pagination";
export { paginationVariants } from "./components/pagination/pagination.variants";

export { Select } from "./components/select/Select";
export type { SelectOption, SelectProps } from "./components/select/Select";
export { selectVariants } from "./components/select/select.variants";

export { Skeleton, SkeletonText } from "./components/skeleton/Skeleton";
export type { SkeletonProps, SkeletonTextProps } from "./components/skeleton/Skeleton";
export { skeletonVariants } from "./components/skeleton/skeleton.variants";

export { Spinner } from "./components/spinner/Spinner";
export type { SpinnerProps } from "./components/spinner/Spinner";
export { spinnerVariants } from "./components/spinner/spinner.variants";

export { Switch } from "./components/switch/Switch";
export type { SwitchProps } from "./components/switch/Switch";
export { switchVariants } from "./components/switch/switch.variants";

export { Tabs, TabsContent, TabsList, TabsTrigger } from "./components/tabs/Tabs";
export type {
  TabsContentProps,
  TabsProps,
  TabsTriggerProps,
} from "./components/tabs/Tabs";

export { Textarea } from "./components/textarea/Textarea";
export type { TextareaProps } from "./components/textarea/Textarea";
export { textareaVariants } from "./components/textarea/textarea.variants";

export { Toaster, ToastProvider, useToast } from "./components/toast/Toast";
export type {
  ToastContextValue,
  ToasterProps,
  ToastProviderProps,
} from "./components/toast/Toast";
export { createToastStore } from "./components/toast/toast-store";
export type {
  Toast,
  ToastAction,
  ToastOptions,
  ToastStore,
  ToastStoreConfig,
  ToastTone,
} from "./components/toast/toast-store";
export { toastVariants } from "./components/toast/toast.variants";

export { Tooltip } from "./components/tooltip/Tooltip";
export type { TooltipProps } from "./components/tooltip/Tooltip";
export { tooltipVariants } from "./components/tooltip/tooltip.variants";
