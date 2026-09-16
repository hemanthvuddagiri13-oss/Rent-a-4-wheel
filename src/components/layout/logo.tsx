import Image from "next/image";
import Link from "next/link";
import { cn } from "@/lib/utils";

export function Logo({ className, iconOnly = false }: { className?: string; iconOnly?: boolean }) {
  return (
    <Link href="/" className={cn("flex items-center gap-2 shrink-0", className)} aria-label="Rent A 4Wheel — home">
      <Image
        src={iconOnly ? "/brand/logo-mark.svg" : "/brand/logo.svg"}
        alt="Rent A 4Wheel"
        width={iconOnly ? 36 : 190}
        height={iconOnly ? 36 : 41}
        priority
        className="h-9 w-auto"
      />
    </Link>
  );
}
