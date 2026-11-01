/** Base's block time. Blocks carry the timestamp of their slot, so a block's number and time fix every later slot. */
export const BASE_BLOCK_SECONDS = 2n;

type Stamped = { number: bigint; timestamp: bigint };

/**
 * The chain head, read off the clock from the newest block the indexer has seen instead of asked
 * for with eth_blockNumber on every pass. The estimate only decides how far a pass reads: the pass
 * reads its last block before its logs, and a block the node does not have yet (a stalled
 * sequencer, a clock running ahead) sends that pass back to eth_blockNumber. If Base ever makes
 * blocks faster than this, the estimate falls short and the indexer trails by a bounded few
 * seconds more; it never reads past the head.
 */
export class HeadClock {
  private anchor: Stamped | null = null;

  constructor(private readonly now: () => number = Date.now) {}

  /** A block the node returned. The newest one anchors the estimate. */
  observe(block: Stamped): void {
    if (this.anchor === null || block.number > this.anchor.number) this.anchor = { number: block.number, timestamp: block.timestamp };
  }

  /** Where the head should be now, or null until a block has been seen. */
  estimate(): bigint | null {
    if (this.anchor === null) return null;
    const elapsed = BigInt(Math.floor(this.now() / 1000)) - this.anchor.timestamp;
    return elapsed > 0n ? this.anchor.number + elapsed / BASE_BLOCK_SECONDS : this.anchor.number;
  }
}
