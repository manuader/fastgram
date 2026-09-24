import { Avatar } from "@fastgram/ui";
import { brandTone } from "@/lib/brands/tone";

/** Avatar de iniciales de una marca, con su tono estable (`lib/brands/tone.ts`). */
export function BrandAvatar({
  id,
  name,
  size = "sm",
  logoUrl,
}: {
  id: string;
  name: string;
  size?: "xs" | "sm" | "md";
  /** `P1-ONB-003`: el logo subido en Brand. Sin él, iniciales con su tono. */
  logoUrl?: string | null | undefined;
}) {
  return (
    <Avatar
      name={name}
      {...(logoUrl === null || logoUrl === undefined ? {} : { src: logoUrl })}
      size={size}
      shape="square"
      className="fgw-brand-avatar"
      data-tone={brandTone(id)}
    />
  );
}
