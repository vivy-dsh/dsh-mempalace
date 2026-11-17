/**
 * One embedding seam for both providers.
 *
 * The store only ever sees a space descriptor plus `embedIfReady(text)`; whether the
 * vector comes from the local transformer or from the world gateway's embedding slot
 * is decided here and reported through `status()`/`probe()`. Selecting `cloud` never
 * falls back to the local model: a broken slot reports why and leaves rows without
 * vectors, because a silent switch would index a different space than the one the
 * user chose.
 */

import { CloudEmbeddingService } from './cloud_embedding.mjs'
import { readEmbeddingSlot } from './capability_slot.mjs'
import { EmbeddingService } from './embeddings.mjs'
import { normalizeSpaceDescriptor } from './spaces.mjs'

/** @returns the local descriptor used when `embeddingSource` is `local`. */
export function localSpaceDescriptor(config) {
  return normalizeSpaceDescriptor({
    source: 'local',
    kind: '',
    model: config.embeddingModel,
    dim: config.embeddingDim,
  })
}

/**
 * Descriptor for the cloud slot, usable even when the slot is currently rejected:
 * `partial` keeps the model name the user typed, so fixing only the key or the
 * baseURL lands on the same space instead of creating a second one.
 */
export function cloudSpaceDescriptor(config, partial = {}) {
  return normalizeSpaceDescriptor({
    source: 'cloud',
    kind: partial.kind || '',
    model: partial.model || 'unconfigured',
    dim: config.cloudEmbeddingDim,
  })
}

function createLocalSource({ config, logger }) {
  const service = new EmbeddingService({
    modelName: config.embeddingModel,
    topicModel: config.topicModel,
    cacheDir: config.modelCacheDir || undefined,
    hfEndpoint: config.hfEndpoint || undefined,
    loadTimeoutMs: config.modelLoadTimeoutMs,
    logger,
  })
  const space = localSpaceDescriptor(config)
  return {
    source: 'local',
    model: space.model,
    dim: space.dim,
    space,
    embed: text => service.embed(text),
    embedIfReady: text => service.embedIfReady(text),
    async warmModels() { return service.warmModels() },
    status() {
      const status = service.status()
      return {
        ...status,
        source: 'local',
        kind: '',
        dim: space.dim,
        spaceId: null,
        keyConfigured: null,
        degraded: status.embedding === 'error',
      }
    },
    async probe() {
      const started = Date.now()
      try {
        const vector = await service.embed('memapalace embedding probe 向量自检')
        return {
          ok: true,
          source: 'local',
          kind: '',
          model: space.model,
          endpoint: null,
          authRef: null,
          expectedDim: space.dim,
          measuredDim: vector.length,
          latencyMs: Date.now() - started,
          error: null,
          hint: null,
        }
      } catch (error) {
        return {
          ok: false,
          source: 'local',
          kind: '',
          model: space.model,
          endpoint: null,
          authRef: null,
          expectedDim: space.dim,
          measuredDim: null,
          latencyMs: Date.now() - started,
          error: error?.message ?? String(error),
          code: error?.code ?? null,
          hint: error?.hint ?? null,
        }
      }
    },
    dispose: () => service.dispose(),
  }
}

/** Cloud source that never touches the network: every vector call reports the slot error. */
function createBrokenCloudSource({ space, error, logger }) {
  const fail = () => {
    const failure = Object.assign(new Error(error.message), { code: error.code, hint: error.hint })
    return failure
  }
  return {
    source: 'cloud',
    model: space.model,
    dim: space.dim,
    space,
    async embed() { throw fail() },
    async embedIfReady() { throw fail() },
    async warmModels() { return { embedding: 'error', topic: 'disabled', errors: [error.message] } },
    status() {
      return {
        source: 'cloud',
        embedding: 'error',
        degraded: true,
        degradedUntil: null,
        kind: space.kind,
        model: space.model,
        endpoint: null,
        authRef: null,
        keyConfigured: null,
        dim: space.dim,
        error: error.message,
        errorCode: error.code,
        hint: error.hint,
        topic: 'disabled',
        topicModel: '',
      }
    },
    async probe() {
      return {
        ok: false,
        source: 'cloud',
        kind: space.kind,
        model: space.model,
        endpoint: null,
        authRef: null,
        expectedDim: space.dim,
        measuredDim: null,
        latencyMs: 0,
        error: error.message,
        code: error.code,
        hint: error.hint,
      }
    },
    async dispose() { /* nothing to release */ },
  }
}

function createCloudSource({ config, home, logger, resolveKey, fetch, now, sleep }) {
  const read = readEmbeddingSlot({ home })
  const space = cloudSpaceDescriptor(config, read.partial)
  if (!read.ok) {
    logger?.warn?.(`dsh-mempalace: 云端向量来源不可用：${read.error.message}（${read.error.hint}）`)
    return createBrokenCloudSource({ space, error: read.error, logger })
  }
  const service = new CloudEmbeddingService({
    slot: read.slot,
    dim: space.dim,
    timeoutMs: config.cloudEmbeddingTimeoutMs,
    batchSize: config.cloudEmbeddingBatch,
    resolveKey,
    fetch,
    now,
    sleep,
    logger,
  })
  return {
    source: 'cloud',
    model: service.model,
    dim: space.dim,
    space,
    embed: text => service.embed(text),
    embedIfReady: text => service.embed(text),
    async warmModels() {
      const probe = await service.probe()
      return {
        embedding: probe.ok ? 'ready' : 'error',
        topic: 'disabled',
        errors: probe.ok ? [] : [probe.error],
        probe,
      }
    },
    status() {
      const status = service.status()
      return { ...status, spaceId: null, dim: space.dim }
    },
    probe: () => service.probe(),
    dispose: () => service.dispose(),
  }
}

/**
 * Builds the embedding source for the current config.
 *
 * @param options.config - validated plugin config.
 * @param options.home - absolute `DSH_HOME` (the gateway registry lives under it).
 * @param options.resolveKey - `async (authRef) => string | {value} | null`.
 * @returns `{source, model, dim, space, embed, embedIfReady, warmModels, status, probe, dispose}`.
 */
export function createEmbeddingSource(options = {}) {
  const config = options.config
  if (!config) throw new Error('dsh-mempalace: createEmbeddingSource requires config')
  const logger = options.logger ?? console
  return config.embeddingSource === 'cloud'
    ? createCloudSource({ ...options, logger })
    : createLocalSource({ ...options, logger })
}
