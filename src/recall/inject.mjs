/**
 * Per-turn recall: remembers the latest human message and contributes the matching
 * old memories to the prompt assembly.
 *
 * The contribution is a `system-prompt/assemble` waterfall result because that is the
 * only surface that both accepts an asynchronous computation and keeps the injected
 * text reconstructable from the session log (the assembly renders every context into
 * the durable runtime-context snapshot). A direct push into `assembly.contexts` is
 * dropped by `refreshContext`, so it is not used here.
 *
 * Failure policy: recall is best effort. A timeout falls back to keyword scoring, any
 * other error contributes nothing, and `next()` is always preserved by the caller.
 */

export const RECALL_CONTEXT_NAME = 'mempalace:recall'

const MIN_MESSAGE_CHARS = 4

function textOf(content) {
  if (typeof content === 'string') return content.trim()
  if (!Array.isArray(content)) return ''
  return content
    .filter(block => block?.type === 'text' && typeof block.text === 'string')
    .map(block => block.text)
    .join('\n')
    .trim()
}

function isSubagent(agent) {
  const header = agent?.session?.header
  if (!header) return false
  if (header.origin === 'subagent') return true
  if (Number(agent?.delegationDepth ?? 0) > 0) return true
  return Boolean(header.parentSessionId)
}

function withTimeout(promise, ms, onTimeout) {
  let timer
  const timeout = new Promise((resolve, reject) => {
    timer = setTimeout(() => {
      onTimeout?.()
      reject(Object.assign(new Error(`recall exceeded ${ms}ms`), { code: 'MEMPALACE_RECALL_TIMEOUT' }))
    }, ms)
    timer.unref?.()
  })
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer))
}

/**
 * @param options.config - validated plugin config (recall fields are read live).
 * @param options.recall - `async (text, {allowVector}) => {block, mode, count}`.
 * @param options.logger - used for warnings only; recall never throws to the caller.
 * @returns `{noteUserMessage, contribute, snapshot}`.
 */
export function createRecallInjection({ config, recall, logger = console } = {}) {
  const states = new WeakMap()
  const stats = { messages: 0, assemblies: 0, injected: 0, timeouts: 0, errors: 0, lastMode: null, lastCount: 0 }

  const fingerprint = () => JSON.stringify([
    config.recallTopK,
    config.recallMinScore,
    config.recallMaxChars,
    config.recallExcludeSensitive,
    config.embeddingSource,
    config.embeddingDim,
    config.cloudEmbeddingDim,
    config.embeddingModel,
  ])

  async function compute(text) {
    try {
      return await withTimeout(
        recall(text, { allowVector: true }),
        config.recallTimeoutMs,
        () => { stats.timeouts += 1 },
      )
    } catch (error) {
      if (error?.code !== 'MEMPALACE_RECALL_TIMEOUT') {
        logger?.warn?.(`dsh-mempalace: 召回失败，改用关键字：${error?.message ?? error}`)
      }
      try {
        return await recall(text, { allowVector: false })
      } catch (fallbackError) {
        stats.errors += 1
        logger?.warn?.(`dsh-mempalace: 关键字召回也失败：${fallbackError?.message ?? fallbackError}`)
        return { block: '', mode: 'none', count: 0 }
      }
    }
  }

  /** Records the newest human message of a session; assistant, tool and subagent traffic is ignored. */
  function noteUserMessage(session, event) {
    if (!session || !event || event.type !== 'user/message') return false
    const data = event.data
    if (data?.source?.kind !== 'user') return false
    const text = textOf(data?.content)
    if (text.length < MIN_MESSAGE_CHARS) return false
    states.set(session, { seq: String(event.seq ?? ''), text, key: null, block: '', mode: 'none', count: 0, injectedKey: null })
    stats.messages += 1
    return true
  }

  /**
   * Appends the recall block to an accepted assembly.
   *
   * The block is injected once per user message: step 1 emits it as a runtime-context
   * message that later steps read from history, so repeating it every step would only
   * spend tokens on the same text.
   *
   * @param assembly - the assembly returned by other listeners.
   * @param agent - the agent whose turn is being assembled.
   * @returns the same assembly when nothing is recalled, otherwise one extra context.
   */
  async function contribute(assembly, agent) {
    if (!config.recallInjectionEnabled || typeof recall !== 'function') return assembly
    const session = agent?.session
    if (!session || isSubagent(agent)) return assembly
    const state = states.get(session)
    if (!state) return assembly
    stats.assemblies += 1
    const key = `${state.seq}:${fingerprint()}`
    if (state.injectedKey === key) return assembly
    if (state.key !== key) {
      const result = await compute(state.text)
      state.key = key
      state.block = result?.block ?? ''
      state.mode = result?.mode ?? 'none'
      state.count = Number(result?.count ?? 0)
    }
    stats.lastMode = state.mode
    stats.lastCount = state.count
    if (!state.block) {
      state.injectedKey = key
      return assembly
    }
    state.injectedKey = key
    stats.injected += 1
    return {
      ...assembly,
      contexts: [...(assembly.contexts ?? []), { name: RECALL_CONTEXT_NAME, text: state.block }],
    }
  }

  return {
    noteUserMessage,
    contribute,
    snapshot: () => ({ ...stats, enabled: config.recallInjectionEnabled }),
  }
}
