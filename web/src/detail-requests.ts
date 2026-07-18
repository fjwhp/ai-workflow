export type DetailRequestToken = { generation: number; requirementId: string };

export class DetailRequestTracker {
  private generation = 0;
  private desiredId: string | null = null;
  begin(requirementId: string): DetailRequestToken { this.desiredId = requirementId; return { generation: ++this.generation, requirementId }; }
  clear() { this.desiredId = null; this.generation += 1; }
  accept(token: DetailRequestToken, desiredId: string | null) { return token.generation === this.generation && token.requirementId === this.desiredId && token.requirementId === desiredId; }
}
