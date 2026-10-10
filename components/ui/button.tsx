import { Button as ButtonPrimitive } from "@base-ui/react/button"
import { cva, type VariantProps } from "class-variance-authority"
import { cn } from "cn"

const buttonVariants = cva(
  "inline-flex shrink-0 items-center justify-center gap-2 rounded-xl border text-sm font-semibold whitespace-nowrap transition-all outline-none select-none focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#4DA3FF]/40 disabled:pointer-events-none disabled:opacity-40 [&_svg]:pointer-events-none [&_svg]:shrink-0",
  {
    variants: {
      variant: {
        default:
          "border-[#8CC7FF]/40 bg-gradient-premium text-primary-foreground shadow-[inset_0_1px_0_rgba(255,255,255,0.28),inset_0_-1px_0_rgba(9,32,74,0.4),0_3px_0_#1e63db,0_8px_16px_rgba(30,99,219,0.22)] hover:brightness-110 active:translate-y-0.5 active:scale-[0.98]",
        outline:
          "border-border bg-surface text-foreground hover:bg-surface-2",
        secondary:
          "border-border bg-surface-2 text-foreground hover:bg-accent",
        ghost:
          "border-transparent bg-transparent text-muted hover:bg-accent hover:text-foreground",
        destructive:
          "border-[#FF6B6B]/45 bg-[#FF6B6B]/10 text-bad hover:bg-[#FF6B6B]/20",
        link: "border-transparent text-primary underline-offset-4 hover:underline",
      },
      size: {
        default: "h-11 px-4",
        xs: "h-7 rounded-lg px-2.5 text-xs",
        sm: "h-9 px-3",
        lg: "h-14 px-6 text-base",
        icon: "size-11",
        "icon-xs": "size-7 rounded-lg",
        "icon-sm": "size-9",
        "icon-lg": "size-14",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  }
)

function Button({
  className,
  variant = "default",
  size = "default",
  ...props
}: ButtonPrimitive.Props & VariantProps<typeof buttonVariants>) {
  return (
    <ButtonPrimitive
      data-slot="button"
      className={cn(buttonVariants({ variant, size, className }))}
      {...props}
    />
  )
}

export { Button, buttonVariants }
