// Standalone Docs page. Reachable from the home page as 'Docs' and
// renders a sticky-sidebar table of contents on the left with the
// section content scrolling on the right. All content is hand-written
// here so it stays in sync with the actual game without requiring an
// external CMS or markdown loader.

import { useState } from 'react';

interface DocsSection {
  id: string;
  title: string;
  icon: string;
  content: React.ReactNode;
}

const SECTIONS: DocsSection[] = [
  {
    id: 'welcome',
    title: 'Welcome',
    icon: '👋',
    content: (
      <>
        <p>
          PokemastersTCG is a Pokemon Trading Card Game playable in your browser, multiplayer
          over the network, with Solana-backed economy primitives. You can play casual or
          ranked matches against other players, fight through a Gym campaign of 8 Gym Leaders
          + Elite Four + Champion, or wager $POKETCG / SOL / USDC on a match.
        </p>
        <p>
          Cards come from three sources:
        </p>
        <ul>
          <li><strong>Starter decks</strong> — one per energy type (Grass / Fire / Water / etc.), always playable, never NFT-backed.</li>
          <li><strong>Booster packs</strong> — buy them on the Booster Shop tab with $POKETCG (burned permanently), or claim a free pack every 22 hours.</li>
          <li><strong>NFT pulls</strong> — buy gacha packs (via Collector Crypt) that drop real graded Pokemon card NFTs into your wallet.</li>
        </ul>
      </>
    ),
  },
  {
    id: 'quick-start',
    title: 'Quick start',
    icon: '🚀',
    content: (
      <>
        <ol>
          <li><strong>Sign in</strong> with a trainer name (optional) or connect a Solana wallet (required for $POKETCG burns + wagers + NFT pulls).</li>
          <li>From the Home page, click <strong>Profile + Deckbuilder</strong> and either pick a starter deck or build a custom 60-card deck.</li>
          <li>Click <strong>Matchmaking</strong>, then <em>Create match</em>. Share the match link with a friend or wait for someone to accept.</li>
          <li>During setup, drag a Basic Pokemon onto your Active spot and up to 5 more onto your Bench. Click <em>Ready</em>.</li>
          <li>On your turn: draw, play cards, attach Energy, evolve, attack. End your turn by clicking <em>Pass</em> or by attacking.</li>
          <li>Win by taking all 6 of your Prize cards, or by knocking out all your opponent's Pokemon.</li>
        </ol>
      </>
    ),
  },
  {
    id: 'match-types',
    title: 'Match types',
    icon: '⚔',
    content: (
      <>
        <p>Five match types — each tracked separately in match history and the leaderboard:</p>
        <table className="docs-table">
          <thead><tr><th>Type</th><th>Stake</th><th>What it's for</th></tr></thead>
          <tbody>
            <tr><td><strong>Casual</strong></td><td>None</td><td>Practice. Doesn't affect win/loss record.</td></tr>
            <tr><td><strong>Ranked</strong></td><td>None</td><td>Counted toward the leaderboard W/L record.</td></tr>
            <tr><td><strong>Wager</strong></td><td>$POKETCG / SOL / USDC</td><td>Winner takes the pot. Funds escrowed at match start, released on conclusion.</td></tr>
            <tr><td><strong>Gym</strong></td><td>None</td><td>Solo campaign vs CPU. 8 Gyms → Elite Four → Champion. Earns XP and badges.</td></tr>
            <tr><td><strong>Bot</strong></td><td>None</td><td>Random-AI sparring partner for warm-up.</td></tr>
          </tbody>
        </table>
      </>
    ),
  },
  {
    id: 'game-rules',
    title: 'Game rules essentials',
    icon: '📖',
    content: (
      <>
        <h3>How to win</h3>
        <ol>
          <li>Take all 6 of your Prize cards (one per Pokemon you knock out).</li>
          <li>Your opponent has no Pokemon left in play.</li>
          <li>Your opponent can't draw a card at turn start (deck empty).</li>
        </ol>
        <h3>Turn structure</h3>
        <ol>
          <li>Draw a card. (If you can't, you lose.)</li>
          <li>Bench Basics, attach 1 Energy, evolve, play Trainers, retreat, use Abilities — in any order.</li>
          <li>Attack. Attacking ends your turn.</li>
          <li>Pokemon Checkup runs (Poisoned, Burned, Asleep, Paralyzed resolve in that order).</li>
        </ol>
        <h3>Key restrictions</h3>
        <ul>
          <li>The starting player can't attack on turn 1.</li>
          <li>Only 1 Supporter per turn. None on turn 1 for the starting player.</li>
          <li>Only 1 Stadium in play at a time; a new Stadium replaces the old. Can't replace with a Stadium of the same name.</li>
          <li>Up to 4 copies of any non-Energy card in your deck (Basic Energy is unlimited).</li>
          <li>A Pokemon can't evolve on the turn it was played, and can only evolve once per turn.</li>
        </ul>
        <h3>Damage + special conditions</h3>
        <p>
          Damage is tracked in 10-point counters. Weakness doubles damage; Resistance subtracts 30.
          Special Conditions only affect the Active Pokemon and clear when it moves to the Bench or evolves.
        </p>
      </>
    ),
  },
  {
    id: 'deckbuilding',
    title: 'Deck building',
    icon: '🎴',
    content: (
      <>
        <p>Decks are exactly 60 cards. Open <strong>Profile → Decks</strong> to manage them.</p>
        <h3>Starter decks</h3>
        <p>
          11 pre-built energy-themed decks: Grass, Fire, Water, Lightning, Psychic, Fighting,
          Darkness, Metal, Dragon, Fairy, Colorless. Each comes with ~20 Pokemon, ~20 Trainers
          (Professor's Research, Poké Ball, Great Ball, Switch, Potion, Energy Retrieval,
          Rare Candy or Boss's Orders), and ~20 Energy. Always playable, never run out of stock.
        </p>
        <h3>Custom decks</h3>
        <ul>
          <li>Exactly 60 cards.</li>
          <li>Max 4 copies of any non-Energy card.</li>
          <li>Basic Energy is unlimited.</li>
          <li>You can only use cards you actually <em>own</em> — open booster packs to expand your collection.</li>
        </ul>
        <p>
          Save multiple deck variants to your library. Switch between them from the
          deckbuilder or pick one when creating a match.
        </p>
      </>
    ),
  },
  {
    id: 'trainer-cards',
    title: 'Trainer cards reference',
    icon: '🧰',
    content: (
      <>
        <p>Trainer cards we currently implement explicit effects for:</p>
        <table className="docs-table">
          <thead><tr><th>Card</th><th>Type</th><th>What it does</th></tr></thead>
          <tbody>
            <tr><td>Potion</td><td>Item</td><td>Heal 30 damage from one of your Pokemon.</td></tr>
            <tr><td>Switch</td><td>Item</td><td>Switch your Active with a Benched Pokemon.</td></tr>
            <tr><td>Poké Ball</td><td>Item</td><td>Flip a coin. Heads: search your deck for any Pokemon, put it in your hand.</td></tr>
            <tr><td>Great Ball</td><td>Item</td><td>Look at the top 7 cards of your deck. Put a Pokemon you find into your hand, shuffle the rest back.</td></tr>
            <tr><td>Nest Ball</td><td>Item</td><td>Search your deck for a Basic Pokemon and put it onto your Bench.</td></tr>
            <tr><td>Energy Retrieval</td><td>Item</td><td>Discard one other card, then retrieve up to 2 Basic Energy from your discard pile.</td></tr>
            <tr><td>Rare Candy</td><td>Item</td><td>Evolve a Basic directly into Stage 2 (Basic must have been in play since last turn).</td></tr>
            <tr><td>Professor's Research</td><td>Supporter</td><td>Discard your hand, draw 7 cards.</td></tr>
            <tr><td>Youngster</td><td>Supporter</td><td>Shuffle your hand into your deck, draw 5 cards.</td></tr>
            <tr><td>Boss's Orders</td><td>Supporter</td><td>Switch in 1 of your opponent's Benched Pokemon to their Active spot.</td></tr>
            <tr><td>Training Court</td><td>Stadium</td><td>Active Pokemon attacks do +10 damage.</td></tr>
            <tr><td>Bravery Charm / Sturdy Charm</td><td>Tool</td><td>Attacks on the equipped Pokemon do -10 damage.</td></tr>
          </tbody>
        </table>
        <p className="docs-note">
          Cards outside this list are still playable in matches but their effect resolves as printed damage only —
          we&apos;re adding more every release.
        </p>
      </>
    ),
  },
  {
    id: 'economy',
    title: 'The economy',
    icon: '💰',
    content: (
      <>
        <h3>$POKETCG burn</h3>
        <p>
          Buy playable booster packs on the <strong>Profile → 🔥 Booster Shop</strong> tab by burning $POKETCG tokens.
          Tokens are permanently destroyed — no treasury, no buyback. Tiered pricing:
        </p>
        <table className="docs-table">
          <thead><tr><th>Bundle</th><th>Cost</th><th>Per pack</th><th>Save</th></tr></thead>
          <tbody>
            <tr><td>1 pack</td><td>100,000 $POKETCG</td><td>100K</td><td>—</td></tr>
            <tr><td>3 packs</td><td>250,000 $POKETCG</td><td>~83K</td><td>17%</td></tr>
            <tr><td>7 packs</td><td>500,000 $POKETCG</td><td>~71K</td><td>29%</td></tr>
          </tbody>
        </table>
        <p>
          Each pack contains 5 commons + 3 uncommons + 1 rare-or-better. Rare slot is weighted
          (most pulls are plain Rare / Rare Holo; flashier rarities are progressively scarcer).
          Cards land directly in your collection ready for deckbuilding.
        </p>
        <h3>Daily free pack</h3>
        <p>
          The home page has a <strong>Daily Free Pack</strong> widget. Click it every 22 hours
          to claim a free pack with the same composition as a burned pack. No wallet needed.
        </p>
      </>
    ),
  },
  {
    id: 'quests',
    title: 'Quests + XP',
    icon: '🎯',
    content: (
      <>
        <p>
          Three daily quests reset at local midnight. Mix of easy / medium / hard rolled
          deterministically per (wallet, date), so reloading doesn't change your quests.
          Quests award XP toward your trainer level (level cap 100).
        </p>
        <p>
          Examples: <em>Play 1 Match · Win 3 Matches · Climb the Ladder (1 ranked win) ·
          Open 3 Booster Packs · Earn a Gym Badge · Defeat an Elite Four member · Honourable
          Victory (win without an opponent forfeit)</em>.
        </p>
        <p>
          Clear all 3 daily quests to unlock the Daily Completion Chest (+200 XP bonus).
        </p>
        <p>
          XP also drips in passively from gameplay: 25 per match played, +50 for a win,
          +75 for a Ranked or Wager win, 150 for a Gym win, 250 for an Elite Four win,
          500 for defeating the Champion, 10 per pack opened.
        </p>
      </>
    ),
  },
  {
    id: 'wallet-setup',
    title: 'Wallet setup',
    icon: '🔑',
    content: (
      <>
        <p>
          Most of the game works without a wallet. Connect a Solana wallet (Phantom,
          Solflare, Backpack) to unlock:
        </p>
        <ul>
          <li>$POKETCG burn → playable booster packs</li>
          <li>$POKETCG / SOL / USDC wager matches</li>
          <li>Collector Crypt gacha pack purchases (real NFT pulls)</li>
          <li>NFT-backed card imports into your in-game collection</li>
          <li>Persistent profile across devices (login key keyed on your wallet)</li>
        </ul>
        <h3>Getting $POKETCG</h3>
        <p>
          $POKETCG is the project token on pump.fun.
          Mint address: <code>N9Curnf2ZQWBZWrjBkzP6xBe6n5WRhBhouRfiSqpump</code>.
          Swap SOL for $POKETCG on pump.fun or any Solana DEX (Jupiter routes through it).
        </p>
        <h3>Fees</h3>
        <p>
          Every Solana transaction needs a small SOL balance for gas. ~0.001 SOL per tx
          is plenty. Burning $POKETCG only sends a single SPL token instruction so fees are
          negligible (typically &lt; $0.001).
        </p>
      </>
    ),
  },
  {
    id: 'faq',
    title: 'FAQ + Troubleshooting',
    icon: '❓',
    content: (
      <>
        <h3>I clicked Poké Ball but nothing happened</h3>
        <p>
          The card moves to your discard pile and a result line appears as a gold toast at
          the top of the screen — check there. Poké Ball flips a coin: on tails (50%) it
          discards with no Pokemon pulled. On heads, a Pokemon is added to your hand from
          your deck if any are left.
        </p>
        <h3>Big Eggsplosion only does 20 damage</h3>
        <p>
          It flips one coin per Energy attached. Attach more Energy to scale the damage:
          4 attached Energy = 4 coins, up to 80 damage. Confirm in the gold toast that pops up.
        </p>
        <h3>Why was my $POKETCG burn rejected?</h3>
        <p>
          Most likely insufficient balance. Check your wallet has at least the tier amount
          (100K / 250K / 500K) AND a tiny bit of SOL for gas (~0.001 SOL).
        </p>
        <h3>My opponent left mid-match</h3>
        <p>
          Closing the tab or clicking Exit triggers an automatic forfeit. You win and the
          match record updates accordingly. If wagering, the pot is released to you.
        </p>
        <h3>How do I import existing Pokemon NFTs?</h3>
        <p>
          Home page → <em>Import NFTs</em>. We scan your wallet for Pokemon NFTs and let you
          pull matching cards into your in-game collection.
        </p>
      </>
    ),
  },
];

export function DocsPage() {
  const [activeSection, setActiveSection] = useState<string>(SECTIONS[0]!.id);

  const handleSectionClick = (id: string) => {
    setActiveSection(id);
    const el = document.getElementById(`docs-section-${id}`);
    el?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };

  return (
    <main className="docs-page">
      <aside className="docs-sidebar" aria-label="Documentation table of contents">
        <p className="eyebrow">Docs</p>
        <h1>PokemastersTCG</h1>
        <nav className="docs-toc">
          {SECTIONS.map((section) => (
            <button
              key={section.id}
              type="button"
              className={`docs-toc-item${activeSection === section.id ? ' docs-toc-item-active' : ''}`}
              onClick={() => handleSectionClick(section.id)}
            >
              <span className="docs-toc-icon" aria-hidden="true">{section.icon}</span>
              <span>{section.title}</span>
            </button>
          ))}
        </nav>
        <p className="docs-sidebar-footer">
          Found an issue? File it on <a href="https://github.com/NewSoulOnTheBlock/pokemon-tcg-boardgameio/issues" target="_blank" rel="noreferrer">GitHub</a>.
        </p>
      </aside>
      <article className="docs-content">
        {SECTIONS.map((section) => (
          <section
            key={section.id}
            id={`docs-section-${section.id}`}
            className="docs-section"
          >
            <h2 className="docs-section-heading">
              <span className="docs-section-heading-icon" aria-hidden="true">{section.icon}</span>
              {section.title}
            </h2>
            <div className="docs-section-body">{section.content}</div>
          </section>
        ))}
      </article>
    </main>
  );
}
