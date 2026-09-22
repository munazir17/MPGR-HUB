// Section header: a short gradient hairline kicker above a tight,
// quietly confident title. No colored bars or icon chips — hierarchy
// comes from type and space alone.
//
// `size="section"` (default) labels a block inside a page; `size="page"`
// is the page's own heading (larger, with an optional eyebrow kicker).

interface SectionHeaderProps {
  title: string;
  subtitle?: string;
  size?: "section" | "page";
  as?: "h1" | "h2";
}

export function SectionHeader({
  title,
  subtitle,
  size = "section",
  as = "h2",
}: SectionHeaderProps) {
  const Tag = as;

  if (size === "page") {
    return (
      <div className="mb-8 md:mb-10">
        <span
          aria-hidden="true"
          className="mb-3 block h-px w-10 bg-gradient-to-r from-primary/80 to-transparent"
        />
        <Tag className="text-2xl font-semibold tracking-[-0.02em] text-white md:text-4xl md:leading-[44px]">
          {title}
        </Tag>
        {subtitle && (
          <p className="mt-2 max-w-2xl text-sm leading-relaxed text-muted md:text-[15px]">
            {subtitle}
          </p>
        )}
      </div>
    );
  }

  return (
    <div className="mb-5">
      <span
        aria-hidden="true"
        className="mb-2.5 block h-px w-8 bg-gradient-to-r from-primary/80 to-transparent"
      />
      <Tag className="text-base font-semibold tracking-[-0.01em] text-white md:text-lg">
        {title}
      </Tag>
      {subtitle && <p className="mt-1 text-[13px] leading-relaxed text-muted">{subtitle}</p>}
    </div>
  );
}
