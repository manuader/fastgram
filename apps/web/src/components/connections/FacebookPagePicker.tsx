"use client";

import {
  Avatar,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Skeleton,
} from "@fastgram/ui";
import { useFacebookPageSelection, useSelectFacebookPage } from "@/lib/connections/api";
import { CONNECTIONS_COPY as C, reasonCopy } from "@/lib/connections/copy";
import { isApiRequestError } from "@/lib/api/errors";

export interface FacebookPagePickerProps {
  readonly selectionId: string;
  readonly onDone: () => void;
}

/**
 * Elegir la Página de Facebook tras el login (`PU-PUB-002`). Los tokens de las
 * Páginas se quedan en la API; acá sólo llegan id, nombre y avatar.
 */
export function FacebookPagePicker({ selectionId, onDone }: FacebookPagePickerProps) {
  const selection = useFacebookPageSelection(selectionId);
  const select = useSelectFacebookPage();

  return (
    <Card data-testid="facebook-page-picker">
      <CardHeader>
        <CardTitle>{C.choosePageTitle}</CardTitle>
        <CardDescription>{C.choosePageBody}</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-2">
        {selection.isPending ? (
          <Skeleton height={48} />
        ) : selection.isError ? (
          <p className="m-0 text-sm text-danger" role="alert">
            {reasonCopy(
              isApiRequestError(selection.error) && selection.error.status === 404
                ? "selection_expired"
                : null,
            )}
          </p>
        ) : (
          <ul className="m-0 flex list-none flex-col gap-2 p-0">
            {selection.data.pages.map((page) => (
              <li key={page.id} className="flex items-center gap-3">
                <Avatar
                  name={page.name}
                  {...(page.avatarUrl === null ? {} : { src: page.avatarUrl })}
                />
                <span className="flex-1 text-text">{page.name}</span>
                <Button
                  size="sm"
                  disabled={select.isPending}
                  onClick={() =>
                    select.mutate({ selectionId, pageId: page.id }, { onSuccess: onDone })
                  }
                >
                  {C.choosePage}
                </Button>
              </li>
            ))}
          </ul>
        )}
        {select.isError && (
          <p className="m-0 text-sm text-danger" role="alert">
            {reasonCopy(
              isApiRequestError(select.error) &&
                typeof select.error.details?.["reason"] === "string"
                ? (select.error.details["reason"] as string)
                : null,
            )}
          </p>
        )}
        <div>
          <Button variant="ghost" size="sm" onClick={onDone}>
            {C.cancel}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
