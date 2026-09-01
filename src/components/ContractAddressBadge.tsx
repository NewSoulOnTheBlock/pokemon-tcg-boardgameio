import { useEffect, useState } from 'react';
import { POKETCG_TOKEN_ADDRESS, explorerAddressUrl, hasPoketcgToken } from '../chain/config';
import { shortAddr } from '../wallet';

/**
 * Copyable contract address for the game token (`Pokemasters` / `POKE`,
 * ERC-20 on Robinhood Chain). Renders nothing when no token is configured,
 * so a deployment that unsets POKETCG_TOKEN_ADDRESS just loses the badge
 * instead of advertising an empty address.
 *
 * `compact` shortens the address for the top bar; the full string is always
 * what gets copied.
 */
export function ContractAddressBadge({ compact = false }: { compact?: boolean }) {
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 1600);
    return () => clearTimeout(timer);
  }, [copied]);

  if (!hasPoketcgToken()) return null;

  async function copy() {
    try {
      await navigator.clipboard.writeText(POKETCG_TOKEN_ADDRESS);
      setCopied(true);
    } catch {
      // Clipboard access needs a secure context and a user gesture; when the
      // browser refuses, the address is still selectable in the explorer link.
      setCopied(false);
    }
  }

  return (
    <div className={compact ? 'ca-badge ca-badge-compact' : 'ca-badge'}>
      <span className="ca-badge-label">CA</span>
      <button
        className="ca-badge-copy"
        onClick={() => void copy()}
        title={`Copy ${POKETCG_TOKEN_ADDRESS} — Pokemasters ($POKE) on Robinhood Chain`}
      >
        <code>{compact ? shortAddr(POKETCG_TOKEN_ADDRESS) : POKETCG_TOKEN_ADDRESS}</code>
        <span className="ca-badge-copy-state" aria-live="polite">{copied ? 'Copied' : 'Copy'}</span>
      </button>
      <a
        className="ca-badge-explorer"
        href={explorerAddressUrl(POKETCG_TOKEN_ADDRESS)}
        target="_blank"
        rel="noreferrer"
        title="View the token on the Robinhood Chain explorer"
      >
        ↗
      </a>
    </div>
  );
}
