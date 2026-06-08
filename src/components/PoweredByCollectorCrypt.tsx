// "Powered by Collector Crypt" branding badge — two variants:
//   <PoweredByCollectorCrypt /> (default, variant="floating")
//     Fixed-position bottom-right corner badge, shown on every
//     page via the global mount in App.tsx.
//   <PoweredByCollectorCrypt variant="hero" />
//     Big, centered badge used inside the Gacha storefront hero,
//     with a stronger glow and prominent "POWERED BY" eyebrow.
//
// The logo asset lives at /collector-crypt-logo.png (copied into
// public/ from the user-supplied download-removebg-preview.png).

interface Props {
  /**
   * - `hero`: Big, centered badge with a strong glow. For storefront eyebrows.
   * - `floating`: Fixed bottom-right corner badge for non-match pages.
   * - `match`: Smaller fixed bottom-right badge sized to coexist with the
   *            battle UI without covering hands or status panels.
   */
  variant?: 'hero' | 'floating' | 'match';
}

export function PoweredByCollectorCrypt({ variant = 'floating' }: Props) {
  if (variant === 'hero') {
    return (
      <a
        className="powered-by-cc powered-by-cc-hero"
        href="https://collectorcrypt.com"
        target="_blank"
        rel="noreferrer"
        aria-label="Powered by Collector Crypt"
      >
        <span className="powered-by-cc-eyebrow">POWERED BY</span>
        <span className="powered-by-cc-glow" aria-hidden="true" />
        <img
          className="powered-by-cc-logo"
          src="/collector-crypt-logo.png"
          alt="Collector Crypt"
          loading="lazy"
        />
      </a>
    );
  }
  const variantClass = variant === 'match' ? 'powered-by-cc-floating powered-by-cc-match' : 'powered-by-cc-floating';
  return (
    <a
      className={`powered-by-cc ${variantClass}`}
      href="https://collectorcrypt.com"
      target="_blank"
      rel="noreferrer"
      aria-label="Powered by Collector Crypt"
      title="Powered by Collector Crypt"
    >
      <span className="powered-by-cc-eyebrow">POWERED BY</span>
      <span className="powered-by-cc-glow" aria-hidden="true" />
      <img
        className="powered-by-cc-logo"
        src="/collector-crypt-logo.png"
        alt="Collector Crypt"
        loading="lazy"
      />
    </a>
  );
}
