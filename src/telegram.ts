// Telegram Mini App integration. When the app is opened inside the
// Telegram client this module surfaces the signed-in user (so we can
// skip the wallet-connect step), applies Telegram's theme colors as CSS
// variables so the UI feels native, and wires Telegram's BackButton to
// browser history. Outside Telegram every helper here is a no-op so the
// existing wallet flow stays the source of truth.

export interface TelegramUser {
  id: number;
  username?: string;
  first_name?: string;
  last_name?: string;
  language_code?: string;
  photo_url?: string;
}

interface TelegramWebApp {
  initData: string;
  initDataUnsafe: {
    user?: TelegramUser;
    auth_date?: number;
    hash?: string;
    start_param?: string;
  };
  themeParams?: Record<string, string>;
  colorScheme?: 'light' | 'dark';
  viewportHeight?: number;
  isExpanded: boolean;
  expand(): void;
  ready(): void;
  close(): void;
  setHeaderColor(color: string): void;
  setBackgroundColor(color: string): void;
  BackButton: {
    show(): void;
    hide(): void;
    onClick(cb: () => void): void;
    offClick(cb: () => void): void;
  };
  HapticFeedback?: {
    impactOccurred(style: 'light' | 'medium' | 'heavy' | 'rigid' | 'soft'): void;
    notificationOccurred(type: 'error' | 'success' | 'warning'): void;
    selectionChanged(): void;
  };
}

declare global {
  interface Window {
    Telegram?: { WebApp?: TelegramWebApp };
  }
}

export function getTelegramWebApp(): TelegramWebApp | undefined {
  if (typeof window === 'undefined') return undefined;
  return window.Telegram?.WebApp;
}

export function isTelegramMiniApp(): boolean {
  const tg = getTelegramWebApp();
  return Boolean(tg && tg.initData && tg.initData.length > 0);
}

export function getTelegramUser(): TelegramUser | undefined {
  return getTelegramWebApp()?.initDataUnsafe?.user;
}

/** Stable per-Telegram-user pseudo address used as the profile's wallet
 *  field. Lets us reuse the existing wallet-keyed profile lookup without
 *  inventing a parallel identity column. Format: `tg:${id}`. */
export function telegramPseudoAddress(user: TelegramUser): string {
  return `tg:${user.id}`;
}

export function telegramDisplayName(user: TelegramUser): string {
  const handle = user.username?.trim();
  if (handle) return `@${handle}`;
  const parts = [user.first_name, user.last_name].filter(Boolean) as string[];
  if (parts.length > 0) return parts.join(' ');
  return `Trainer ${user.id}`;
}

/** Initialize the Telegram Web App: tell Telegram we're ready, expand to
 *  fullscreen, apply the user's theme colors as CSS variables. Safe to
 *  call repeatedly and outside Telegram (no-op). */
export function initTelegramWebApp(): void {
  const tg = getTelegramWebApp();
  if (!tg) return;
  try {
    tg.ready();
    tg.expand();
    // Match the app's dark theme so the Telegram header doesn't clash.
    tg.setHeaderColor('#050810');
    tg.setBackgroundColor('#050810');
    const theme = tg.themeParams ?? {};
    const root = document.documentElement;
    if (theme.bg_color) root.style.setProperty('--tg-bg', theme.bg_color);
    if (theme.text_color) root.style.setProperty('--tg-text', theme.text_color);
    if (theme.button_color) root.style.setProperty('--tg-button', theme.button_color);
    if (theme.button_text_color) root.style.setProperty('--tg-button-text', theme.button_text_color);
    if (theme.link_color) root.style.setProperty('--tg-link', theme.link_color);
    root.classList.add('telegram-mini-app');
  } catch (err) {
    // Some Telegram client versions throw on setHeaderColor; harmless.
    console.warn('[telegram] init partial:', err);
  }
}

/** Subscribe to Telegram's hardware BackButton. Returns an unsubscribe
 *  function so React effects can clean up on unmount or route change. */
export function showTelegramBackButton(handler: () => void): () => void {
  const tg = getTelegramWebApp();
  if (!tg) return () => undefined;
  tg.BackButton.onClick(handler);
  tg.BackButton.show();
  return () => {
    tg.BackButton.offClick(handler);
    tg.BackButton.hide();
  };
}

export function hideTelegramBackButton(): void {
  getTelegramWebApp()?.BackButton.hide();
}

export function telegramHaptic(kind: 'success' | 'error' | 'warning' | 'light' | 'medium' | 'heavy' = 'light'): void {
  const haptic = getTelegramWebApp()?.HapticFeedback;
  if (!haptic) return;
  if (kind === 'success' || kind === 'error' || kind === 'warning') {
    haptic.notificationOccurred(kind);
  } else {
    haptic.impactOccurred(kind);
  }
}
