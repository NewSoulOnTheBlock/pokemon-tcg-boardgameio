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
 * Looping background music with a floating mute/volume toggle. The
 * audio element is mounted once at the App root and its `src` swaps
 * between the menu loop and the battle loop based on the current page.
 * Mute + volume are shared across all tracks (single localStorage
 * preference) so silencing one silences all of them.
 *
 * Browser autoplay policies require a user gesture before unmuted audio
 * plays, so initial autoplay may be blocked — the first toggle click or
 * any other user interaction will pick it up.
 */
export function BackgroundMusicPlayer({ src, label, paused }: { src: string; label: string; paused: boolean }) {
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const [muted, setMuted] = useState<boolean>(loadMutedPref);
  const [volume, setVolume] = useState<number>(loadVolumePref);
  const [showVolume, setShowVolume] = useState(false);

  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return;
    audio.muted = muted;
    audio.volume = volume;
  }, [muted, volume]);

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

  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return;
    if (paused) {
      audio.pause();
    } else {
      audio.play().catch(() => undefined);
    }
  }, [paused, src]);

  return (
    <>
      <audio
        ref={audioRef}
        src={src}
        loop
        autoPlay
        preload="auto"
      />
      <div
        className="menu-music-control"
        onMouseEnter={() => setShowVolume(true)}
        onMouseLeave={() => setShowVolume(false)}
        title={label}
      >
        <button
          type="button"
          aria-label={muted ? `Unmute ${label}` : `Mute ${label}`}
          className="menu-music-toggle"
          onClick={() => setMuted((current) => !current)}
        >
          {muted ? '🔇' : '🔊'}
        </button>
        {showVolume && !muted && (
          <input
            aria-label={`${label} volume`}
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
    </>
  );
}
