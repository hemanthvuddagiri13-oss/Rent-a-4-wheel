import { cn } from "@/lib/utils";

function Skeleton({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn(
        "animate-pulse rounded-md bg-gradient-to-r from-card via-card-elevated to-card bg-[length:200%_100%]",
        className
      )}
      {...props}
    />
  );
}

export { Skeleton };
