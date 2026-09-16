import * as React from "react";
import { Slot } from "@radix-ui/react-slot";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";

const buttonVariants = cva(
  "inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-md text-sm font-semibold tracking-wide transition-all duration-200 disabled:pointer-events-none disabled:opacity-50 gold-ring-focus [&_svg]:pointer-events-none [&_svg]:shrink-0",
  {
    variants: {
      variant: {
        default:
          "bg-gradient-to-r from-gold to-gold-bright text-black shadow-[0_0_0_1px_rgba(212,175,55,0.4)] hover:shadow-[0_0_24px_rgba(212,175,55,0.35)] hover:brightness-105 active:brightness-95",
        outline:
          "border border-gold/50 text-gold bg-transparent hover:bg-gold/10 hover:border-gold",
        ghost: "text-silver hover:text-gold hover:bg-white/5",
        secondary: "bg-card-elevated text-white border border-white/10 hover:border-gold/40",
        destructive: "bg-red-600 text-white hover:bg-red-500",
        link: "text-gold underline-offset-4 hover:underline",
      },
      size: {
        default: "h-11 px-6 py-2",
        sm: "h-9 px-4 text-xs",
        lg: "h-14 px-8 text-base",
        icon: "h-10 w-10",
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
