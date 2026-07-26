export function SectionHeader({ title, subtitle }: { title: string; subtitle?: string }) {
  return (
    <div className="mb-4 flex items-center gap-2.5">
      <span
        aria-hidden="true"
        className="h-4 w-1 shrink-0 rounded-full bg-gradient-premium"
      />
      <div>
        <h2 className="text-base font-semibold tracking-tight text-white">{title}</h2>
        {subtitle && <p className="mt-0.5 text-xs text-muted">{subtitle}</p>}
      </div>
    </div>
  );
}
