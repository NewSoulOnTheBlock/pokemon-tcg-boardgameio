export const PLAYMAT_IDS = ['green', 'pink', 'purple', 'black'] as const;

export type PlaymatID = (typeof PLAYMAT_IDS)[number];

export const PLAYMAT_IMAGE_BY_ID: Record<PlaymatID, string> = {
  green: '/playmats/green.webp',
  pink: '/playmats/pink.webp',
  purple: '/playmats/purple.webp',
  black: '/playmats/black.webp',
};

export function chooseRandomPlaymatId(rollDie: (sides: number) => number): PlaymatID {
  return PLAYMAT_IDS[rollDie(PLAYMAT_IDS.length) - 1];
}
