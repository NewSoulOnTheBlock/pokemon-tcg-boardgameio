import { StrictMode, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { API_BASE } from './api/server';
import { initCardLibrary } from './game/cards';
import type { Card } from './game/types';
import './styles.css';

const BOOT_HOST_ID = 'root';
const STATUS_ID = 'boot-status';

function setBootStatus(text: string): void {
  const el = document.getElementById(STATUS_ID);
  if (el) el.textContent = text;
}

function clearBootHost(): HTMLElement {
  const host = document.getElementById(BOOT_HOST_ID);
  if (!host) {
    throw new Error('Missing #root element in index.html');
  }
  host.innerHTML = '';
  return host;
}

function renderFatal(message: string): void {
  const host = clearBootHost();
  host.innerHTML = `
    <div class="boot-fatal">
      <h1>Could not load the card library</h1>
      <p>${message.replace(/[<>&]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c]!))}</p>
      <button onclick="location.reload()">Try again</button>
    </div>
  `;
}

async function fetchCardLibrary(): Promise<Card[]> {
  const response = await fetch(`${API_BASE}/api/cards/library`, { credentials: 'omit' });
  if (!response.ok) {
    const detail = await response.text().catch(() => response.statusText);
    throw new Error(`/api/cards/library responded ${response.status}: ${detail}`);
  }
  const payload = (await response.json()) as Card[];
  if (!Array.isArray(payload)) {
    throw new Error('/api/cards/library returned a non-array payload');
  }
  return payload;
}

async function boot(): Promise<void> {
  setBootStatus('Loading card library…');
  try {
    const cards = await fetchCardLibrary();
    setBootStatus(`Preparing ${cards.length.toLocaleString()} cards…`);
    initCardLibrary(cards);

    // App.tsx has top-level constants (CANONICAL_CARDS, BOOSTERABLE_SETS,
    // STARTER_COLLECTION) that read from CARD_LIBRARY at module evaluation
    // time. We MUST dynamic-import it AFTER initCardLibrary so those
    // derivations see a populated catalogue.
    const { default: App } = await import('./App');

    const host = clearBootHost();
    createRoot(host).render(createElement(StrictMode, null, createElement(App)));
  } catch (err) {
    console.error('[boot] card library fetch failed', err);
    renderFatal(err instanceof Error ? err.message : String(err));
  }
}

boot();
