/** Sprint 8 (K): la tarjeta marca «From library» a los influencers que vienen de un modelo. */
import { influencerSchema } from "@fastgram/contracts";
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { InfluencerView } from "@/lib/influencers/form";
import { InfluencerCard } from "./InfluencerCard";

/** Pasa por el schema del contrato: el `_id` es un tipo marcado. */
const view = (raw: Record<string, unknown>): InfluencerView =>
  influencerSchema.partial({ baseImageUrl: true }).parse(raw);

const base = {
  _id: "0b7f3c1a-2c4e-4f5a-8b6d-9e0f1a2b3c4d",
  name: "Mia",
  status: "ready",
  progress: 100,
  isActive: true,
  createdAt: 1_790_000_000_000,
  updatedAt: 1_790_000_000_000,
} as const;

describe("InfluencerCard", () => {
  it("con modelId: badge «From library»", () => {
    render(
      <InfluencerCard
        influencer={view({ ...base, modelId: "11111111-1111-4111-8111-111111111111" })}
      />,
    );
    expect(screen.getByText("From library")).toBeTruthy();
  });

  it("sin modelId: sin badge", () => {
    render(<InfluencerCard influencer={view(base)} />);
    expect(screen.queryByText("From library")).toBeNull();
  });
});
