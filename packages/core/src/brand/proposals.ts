/**
 * Propuestas del re-análisis — `P1-BRANDPG-005`, `FR-011.6`, `ERR-B14`.
 *
 * La fusión (`reconcileBrandProfile`) **no escribe** un campo editado a mano ni
 * uno con valor de procedencia desconocida: decide `keep` y deja la propuesta
 * en el aire. Hasta acá no había cómo verla ni aceptarla. Esto la reconstruye
 * desde el último snapshot de cada fuente, con la misma fusión, así que lo que
 * se ofrece es exactamente lo que la fusión habría escrito.
 *
 * Sin columna nueva: la propuesta se calcula en cada lectura; lo único que se
 * guarda es la **descartada**, en `fieldMeta[campo].dismissedProposal`.
 */
import {
  currentProfileFields,
  excerptRef,
  fromStoredDerivedFields,
  reconcileBrandProfile,
  splitCategories,
  type ProfileFieldMeta,
  type SnapshotCandidate,
} from "./analysis.js";
import { type BrandProfileField, type FieldConfidence } from "./synthesis.js";
import type { CoreBrandSourceType } from "./source-input.js";

/** El último snapshot de una fuente, con lo que la fusión necesita. */
export interface ProposalSnapshot {
  readonly snapshotId: string;
  readonly sourceId: string;
  readonly sourceType: CoreBrandSourceType;
  readonly isPrimary: boolean;
  /** `DATA-032.derivedFields`, tal como está guardado. */
  readonly derivedFields: unknown;
}

export interface ProfileProposal {
  readonly field: BrandProfileField;
  readonly value: string;
  readonly currentValue: string;
  readonly confidence: FieldConfidence;
  readonly sourceId: string;
  readonly sourceType: CoreBrandSourceType;
  readonly excerpt: string | null;
  readonly excerptRef: string;
  readonly reason: "edited_by_user" | "unknown_provenance";
}

type ProfileValues = Readonly<
  Record<BrandProfileField, string | readonly string[] | null>
>;

function asText(v: string | readonly string[] | null): string {
  if (v === null) return "";
  return typeof v === "string" ? v : v.join(", ");
}

/** El `excerptRef` descartado de un campo, leído sin confiar en la forma del jsonb. */
export function dismissedProposalOf(
  fieldMeta: unknown,
  field: BrandProfileField,
): string | null {
  if (typeof fieldMeta !== "object" || fieldMeta === null) return null;
  const entry = (fieldMeta as Record<string, unknown>)[field];
  if (typeof entry !== "object" || entry === null) return null;
  const d = (entry as Record<string, unknown>)["dismissedProposal"];
  return typeof d === "string" ? d : null;
}

/**
 * Qué propone cada fuente para los campos que la fusión conservó. Sólo lo que
 * difiere del valor actual y no fue descartado.
 */
export function computeProfileProposals(input: {
  readonly snapshots: readonly ProposalSnapshot[];
  readonly values: ProfileValues;
  readonly fieldMeta: unknown;
}): readonly ProfileProposal[] {
  const candidates: SnapshotCandidate[] = input.snapshots.flatMap((s) =>
    fromStoredDerivedFields(s.derivedFields, {
      sourceId: s.sourceId,
      sourceType: s.sourceType,
    }).map((derived) => ({ derived, snapshotId: s.snapshotId })),
  );
  if (candidates.length === 0) return [];
  const primary = input.snapshots.find((s) => s.isPrimary)?.sourceId ?? null;
  const current = currentProfileFields(input.values, input.fieldMeta);
  const reconciled = reconcileBrandProfile({
    candidates,
    primarySourceId: primary,
    current,
  });
  const snapshotOf = new Map(input.snapshots.map((s) => [s.sourceId, s]));

  const out: ProfileProposal[] = [];
  for (const d of reconciled.decisions) {
    if (d.action !== "keep" || d.proposal === null) continue;
    if (d.reason !== "edited_by_user" && d.reason !== "unknown_provenance") continue;
    const sourceId = d.proposal.sourceId;
    if (sourceId === undefined) continue;
    const snap = snapshotOf.get(sourceId);
    if (snap === undefined) continue;
    const currentValue = asText(input.values[d.field]);
    if (d.proposal.value.trim() === currentValue.trim()) continue;
    const ref = excerptRef(snap.snapshotId, d.field);
    if (dismissedProposalOf(input.fieldMeta, d.field) === ref) continue;
    out.push({
      field: d.field,
      value: d.proposal.value,
      currentValue,
      confidence: d.proposal.confidence,
      sourceId,
      sourceType: snap.sourceType,
      excerpt: d.proposal.excerpt ?? null,
      excerptRef: ref,
      reason: d.reason,
    });
  }
  return out;
}

/** Lo que se escribe al aceptar: el valor y su procedencia. Deja de ser `editedByUser`. */
export function acceptedProposalWrite(proposal: ProfileProposal): {
  readonly value: string | readonly string[];
  readonly meta: ProfileFieldMeta;
} {
  return {
    value:
      proposal.field === "businessCategories"
        ? splitCategories(proposal.value)
        : proposal.value,
    meta: {
      confidence: proposal.confidence,
      sourceId: proposal.sourceId,
      excerptRef: proposal.excerptRef,
      editedByUser: false,
    },
  };
}

/** `fieldMeta` con la propuesta marcada como descartada; el resto del campo intacto. */
export function withDismissedProposal(
  fieldMeta: unknown,
  field: BrandProfileField,
  ref: string,
): Record<string, unknown> {
  const meta: Record<string, unknown> =
    typeof fieldMeta === "object" && fieldMeta !== null
      ? { ...(fieldMeta as Record<string, unknown>) }
      : {};
  const entry = meta[field];
  const base =
    typeof entry === "object" && entry !== null
      ? (entry as Record<string, unknown>)
      : { confidence: "high", sourceId: null, excerptRef: null, editedByUser: true };
  meta[field] = { ...base, dismissedProposal: ref };
  return meta;
}

/** Guarda de concurrencia de `F-022`: ¿el perfil sigue en la revisión que vio el cliente? */
export function brandRevisionMatches(
  current: number,
  expected: number | undefined,
): boolean {
  return expected === undefined || expected === current;
}
