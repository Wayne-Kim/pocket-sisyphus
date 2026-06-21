import { site } from "@/content";

/** 푸터. data-section="footer". */
export default function Footer() {
  const { footer, brand } = site;
  return (
    <footer
      id="footer"
      data-section="footer"
      data-testid="section-footer"
      className="mx-auto w-full max-w-5xl px-6 py-12 text-center text-sm text-muted"
    >
      <p className="font-semibold text-ink">{brand.name}</p>
      <p className="mt-1">{footer.tagline}</p>

      <nav
        data-block="footer-links"
        className="mt-4 flex flex-wrap items-center justify-center gap-4"
      >
        {footer.links.map((link) => (
          <a
            key={link.label}
            href={link.href}
            target="_blank"
            rel="noopener noreferrer"
            className="text-accent-soft underline-offset-4 hover:underline"
          >
            {link.label}
          </a>
        ))}
      </nav>

      <p className="mt-6 text-xs text-muted/70">{footer.note}</p>
    </footer>
  );
}
