// Portal-based hover preview for card images, modelled after the
// CardPreview/CardHover combo in chains-tcg. Shows the small thumbnail in
// place, then renders an enlarged copy in a portal that's clamped to the
// viewport so it never gets clipped by a parent's overflow:hidden.

import { useEffect, useRef, useState, type CSSProperties } from 'react';
import { createPortal } from 'react-dom';
import type { Card } from '../game/types';

interface CardImageProps {
  card: Card;
  className?: string;
  imageClassName?: string;
  loading?: 'lazy' | 'eager';
}

const PREVIEW_WIDTH = 280;
const PREVIEW_HEIGHT = 392;
const PREVIEW_PADDING = 12;

function PreviewOverlay({ card, anchor }: { card: Card; anchor: DOMRect | null }) {
  if (!anchor || typeof document === 'undefined') return null;

  const preview = card.images?.large ?? card.images?.small;
  if (!preview) return null;

  const viewportW = window.innerWidth;
  const viewportH = window.innerHeight;

  let left = anchor.right + PREVIEW_PADDING;
  if (left + PREVIEW_WIDTH > viewportW - PREVIEW_PADDING) {
    left = anchor.left - PREVIEW_WIDTH - PREVIEW_PADDING;
  }
  if (left < PREVIEW_PADDING) {
    left = Math.max(PREVIEW_PADDING, Math.min(viewportW - PREVIEW_WIDTH - PREVIEW_PADDING, anchor.left));
  }

  let top = anchor.top + anchor.height / 2 - PREVIEW_HEIGHT / 2;
  top = Math.max(PREVIEW_PADDING, Math.min(top, viewportH - PREVIEW_HEIGHT - PREVIEW_PADDING));

  const style: CSSProperties = {
    position: 'fixed',
    left,
    top,
    width: PREVIEW_WIDTH,
    height: PREVIEW_HEIGHT,
    zIndex: 1000,
    pointerEvents: 'none',
  };

  return createPortal(
    <div className="card-preview-portal" style={style} aria-hidden="true">
      <img src={preview} alt="" loading="lazy" decoding="async" />
    </div>,
    document.body,
  );
}

export function CardImage({ card, className = 'card-image', imageClassName, loading = 'lazy' }: CardImageProps) {
  const thumbnail = card.images?.small ?? card.images?.large;
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [anchor, setAnchor] = useState<DOMRect | null>(null);

  useEffect(() => {
    if (!anchor) return;
    const update = () => {
      if (containerRef.current) {
        setAnchor(containerRef.current.getBoundingClientRect());
      }
    };
    window.addEventListener('scroll', update, true);
    window.addEventListener('resize', update);
    return () => {
      window.removeEventListener('scroll', update, true);
      window.removeEventListener('resize', update);
    };
  }, [anchor]);

  const open = () => {
    if (containerRef.current) {
      setAnchor(containerRef.current.getBoundingClientRect());
    }
  };
  const close = () => setAnchor(null);

  if (!thumbnail) {
    return (
      <div className={`${className} card-image-placeholder`} aria-label={card.name}>
        <strong>{card.name}</strong>
        <span>{card.kind}</span>
      </div>
    );
  }

  return (
    <div
      className={className}
      ref={containerRef}
      onPointerEnter={open}
      onPointerLeave={close}
      onFocus={open}
      onBlur={close}
    >
      <img className={imageClassName} src={thumbnail} alt={card.name} loading={loading} decoding="async" />
      <PreviewOverlay card={card} anchor={anchor} />
    </div>
  );
}
