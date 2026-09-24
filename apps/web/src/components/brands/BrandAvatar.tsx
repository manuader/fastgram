import { Avatar } from "@fastgram/ui";
import { brandTone } from "@/lib/brands/tone";

/** Avatar de iniciales de una marca, con su tono estable (`lib/brands/tone.ts`). */
export function BrandAvatar({
  id,
  name,
  size = "sm",
}: {
  id: string;
  name: string;
  size?: "xs" | "sm" | "md";
}) {
  return (
    <Avatar
      name={name}
      size={size}
      shape="square"
      className="fgw-brand-avatar"
      data-tone={brandTone(id)}
    />
  );
}
