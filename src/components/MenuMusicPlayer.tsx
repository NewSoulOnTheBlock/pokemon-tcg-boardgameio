import { useEffect, useRef, useState } from 'react';

const MUTED_STORAGE_KEY = 'pokemon-tcg-music-muted';
const VOLUME_STORAGE_KEY = 'pokemon-tcg-music-volume';
const DEFAULT_VOLUME = 0.35;

function loadMutedPref(): boolean {
  if (typeof window === 'undefined') return false;
  return window.localStorage.getItem(MUTED_STORAGE_KEY) === '1';
}

function loadVolumePref(): number {
  if (typeof window === 'undefined') return DEFAULT_VOLUME;
  const raw = window.localStorage.getItem(VOLUME_STORAGE_KEY);
  const parsed = raw == null ? DEFAULT_VOLUME : Number.parseFloat(raw);
  return Number.isFinite(parsed) ? Math.min(1, Math.max(0, parsed)) : DEFAULT_VOLUME;
}

/**
 * Loops the 8-bit menu music on every non-match page and shows a small
 * floating toggle so the user can mute/unmute or change volume. The
 * audio element is mounted once at the App root and pause/play is
 * driven by the `paused` prop so navigating between menu pages doesn't
 * restart the track. Browser autoplay policies require a user gesture
 * before unmuted audio plays, so we start muted=true by default and
 * the user clicks the toggle (or any control) to enable sound.
 */
export function MenuMusicPlayer({ paused }: { paused: boolean }) {
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const [muted, setMuted] = useState<boolean>(loadMutedPref);
  const [volume, setVolume] = useState<number>(loadVolumePref);
  const [showVolume, setShowVolume] = useState(false);

  // Sync mute + volume from state to the audio element.
  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return;
    audio.muted = muted;
    audio.volume = volume;
  }, [muted, volume]);

  // Persist preferences.
  useEffect(() => {
    if (typeof window !== 'undefined') {
      window.localStorage.setItem(MUTED_STORAGE_KEY, muted ? '1' : '0');
    }
  }, [muted]);
  useEffect(() => {
    if (typeof window !== 'undefined') {
      window.localStorage.setItem(VOLUME_STORAGE_KEY, String(volume));
    }
  }, [volume]);

  // Drive play/pause from the `paused` prop. Match pages set paused=true
  // so the battle has no background track competing with sfx.
  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return;
    if (paused) {
      audio.pause();
    } else {
      // Browsers may reject play() if autoplay was blocked; swallow.
      audio.play().catch(() => undefined);
    }
  }, [paused]);

  return (
    <>
      <audio
        ref={audioRef}
        src="/menu-music.mp3"
        loop
        autoPlay
        preload="auto"
        // Always start with autoplay attempt; muted prop is synced via effect.
      />
      {!paused && (
        <div
          className="menu-music-control"
          onMouseEnter={() => setShowVolume(true)}
          onMouseLeave={() => setShowVolume(false)}
        >
          <button
            type="button"
            aria-label={muted ? 'Unmute menu music' : 'Mute menu music'}
            className="menu-music-toggle"
            onClick={() => setMuted((current) => !current)}
          >
            {muted ? '🔇' : '🔊'}
          </button>
          {showVolume && !muted && (
            <input
              aria-label="Menu music volume"
              className="menu-music-volume"
              type="range"
              min={0}
              max={1}
              step={0.05}
              value={volume}
              onChange={(event) => setVolume(Number.parseFloat(event.target.value))}
            />
          )}
        </div>
      )}
    </>
  );
}
