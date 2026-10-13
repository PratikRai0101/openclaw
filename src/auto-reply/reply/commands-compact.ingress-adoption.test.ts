// Manual /compact must adopt its ingress claim before the long compaction so the
// pre-adoption watchdog cannot abort the run and replay the update.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import {
  bindIngressLifecycleToReplyOptions,
  type ChannelIngressDispatchLifecycle,
} from "../../channels/message/ingress-drain-lifecycle.js";
import { createChannelIngressDrain } from "../../channels/message/ingress-drain.js";
import {
  createTestIngressQueue,
  withTempState,
} from "../../channels/message/ingress-drain.test-helpers.js";
import {
  buildCompactParams,
  compactEmbeddedAgentSession,
  handleCompactCommand,
  resetCompactCommandMocks,
} from "./commands-compact.test-support.js";
import type { HandleCommandsParams } from "./commands-types.js";

const compactConfig = {
  commands: { text: true },
  channels: { whatsapp: { allowFrom: ["*"] } },
};

describe("manual compaction ingress adoption", () => {
  beforeEach(() => {
    resetCompactCommandMocks();
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it("keeps one terminal reply instead of replaying a compaction that outlives the watchdog", async () => {
    await withTempState(async (stateDir) => {
      let clock = 1_000;
      const queue = createTestIngressQueue(stateDir, { now: () => clock });
      const compactStarted = createDeferred();
      const releaseCompaction = createDeferred();
      const dispatchFinished = createDeferred();
      let compactAbortSignal: AbortSignal | undefined;
      let replyText: string | undefined;
      let observedLifecycle: ChannelIngressDispatchLifecycle | undefined;
      vi.mocked(compactEmbeddedAgentSession).mockImplementationOnce(async (input) => {
        compactAbortSignal = input.abortSignal;
        compactStarted.resolve();
        await releaseCompaction.promise;
        return { ok: true, compacted: false };
      });

      const drain = createChannelIngressDrain({
        queue,
        now: () => clock,
        adoptionStallTimeoutMs: 1_000,
        retryPolicy: { baseMs: 1, maxMs: 1 },
        dispatchClaimedEvent: async (_event, lifecycle) => {
          observedLifecycle = lifecycle;
          try {
            const result = await handleCompactCommand(
              {
                ...buildCompactParams("/compact", compactConfig),
                sessionEntry: { sessionId: "session-1", updatedAt: 1 },
                // Mirrors a channel turn: the caller abort signal is the ingress claim signal.
                opts: {
                  ...bindIngressLifecycleToReplyOptions(lifecycle),
                  abortSignal: lifecycle.abortSignal,
                },
              } as HandleCommandsParams,
              true,
            );
            replyText = result?.reply?.text;
          } finally {
            dispatchFinished.resolve();
          }
          return { kind: "completed" };
        },
      });

      try {
        await queue.enqueue("compact-1", { text: "/compact" }, { laneKey: "telegram:chat" });
        await drain.drainOnce();
        await compactStarted.promise;

        // Adoption completes the claim while compaction is still running.
        expect(observedLifecycle?.abortSignal.aborted).toBe(false);
        expect(compactAbortSignal).toBe(observedLifecycle?.abortSignal);
        expect(await queue.listClaims()).toEqual([]);
        expect(await queue.listPending()).toEqual([]);

        clock += 5_000;
        await vi.advanceTimersByTimeAsync(5_000);

        // The cleared watchdog must not abort the adopted compaction.
        expect(observedLifecycle?.abortSignal.aborted).toBe(false);
        expect(await queue.listClaims()).toEqual([]);
        expect(await queue.listPending()).toEqual([]);

        releaseCompaction.resolve();
        await dispatchFinished.promise;
        await drain.waitForIdle();
        expect(replyText).toContain("Compaction skipped");
        expect(compactEmbeddedAgentSession).toHaveBeenCalledOnce();
        expect(await drain.drainOnce()).toEqual({ started: 0 });
      } finally {
        releaseCompaction.resolve();
        drain.dispose();
      }
    });
  });
});
