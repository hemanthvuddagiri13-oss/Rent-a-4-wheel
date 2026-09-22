import Image from "next/image";
import Link from "next/link";
import { cn } from "@/lib/utils";

export function Logo({ className, iconOnly = false }: { className?: string; iconOnly?: boolean }) {
  return (
    <Link href="/" className={cn("flex min-w-0 items-center gap-2", className)} aria-label="Rent A 4Wheel — home">
      <Image
        src={iconOnly ? "/brand/logo-mark.svg" : "/brand/logo.svg"}
        alt="Rent A 4Wheel"
        width={iconOnly ? 36 : 190}
        height={iconOnly ? 36 : 41}
        priority
        className="h-auto max-h-9 w-auto max-w-full"
      />
    </Link>
  );
}
