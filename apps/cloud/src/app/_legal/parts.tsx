// Shared building blocks for the privacy and terms pages, so their link style and layout cannot drift.
const focusRing =
  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus focus-visible:ring-offset-2 focus-visible:ring-offset-canvas";
export const textLink = `text-accent underline underline-offset-2 hover:decoration-2 rounded-xs ${focusRing}`;
export const code = "font-mono font-normal text-body-sm [overflow-wrap:anywhere]";

export function Section({ id, title, children }: { id: string; title: string; children: React.ReactNode }) {
  return (
    <section id={id} aria-labelledby={`${id}-h`} className="mt-10 pt-8 border-t border-line-soft scroll-mt-6">
      <h2 id={`${id}-h`} className="text-h2 text-ink">
        {title}
      </h2>
      <div className="mt-4 space-y-3 text-body text-ink-2">{children}</div>
    </section>
  );
}

export function H3({ children }: { children: React.ReactNode }) {
  return <h3 className="mt-6 text-h3 text-ink">{children}</h3>;
}
