import type { LLMock } from '@copilotkit/aimock';
import { stepCountIs } from '@internal/ai-sdk-v5';
import { expect, it } from 'vitest';
import { z } from 'zod/v4';
import { MockMemory } from '../../../../memory/mock';
import { PubSub } from '../../../../events/pubsub';
import { EventCallback } from '../../../../events/types';
import { createTool } from '../../../../tools';
import { TaskStateProcessor } from '../../../../tools/builtin/task-state-processor';
import { taskWriteTool } from '../../../../tools/builtin/task-tools';
import { createSharedAgent, runLoopScenario, useLoopScenarioAimock, describeForAllEngines } from '../aimock-scenario';

/**
 * Signal edge cases: multiple subscribers, unsubscribe cleanup,
 * state signal cache deduplication.
 *
 * Tests documented behaviors from signals.mdx and agent-signals.test.ts:
 * 1. Multiple subscribers on same thread both receive the response
 * 2. Unsubscribe stops delivery to that subscriber
 * 3. sendStateSignal with same cacheKey+contents is skipped (unchanged)
 */

class InMemoryPubSub extends PubSub {
  #subscribers = new Map<string, Set<EventCallback>>();
  #index = 0;
  #pending = new Set<Promise<void>>();

  async publish(topic: string, event: any, _options?: { localOnly?: boolean }): Promise<void> {
    const subscribers = [...(this.#subscribers.get(topic) ?? [])];
    const envelope = {
      ...event,
      id: `event-${this.#index}`,
      createdAt: new Date(),
      index: this.#index++,
    };
    const pending = new Promise<void>(resolve => {
      setTimeout(() => {
        try {
          // Best-effort delivery: a throwing subscriber must not stop others
          // or bubble as an uncaught async error.
          for (const subscriber of subscribers) {
            try {
              subscriber(envelope);
            } catch {
              // ignore individual subscriber failures
            }
          }
        } finally {
          resolve();
        }
      }, 0);
    });
    this.#pending.add(pending);
    pending.finally(() => this.#pending.delete(pending));
  }

  async subscribe(topic: string, cb: EventCallback): Promise<void> {
    const subscribers = this.#subscribers.get(topic) ?? new Set<EventCallback>();
    subscribers.add(cb);
    this.#subscribers.set(topic, subscribers);
  }

  async unsubscribe(topic: string, cb: EventCallback): Promise<void> {
    this.#subscribers.get(topic)?.delete(cb);
  }

  async flush(): Promise<void> {
    await Promise.all([...this.#pending]);
  }
}

async function readNextRun(iterator: AsyncIterator<any>) {
  let runId: string | undefined;
  let text = '';
  const parts: any[] = [];

  while (true) {
    const next = await iterator.next();
    if (next.done) return { runId, text, parts, done: true };

    const part = next.value;
    parts.push(part);
    runId ??= part.runId;
    if (part.type === 'text-delta') {
      text += part.payload.text;
    }
    if (part.type === 'finish' || part.type === 'error' || part.type === 'abort') {
      return { runId, text, parts, done: false };
    }
  }
}

function withTimeout<T>(promise: Promise<T>, message: string, timeoutMs = 2000): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  // Attach cleanup to the race result so the timer is cleared whether `promise`
  // wins or the timeout fires. Attaching `.finally` to the timeout promise alone
  // would leak the timer when `promise` resolves first (it never settles).
  return Promise.race([
    promise,
    new Promise<T>((_, reject) => {
      timeout = setTimeout(() => reject(new Error(message)), timeoutMs);
    }),
  ]).finally(() => {
    if (timeout) clearTimeout(timeout);
  }) as Promise<T>;
}

describeForAllEngines(
  'AIMock scenario: signal edge cases',
  engine => {
    const getMock = useLoopScenarioAimock();

    it('multiple subscribers on same thread both receive the response', async () => {
      const pubsub = new InMemoryPubSub();
      const mock = getMock();
      const memory = new MockMemory();
      const threadId = 'multi-sub-thread';
      const resourceId = 'multi-sub-resource';

      const { agent } = await runLoopScenario({
        engine,
        llm: mock,
        prompt: 'Initial prompt',
        stopWhen: stepCountIs(1),
        pubsub,
        memory,
        threadId,
        resourceId,
        fixtures: llm => {
          llm.on(
            { endpoint: 'chat', hasToolResult: false },
            {
              content: 'Shared response for both subscribers',
            },
          );
        },
      });

      // Create two subscribers on the same thread
      const sub1 = await agent.subscribeToThread({ threadId, resourceId });
      const sub2 = await agent.subscribeToThread({ threadId, resourceId });

      const run1Promise = readNextRun(sub1.stream[Symbol.asyncIterator]());
      const run2Promise = readNextRun(sub2.stream[Symbol.asyncIterator]());

      // Send a message that triggers both subscribers
      const result = await agent.sendMessage(
        { contents: 'Hello to both' },
        {
          resourceId,
          threadId,
          ifIdle: {
            streamOptions: { memory: { resource: resourceId, thread: threadId } },
          },
        },
      );

      const [run1, run2] = await Promise.all([
        withTimeout(run1Promise, 'sub1 timed out'),
        withTimeout(run2Promise, 'sub2 timed out'),
      ]);

      // Both subscribers receive the same response
      await expect(result.accepted).resolves.toMatchObject({ action: 'wake' });
      expect(run1.done).toBe(false);
      expect(run2.done).toBe(false);
      expect(run1.text).toBe('Shared response for both subscribers');
      expect(run2.text).toBe('Shared response for both subscribers');
      // Same runId for both
      expect(run1.runId).toBe(run2.runId);

      await sub1.unsubscribe();
      await sub2.unsubscribe();
    });

    it('unsubscribed subscriber stops receiving messages', async () => {
      const pubsub = new InMemoryPubSub();
      const mock = getMock();
      const memory = new MockMemory();
      const threadId = 'unsub-thread';
      const resourceId = 'unsub-resource';

      const { agent } = await runLoopScenario({
        engine,
        llm: mock,
        prompt: 'Initial prompt',
        stopWhen: stepCountIs(1),
        pubsub,
        memory,
        threadId,
        resourceId,
        fixtures: llm => {
          llm.on(
            { endpoint: 'chat', hasToolResult: false },
            {
              content: 'Response text',
            },
          );
        },
      });

      // Subscribe, then immediately unsubscribe
      const sub = await agent.subscribeToThread({ threadId, resourceId });
      let received = false;
      // Background reader: should never observe a part once unsubscribed. Marked
      // void deliberately — the test asserts `received` stays false rather than
      // awaiting this (it would otherwise hang, since no part is delivered).
      void (async () => {
        for await (const _part of sub.stream) {
          received = true;
          break;
        }
      })();

      await sub.unsubscribe();

      // Send a message — the unsubscribed subscriber should NOT receive it
      await agent.sendMessage(
        { contents: 'After unsubscribe' },
        {
          resourceId,
          threadId,
          ifIdle: {
            streamOptions: { memory: { resource: resourceId, thread: threadId } },
          },
        },
      );

      // Wait a bit to ensure delivery would have happened
      await new Promise(resolve => setTimeout(resolve, 200));

      // The unsubscribed subscriber should not have received anything
      expect(received).toBe(false);
    });

    it.each(['sendStateSignal', 'sendSignal', 'sendMessage'] as const)(
      'does not replay prior tool content into the next step after an in-loop %s',
      async signalMethod => {
        const pubsub = new InMemoryPubSub();
        const mock = getMock();
        const memory = new MockMemory();
        const threadId = `signal-slice-thread-${signalMethod}`;
        const resourceId = `signal-slice-resource-${signalMethod}`;
        const stepContents: string[] = [];
        let agent: any;
        let signalAccepted: Promise<any> | undefined;

        const queueStateTool = createTool({
          id: 'queue_state',
          description: 'Queue a signal while the current loop step is still active.',
          inputSchema: z.object({}),
          outputSchema: z.object({ queued: z.boolean() }),
          execute: async () => {
            if (signalMethod === 'sendStateSignal') {
              const result = await agent.sendStateSignal(
                {
                  id: 'task-list',
                  cacheKey: 'task-list:v1',
                  mode: 'snapshot',
                  contents: 'Task list changed while the first tool step was active',
                  value: { activeTask: 'prove response slice drift' },
                },
                { resourceId, threadId },
              );
              signalAccepted = result.accepted;
            } else if (signalMethod === 'sendSignal') {
              const result = await agent.sendSignal(
                { type: 'user-message', contents: 'Follow-up from sendSignal while the first tool step was active' },
                { resourceId, threadId },
              );
              signalAccepted = result.accepted;
            } else {
              const result = await agent.sendMessage(
                { contents: 'Follow-up from sendMessage while the first tool step was active' },
                { resourceId, threadId },
              );
              signalAccepted = result.accepted;
            }
            await signalAccepted;
            return { queued: true };
          },
        });

        const sharedAgent = await createSharedAgent(mock, {
          tools: { queue_state: queueStateTool },
          memory,
          pubsub,
        });
        agent = sharedAgent.agent;

        const { output, requests } = await runLoopScenario({
          engine,
          llm: mock,
          sharedAgent,
          prompt: 'Call queue_state, then answer after any signal update.',
          tools: { queue_state: queueStateTool },
          stopWhen: stepCountIs(5),
          pubsub,
          memory,
          threadId,
          resourceId,
          onStepFinish: ({ content }: any) => {
            stepContents.push(JSON.stringify(content));
          },
          fixtures: llm => {
            llm.on(
              { endpoint: 'chat', hasToolResult: false },
              {
                toolCalls: [
                  {
                    id: 'call_queue_state',
                    name: 'queue_state',
                    arguments: {},
                  },
                ],
              },
            );
            llm.on(
              { endpoint: 'chat', hasToolResult: true },
              { content: 'I saw the queued signal update and finished cleanly.' },
            );
          },
        });

        await expect(signalAccepted).resolves.toMatchObject({ action: 'deliver' });
        expect(requests).toHaveLength(2);

        expect(stepContents).toHaveLength(2);
        expect(stepContents[0]).toContain('queue_state');
        expect(stepContents[0]).toContain('"tool-result"');
        expect(stepContents[1]).not.toContain('queue_state');
        expect(stepContents[1]).not.toContain('"tool-result"');

        await expect(output.text).resolves.toContain('finished cleanly');
      },
    );

    it('keeps complex mixed content isolated across signal-drained steps', async () => {
      const pubsub = new InMemoryPubSub();
      const mock = getMock();
      const memory = new MockMemory();
      const threadId = 'complex-signal-slice-thread';
      const resourceId = 'complex-signal-slice-resource';
      const stepContents: string[] = [];
      const stepReasoning: string[] = [];
      let agent: any;
      let signalAccepted: Promise<any> | undefined;

      const makeTool = (id: string, resultKey: string) =>
        createTool({
          id,
          description: `Return ${id} data.`,
          inputSchema: z.object({ value: z.string().optional() }),
          outputSchema: z.object({ tool: z.string(), value: z.string() }),
          execute: async ({ value }: { value?: string }) => {
            if (id === 'mixed_tool_3') {
              const result = await agent.sendStateSignal(
                {
                  id: 'mixed-state',
                  cacheKey: 'mixed-state:v1',
                  mode: 'snapshot',
                  contents: 'Mixed content state changed while tools were active',
                  value: { activeTool: id },
                },
                { resourceId, threadId },
              );
              signalAccepted = result.accepted;
              await signalAccepted;
            }
            return { tool: id, value: value ?? resultKey };
          },
        });

      const tools = {
        mixed_tool_1: makeTool('mixed_tool_1', 'one'),
        mixed_tool_2: makeTool('mixed_tool_2', 'two'),
        mixed_tool_3: makeTool('mixed_tool_3', 'three'),
        mixed_tool_4: makeTool('mixed_tool_4', 'four'),
        mixed_tool_5: makeTool('mixed_tool_5', 'five'),
        followup_tool_1: makeTool('followup_tool_1', 'six'),
        followup_tool_2: makeTool('followup_tool_2', 'seven'),
      };

      const sharedAgent = await createSharedAgent(mock, {
        tools,
        memory,
        pubsub,
      });
      agent = sharedAgent.agent;

      const { output, requests } = await runLoopScenario({
        engine,
        llm: mock,
        sharedAgent,
        prompt: 'Use mixed tools, observe any signal, then continue with follow-up tools.',
        tools,
        stopWhen: stepCountIs(6),
        pubsub,
        memory,
        threadId,
        resourceId,
        onStepFinish: ({ content, reasoningText }: any) => {
          stepContents.push(JSON.stringify(content));
          stepReasoning.push(reasoningText || '');
        },
        fixtures: (llm: LLMock) => {
          llm.on(
            { endpoint: 'chat', hasToolResult: false },
            {
              finishReason: 'tool_calls',
              reasoning: 'First reasoning before mixed tool fanout.',
              content: 'First text before five tool calls.',
              toolCalls: [
                { id: 'call_mixed_1', name: 'mixed_tool_1', arguments: { value: 'one' } },
                { id: 'call_mixed_2', name: 'mixed_tool_2', arguments: { value: 'two' } },
                { id: 'call_mixed_3', name: 'mixed_tool_3', arguments: { value: 'three' } },
                { id: 'call_mixed_4', name: 'mixed_tool_4', arguments: { value: 'four' } },
                { id: 'call_mixed_5', name: 'mixed_tool_5', arguments: { value: 'five' } },
              ],
            },
          );
          llm.on(
            { endpoint: 'chat', hasToolResult: true },
            {
              reasoning: 'Second reasoning after signal-drained first tools.',
              content: 'Second text with all mixed work complete.',
            },
          );
        },
      });

      await expect(signalAccepted).resolves.toMatchObject({ action: 'deliver' });
      expect(requests).toHaveLength(2);
      expect(stepContents).toHaveLength(2);
      expect(stepReasoning).toHaveLength(2);

      expect(stepContents[0]).toContain('First text before five tool calls.');
      expect(stepContents[0]).toContain('mixed_tool_1');
      expect(stepContents[0]).toContain('mixed_tool_5');
      expect(stepContents[0]).toContain('"tool-result"');
      expect(stepReasoning[0]).toContain('First reasoning before mixed tool fanout.');

      expect(stepContents[1]).toContain('Second text with all mixed work complete.');
      expect(stepContents[1]).not.toContain('mixed_tool_1');
      expect(stepContents[1]).not.toContain('mixed_tool_5');
      expect(stepContents[1]).not.toContain('"tool-result"');
      expect(stepReasoning[1]).toContain('Second reasoning after signal-drained first tools.');

      await expect(output.text).resolves.toContain('Second text with all mixed work complete.');
    });

    it('does not replay prior task_write content into the next step after TaskStateProcessor.computeStateSignal', async () => {
      const pubsub = new InMemoryPubSub();
      const mock = getMock();
      const memory = new MockMemory();
      const threadId = 'task-state-processor-slice-thread';
      const resourceId = 'task-state-processor-slice-resource';
      const stepContents: string[] = [];
      const tools = { task_write: taskWriteTool };

      const { output, requests } = await runLoopScenario({
        engine,
        llm: mock,
        prompt: 'Write a task list, then answer after the task state signal is available.',
        tools,
        inputProcessors: [new TaskStateProcessor()],
        stopWhen: stepCountIs(5),
        pubsub,
        memory,
        threadId,
        resourceId,
        onStepFinish: ({ content }: any) => {
          stepContents.push(JSON.stringify(content));
        },
        fixtures: (llm: LLMock) => {
          llm.on(
            { endpoint: 'chat', hasToolResult: false },
            {
              toolCalls: [
                {
                  id: 'call_task_write',
                  name: 'task_write',
                  arguments: {
                    tasks: [
                      {
                        id: 'task_probe_processor_state_signal',
                        content: 'Probe processor state signal slicing',
                        status: 'in_progress',
                        activeForm: 'Probing processor state signal slicing',
                      },
                    ],
                  },
                },
              ],
            },
          );
          llm.on(
            { endpoint: 'chat', hasToolResult: true },
            { content: 'I saw the computed task state signal and finished cleanly.' },
          );
        },
      });

      expect(requests).toHaveLength(2);
      expect(stepContents).toHaveLength(2);
      expect(stepContents[0]).toContain('task_write');
      expect(stepContents[0]).toContain('"tool-result"');
      expect(stepContents[1]).not.toContain('task_write');
      expect(stepContents[1]).not.toContain('"tool-result"');

      await expect(output.text).resolves.toContain('finished cleanly');
    });

    it('keeps visible text across task state signals when prior thread history exists', async () => {
      const pubsub = new InMemoryPubSub();
      const mock = getMock();
      const memory = new MockMemory();
      const threadId = 'task-state-history-text-drop-thread';
      const resourceId = 'task-state-history-text-drop-resource';
      const stepContents: string[] = [];
      const tools = { task_write: taskWriteTool };

      const seed = await runLoopScenario({
        engine,
        llm: mock,
        prompt: 'Seed prior task history.',
        tools,
        inputProcessors: [new TaskStateProcessor()],
        stopWhen: stepCountIs(5),
        pubsub,
        memory,
        threadId,
        resourceId,
        fixtures: (llm: LLMock) => {
          llm.on(
            { endpoint: 'chat', hasToolResult: false },
            {
              content: 'Prior assistant text that should stay in history but not current step content.',
              toolCalls: [
                {
                  id: 'call_seed_task_write',
                  name: 'task_write',
                  arguments: {
                    tasks: [
                      {
                        id: 'task_seed_history',
                        content: 'Seed prior task history',
                        status: 'completed',
                        activeForm: 'Seeding prior task history',
                      },
                    ],
                  },
                },
              ],
            },
          );
          llm.on({ endpoint: 'chat', hasToolResult: true }, { content: 'Prior task history was seeded cleanly.' });
        },
      });

      mock.clearFixtures();
      mock.clearRequests();
      mock.resetMatchCounts();

      const { output, requests } = await runLoopScenario({
        engine,
        llm: mock,
        sharedAgent: { agent: seed.agent, mastra: seed.mastra },
        prompt: 'Write a task, then continue after the computed task state signal.',
        tools,
        inputProcessors: [new TaskStateProcessor()],
        stopWhen: stepCountIs(5),
        pubsub,
        memory,
        threadId,
        resourceId,
        onStepFinish: ({ content }: any) => {
          stepContents.push(JSON.stringify(content));
        },
        fixtures: (llm: LLMock) => {
          llm.onTurn(3, 'Write a task, then continue after the computed task state signal.', {
            content: 'I will write the task before continuing.',
            toolCalls: [
              {
                id: 'call_task_write_with_text',
                name: 'task_write',
                arguments: {
                  tasks: [
                    {
                      id: 'task_probe_history_text_drop',
                      content: 'Probe task state signal with prior history',
                      status: 'in_progress',
                      activeForm: 'Probing task state signal with prior history',
                    },
                  ],
                },
              },
            ],
          });
          llm.onTurn(5, 'Write a task, then continue after the computed task state signal.', {
            content: 'I still remember the task-write preamble and finished cleanly.',
          });
        },
      });

      expect(requests).toHaveLength(2);
      expect(stepContents).toHaveLength(2);
      expect(stepContents[0]).toContain('I will write the task before continuing.');
      expect(stepContents[0]).toContain('task_write');
      expect(stepContents[0]).toContain('"tool-result"');
      expect(stepContents[0]).not.toContain('Prior assistant text that should stay in history');
      expect(stepContents[1]).toContain('I still remember the task-write preamble and finished cleanly.');
      expect(stepContents[1]).not.toContain('task_write');
      expect(stepContents[1]).not.toContain('"tool-result"');

      await expect(output.text).resolves.toContain('finished cleanly');
    });

    it('sendStateSignal with unchanged cacheKey+contents is skipped', async () => {
      const pubsub = new InMemoryPubSub();
      const mock = getMock();
      const memory = new MockMemory();
      const threadId = 'cache-thread';
      const resourceId = 'cache-resource';

      const { agent } = await runLoopScenario({
        engine,
        llm: mock,
        prompt: 'Initial prompt',
        stopWhen: stepCountIs(1),
        pubsub,
        memory,
        threadId,
        resourceId,
        fixtures: llm => {
          llm.on(
            { endpoint: 'chat', hasToolResult: false },
            {
              content: 'Initial response',
            },
          );
        },
      });

      // First state signal — should be accepted
      const result1 = await agent.sendStateSignal(
        {
          id: 'browser',
          cacheKey: 'browser:v1',
          mode: 'snapshot',
          contents: 'Browser is open on https://example.com',
          value: { activeUrl: 'https://example.com' },
        },
        {
          resourceId,
          threadId,
          ifIdle: { behavior: 'persist' },
        },
      );

      expect(result1.skipped).toBeFalsy();
      await expect(result1.accepted).resolves.toMatchObject({ action: 'persist' });

      // Second state signal with same cacheKey and same contents — should be skipped
      const result2 = await agent.sendStateSignal(
        {
          id: 'browser',
          cacheKey: 'browser:v1',
          contents: 'Browser is open on https://example.com',
        },
        {
          resourceId,
          threadId,
          ifIdle: { behavior: 'persist' },
        },
      );

      expect(result2.skipped).toBe(true);

      // Third state signal with a changed cacheKey (and changed contents) — the
      // changed cacheKey means it is not deduplicated, so it is accepted.
      const result3 = await agent.sendStateSignal(
        {
          id: 'browser',
          cacheKey: 'browser:v2',
          mode: 'snapshot',
          contents: 'Browser is open on https://different.com',
          value: { activeUrl: 'https://different.com' },
        },
        {
          resourceId,
          threadId,
          ifIdle: { behavior: 'persist' },
        },
      );

      expect(result3.skipped).toBeFalsy();
      await expect(result3.accepted).resolves.toMatchObject({ action: 'persist' });
    });
  },
  { skip: ['durable'] },
);
