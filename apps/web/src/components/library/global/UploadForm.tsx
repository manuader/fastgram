"use client";

import {
  LIBRARY_ASSET_KINDS,
  LIBRARY_EXCLUDED_LICENSES,
  LIBRARY_LICENSE_TYPES,
  LIBRARY_UPLOAD_MAX_MB,
  type LibraryAssetKind,
  type LibraryLicenseType,
} from "@fastgram/contracts";
import { Button, Input, Select } from "@fastgram/ui";
import { useId, useRef, useState } from "react";
import { presentError } from "@/lib/api/error-presentation";
import { isApiRequestError } from "@/lib/api/errors";
import { tw } from "@/lib/i18n/t";
import { isSignedUploadError } from "@/lib/media/upload/transport";
import {
  EMPTY_LICENSE_FORM,
  LIBRARY_UPLOAD_ACCEPT,
  checkLibraryFile,
  libraryUploadRequest,
  licenseDeclarationFrom,
  requiredLicenseFields,
  useLibraryUpload,
  type LibraryUploadStep,
  type LicenseField,
  type LicenseFieldError,
  type LicenseForm,
} from "./api";
import { FILE_REJECTION_COPY, KIND_COPY, LICENSE_COPY, LICENSE_FIELD_COPY } from "./copy";

/**
 * Nombre legible de cada licencia excluida. La razón viene del contrato
 * (`LIBRARY_EXCLUDED_LICENSES`, ya escrita para el usuario); el nombre no.
 */
const EXCLUDED_NAMES: Readonly<Record<string, string>> = {
  "cc-by-sa": "CC BY-SA",
  "cc-by-nc": "CC BY-NC",
  "cc-by-nd": "CC BY-ND",
  "public-domain-mark": "Public Domain Mark",
  unknown: "Unknown",
};

const TEXT_FIELDS: readonly Exclude<LicenseField, "type">[] = [
  "attribution",
  "author",
  "sourceUrl",
  "licenseUrl",
  "version",
];

function fieldError(field: LicenseField, error: LicenseFieldError): string {
  return tw(
    error === "required"
      ? "globalLibrary.upload.error.required"
      : "globalLibrary.upload.error.invalid",
    { field: tw(LICENSE_FIELD_COPY[field]) },
  );
}

/**
 * Subir un archivo propio a la biblioteca global, **con la licencia
 * declarada**. No hay `unknown` (D-19): sin tipo de licencia no se reserva
 * nada, y cada tipo exige lo suyo — CC BY la atribución, las de un tercero la
 * página del archivo y la de la licencia. La validación del cliente es la
 * misma regla que la del servidor; el servidor igual vuelve a validar.
 */
export function UploadForm({ onUploaded }: { readonly onUploaded?: () => void }) {
  const ids = {
    file: useId(),
    title: useId(),
    kind: useId(),
    license: useId(),
    excluded: useId(),
  };
  const fieldIds = {
    attribution: useId(),
    author: useId(),
    sourceUrl: useId(),
    licenseUrl: useId(),
    version: useId(),
  };
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [file, setFile] = useState<File | null>(null);
  const [title, setTitle] = useState("");
  const [kind, setKind] = useState<LibraryAssetKind | "">("");
  const [license, setLicense] = useState<LicenseForm>(EMPTY_LICENSE_FORM);
  const [errors, setErrors] = useState<Partial<Record<LicenseField, LicenseFieldError>>>(
    {},
  );
  const [fileError, setFileError] = useState<string | null>(null);
  const [step, setStep] = useState<LibraryUploadStep | null>(null);
  const [progress, setProgress] = useState<number | null>(null);
  const [done, setDone] = useState(false);
  const upload = useLibraryUpload();
  const required = requiredLicenseFields(license.type);

  const reset = () => {
    setFile(null);
    setTitle("");
    setKind("");
    setLicense(EMPTY_LICENSE_FORM);
    setErrors({});
    setFileError(null);
    setStep(null);
    setProgress(null);
    if (inputRef.current !== null) inputRef.current.value = "";
  };

  const submit = () => {
    setDone(false);
    let ok = true;
    if (file === null) {
      setFileError(tw("globalLibrary.upload.file.missing"));
      ok = false;
    } else {
      const rejection = checkLibraryFile(file);
      if (rejection !== null) {
        setFileError(tw(FILE_REJECTION_COPY[rejection], { max: LIBRARY_UPLOAD_MAX_MB }));
        ok = false;
      }
    }
    const check = licenseDeclarationFrom(license);
    setErrors(check.ok ? {} : check.errors);
    if (!check.ok) ok = false;
    if (!ok || file === null || !check.ok) return;

    const body = libraryUploadRequest(file, { title, kind, license: check.value });
    if (body === null) {
      setFileError(
        tw("globalLibrary.upload.file.unsupported", { max: LIBRARY_UPLOAD_MAX_MB }),
      );
      return;
    }
    upload.mutate(
      { file, body, onStep: setStep, onProgress: setProgress },
      {
        onSuccess: () => {
          reset();
          setDone(true);
          onUploaded?.();
        },
      },
    );
  };

  const uploadError = upload.error;
  const uploadErrorText =
    uploadError === null
      ? null
      : isApiRequestError(uploadError)
        ? tw(presentError(uploadError).titleKey, presentError(uploadError).titleVars)
        : isSignedUploadError(uploadError)
          ? tw("globalLibrary.upload.error.transfer")
          : tw("globalLibrary.upload.error.generic");

  return (
    <form
      className="flex flex-col gap-4"
      aria-label={tw("globalLibrary.import.tab.upload")}
      noValidate
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
    >
      <div className="flex flex-col gap-1.5">
        <label htmlFor={ids.file} className="text-sm font-medium text-text">
          {tw("globalLibrary.upload.file.label")}
        </label>
        <input
          ref={inputRef}
          id={ids.file}
          type="file"
          accept={LIBRARY_UPLOAD_ACCEPT}
          className="text-sm text-text"
          aria-invalid={fileError !== null}
          onChange={(e) => {
            const next = e.target.files?.[0] ?? null;
            setFile(next);
            setFileError(null);
            setDone(false);
            if (next !== null) {
              const rejection = checkLibraryFile(next);
              if (rejection !== null) {
                setFileError(
                  tw(FILE_REJECTION_COPY[rejection], { max: LIBRARY_UPLOAD_MAX_MB }),
                );
              }
            }
          }}
        />
        <span className="text-xs text-text-subtle">
          {tw("globalLibrary.upload.file.hint", { max: LIBRARY_UPLOAD_MAX_MB })}
        </span>
        {fileError !== null && (
          <span role="alert" className="text-xs text-danger">
            {fileError}
          </span>
        )}
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <div className="flex flex-col gap-1.5">
          <label htmlFor={ids.title} className="text-sm font-medium text-text">
            {tw("globalLibrary.upload.title")}
          </label>
          <Input
            id={ids.title}
            value={title}
            maxLength={200}
            onChange={(e) => {
              setTitle(e.target.value);
            }}
          />
        </div>
        <div className="flex flex-col gap-1.5">
          <label htmlFor={ids.kind} className="text-sm font-medium text-text">
            {tw("globalLibrary.upload.kind")}
          </label>
          <Select
            id={ids.kind}
            value={kind}
            onChange={(e) => {
              setKind(LIBRARY_ASSET_KINDS.find((k) => k === e.target.value) ?? "");
            }}
            options={[
              { value: "", label: tw("globalLibrary.upload.kindAuto") },
              ...LIBRARY_ASSET_KINDS.map((k) => ({ value: k, label: tw(KIND_COPY[k]) })),
            ]}
          />
        </div>
      </div>

      <fieldset className="m-0 flex flex-col gap-3 rounded-xl border border-border p-4">
        <legend className="px-1 text-sm font-semibold text-text">
          {tw("globalLibrary.upload.license.legend")}
        </legend>
        <div className="flex flex-col gap-1.5">
          <label htmlFor={ids.license} className="text-sm font-medium text-text">
            {tw("globalLibrary.upload.license.type")} *
          </label>
          <Select
            id={ids.license}
            value={license.type}
            placeholder={tw("globalLibrary.upload.license.placeholder")}
            invalid={errors.type !== undefined}
            aria-describedby={ids.excluded}
            onChange={(e) => {
              const next: LibraryLicenseType | "" =
                LIBRARY_LICENSE_TYPES.find((t) => t === e.target.value) ?? "";
              setLicense((l) => ({ ...l, type: next }));
              setErrors({});
            }}
            options={LIBRARY_LICENSE_TYPES.map((t) => ({
              value: t,
              label: tw(LICENSE_COPY[t]),
            }))}
          />
          {errors.type !== undefined && (
            <span role="alert" className="text-xs text-danger">
              {fieldError("type", errors.type)}
            </span>
          )}
        </div>

        {license.type !== "" &&
          TEXT_FIELDS.map((field) => {
            const isRequired = required.includes(field);
            const error = errors[field];
            return (
              <div key={field} className="flex flex-col gap-1.5">
                <label
                  htmlFor={fieldIds[field]}
                  className="text-sm font-medium text-text"
                >
                  {tw(LICENSE_FIELD_COPY[field])}
                  {isRequired ? " *" : ` ${tw("globalLibrary.upload.optional")}`}
                </label>
                <Input
                  id={fieldIds[field]}
                  value={license[field]}
                  invalid={error !== undefined}
                  type={field === "sourceUrl" || field === "licenseUrl" ? "url" : "text"}
                  onChange={(e) => {
                    const value = e.target.value;
                    setLicense((l) => ({ ...l, [field]: value }));
                  }}
                />
                {error !== undefined && (
                  <span role="alert" className="text-xs text-danger">
                    {fieldError(field, error)}
                  </span>
                )}
              </div>
            );
          })}

        <div id={ids.excluded} className="text-xs text-text-muted">
          <p className="m-0 mb-1 font-medium">
            {tw("globalLibrary.upload.excluded.title")}
          </p>
          <ul className="m-0 flex list-disc flex-col gap-0.5 pl-4">
            {Object.entries(LIBRARY_EXCLUDED_LICENSES).map(([key, reason]) => (
              <li key={key}>
                <span className="font-medium">{EXCLUDED_NAMES[key] ?? key}</span>
                {`: ${reason}`}
              </li>
            ))}
          </ul>
        </div>
      </fieldset>

      {upload.isPending && step !== null && (
        <p role="status" className="m-0 text-sm text-text-muted">
          {step === "transfer"
            ? tw("globalLibrary.upload.step.transfer", {
                percent: progress === null ? "…" : `${String(progress)}%`,
              })
            : tw(
                step === "reserve"
                  ? "globalLibrary.upload.step.reserve"
                  : "globalLibrary.upload.step.finalize",
              )}
        </p>
      )}
      {uploadErrorText !== null && !upload.isPending && (
        <p role="alert" className="m-0 text-sm text-danger">
          {uploadErrorText}
        </p>
      )}
      {done && (
        <p role="status" className="m-0 text-sm text-success">
          {tw("globalLibrary.upload.done")}
        </p>
      )}
      <div className="flex justify-end">
        <Button type="submit" loading={upload.isPending}>
          {tw("globalLibrary.upload.submit")}
        </Button>
      </div>
    </form>
  );
}
