export interface SquareDirectoryItem {
  id: string; kind: 'bot' | 'group' | 'game' | 'mystery'; author: string; target: string; at: string;
  gameId?: string; status?: string; startMode?: string; scheduledAt?: string | null; joined?: number; maxPlayers?: number;
}
export interface SquareDirectoryPage {
  items: SquareDirectoryItem[]; total: number; counts: Record<string, number>; nextCursor: string | null;
}
export function squarePage(entries: any[], args?: { kind?: unknown; limit?: unknown; cursor?: unknown }): SquareDirectoryPage;
