// In-memory HCS topic for tests: a writer that assigns consensus sequences and a
// mirror reader that can lag behind consensus by a number of reads. No network, no keys.
import type { HcsKey, TopicInfo, TopicMessage, TopicReader } from '../src/hcs.js';
import { HcsPublishError, type TopicWriter } from '../src/hcs-publish.js';

type Stored = { message: TopicMessage; hiddenReads: number };

export type FakeHcs = {
  writer: TopicWriter;
  reader: TopicReader;
  /** Everything that reached consensus, visible or not. */
  consensus(): TopicMessage[];
  /** Adds a message as if another party (or an earlier run) had published it. */
  inject(text: string): void;
  submits: number;
  topicReads: number;
  /** Mirror reads a new message stays invisible for. */
  lagReads: number;
  /** Throw on the Nth submit (1-based), before or after consensus. */
  failSubmit?: { at: number; afterConsensus: boolean; error: unknown };
  topic: TopicInfo;
};

export function fakeHcs(topicId: string, key: HcsKey, lagReads = 0): FakeHcs {
  const stored: Stored[] = [];
  let sequence = 0;
  const append = (bytes: Uint8Array) => {
    sequence++;
    stored.push({
      message: {
        topicId,
        sequence,
        consensusTimestamp: `1790670${String(sequence).padStart(3, '0')}.000000001`,
        bytes,
        chunkTotal: 1,
      },
      hiddenReads: state.lagReads,
    });
    return sequence;
  };
  const state: FakeHcs = {
    submits: 0,
    topicReads: 0,
    lagReads,
    topic: { topicId, deleted: false, submitKey: key },
    consensus: () => stored.map(s => s.message),
    inject: text => void append(new TextEncoder().encode(text)),
    writer: {
      submitKey: () => ({ ...key }),
      async createTopic() {
        return { topicId };
      },
      async submit(id, message) {
        state.submits++;
        if (id !== topicId) throw new HcsPublishError('submit_failed', 'INVALID_TOPIC_ID');
        const fail = state.failSubmit?.at === state.submits ? state.failSubmit : undefined;
        if (fail && !fail.afterConsensus) throw fail.error;
        const seq = append(message.slice());
        if (fail) throw fail.error; // reached consensus, but the receipt never came back
        return { sequence: seq, transactionId: `0.0.4242@1790670000.${String(seq).padStart(9, '0')}` };
      },
    },
    reader: {
      async topic(id) {
        state.topicReads++;
        return { ...state.topic, topicId: id };
      },
      async messages() {
        const out: TopicMessage[] = [];
        for (const s of stored) {
          if (s.hiddenReads > 0) break; // the mirror shows a prefix of consensus order
          out.push(s.message);
        }
        for (const s of stored) if (s.hiddenReads > 0) s.hiddenReads--;
        return out;
      },
    },
  };
  return state;
}
