// UX audit B0 (docs section 3.5): a sticky pill row of anchor links for long
// pages (Settings, the project page, Usage). Skip it on a page shorter than
// 2 viewports.
export interface SectionNavItem {
  id: string;
  label: string;
}

export interface SectionNavProps {
  items: readonly SectionNavItem[];
  className?: string;
}

export function SectionNav({ items, className = "" }: SectionNavProps) {
  return (
    <nav
      className={`sticky top-0 z-10 -mx-4 flex gap-4 overflow-x-auto border-b border-line bg-canvas px-4 py-2 lg:-mx-6 lg:px-6 ${className}`}
    >
      {items.map((item) => (
        <a
          key={item.id}
          href={`#${item.id}`}
          className="whitespace-nowrap text-body-sm text-muted hover:text-accent"
        >
          {item.label}
        </a>
      ))}
    </nav>
  );
}
