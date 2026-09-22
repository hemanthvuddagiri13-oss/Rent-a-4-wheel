import * as React from "react";
import { Slot } from "@radix-ui/react-slot";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";

const buttonVariants = cva(
  "inline-flex max-w-full items-center justify-center gap-2 whitespace-normal rounded-md text-center text-sm font-semibold leading-snug transition-colors duration-150 disabled:pointer-events-none disabled:opacity-50 gold-ring-focus [&_svg]:pointer-events-none [&_svg]:shrink-0",
  {
    variants: {
      variant: {
        default:
          "bg-gold text-black shadow-sm hover:bg-gold-bright active:brightness-95",
        outline:
          "border border-silver/40 text-silver bg-transparent hover:bg-white/5 hover:border-silver",
        ghost: "text-silver hover:text-gold hover:bg-white/5",
        secondary: "bg-card-elevated text-white border border-white/10 hover:border-gold/40",
        destructive: "bg-red-600 text-white hover:bg-red-500",
        link: "text-gold underline-offset-4 hover:underline",
      },
      size: {
        default: "min-h-11 px-5 py-2.5",
        sm: "min-h-11 px-4 py-2 text-sm",
        lg: "min-h-14 px-7 py-3 text-base",
        icon: "h-11 w-11 shrink-0",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  }
);

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {
  asChild?: boolean;
}

const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, asChild = false, ...props }, ref) => {
    const Comp = asChild ? Slot : "button";
    return (
      <Comp className={cn(buttonVariants({ variant, size, className }))} ref={ref} {...props} />
    );
  }
);
Button.displayName = "Button";

export { Button, buttonVariants };
