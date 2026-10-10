import * as React from "react"
import { Input as InputPrimitive } from "@base-ui/react/input"
import { cn } from "cn"

function Input({ className, type, ...props }: React.ComponentProps<"input">) {
  return (
    <InputPrimitive
      type={type}
      data-slot="input"
      className={cn(
        "h-11 w-full min-w-0 rounded-xl border border-border bg-surface px-3 py-1 text-base text-foreground outline-none transition-colors placeholder:text-muted focus-visible:border-primary focus-visible:ring-2 focus-visible:ring-[#4DA3FF]/40 disabled:pointer-events-none disabled:cursor-not-allowed disabled:opacity-40 md:text-sm",
        className
      )}
      {...props}
    />
  )
}

export { Input }
