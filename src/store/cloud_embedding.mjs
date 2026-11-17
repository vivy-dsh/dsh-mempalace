/**
 * OpenAI-compatible cloud embeddings (`POST {baseURL}/embeddings`).
 *
 * Failure policy is fail-closed: a missing key, a rejected request, a timeout and a
 * width that disagrees with the active space all surface as typed errors and never
 * produce a vector. A five-minute circuit breaker keeps one outage from paying the
 * network cost on every write; an explicit probe bypasses it.
 */

const DEFAULT_DEGRADE_MS = 5 * 60_000
const RETRYABLE_STATUS = new Set([408, 409, 425, 429, 500, 502, 503, 504])
const PROBE_TEXT = 'memapalace embedding probe 向量自检'

export class CloudEmbeddingError extends Error {
  constructor(code, message, hint) {
    super(message)
    this.name = 'CloudEmbeddingError'
    this.code = code
    this.hint = hint
  }
}

function errorMessage(error) {
  return error?.message ?? String(error)
}

export class CloudEmbeddingService {
  /**
   * @param options.slot - validated slot `{kind, baseURL, endpoint, model, authRef}`.
   * @param options.dim - expected vector width.
   * @param options.timeoutMs - per-request timeout.
   * @param options.batchSize - inputs per request.
   * @param options.resolveKey - `async (authRef) => string | null`.
   * @param options.fetch - `fetch` implementation (tests inject a fake).
   * @param options.now - clock, injectable for the circuit breaker.
   * @param options.sleep - delay, injectable so tests never wait.
   */
  constructor(options = {}) {
    if (!options.slot?.endpoint) throw new Error('dsh-mempalace: cloud embedding requires a validated slot')
    if (!Number.isInteger(options.dim) || options.dim <= 0) throw new Error('dsh-mempalace: cloud embedding requires a dimension')
    this.slot = options.slot
    this.dim = options.dim
    this.timeoutMs = options.timeoutMs ?? 15_000
    this.batchSize = options.batchSize ?? 16
    this.resolveKey = options.resolveKey ?? (async ref => process.env[ref] ?? null)
    this.fetch = options.fetch ?? globalThis.fetch
    this.now = options.now ?? Date.now
    this.sleep = options.sleep ?? (ms => new Promise(resolve => setTimeout(resolve, ms)))
    this.logger = options.logger ?? console
    this.degradeMs = options.degradeMs ?? DEFAULT_DEGRADE_MS
    this.degradedUntil = 0
    this.lastError = null
    this.lastHint = null
    this.lastCode = null
    this.keyConfigured = null
    this.keySource = null
  }

  get source() { return 'cloud' }
  get model() { return this.slot.model }

  status() {
    const degraded = this.now() < this.degradedUntil
    return {
      source: 'cloud',
      embedding: this.lastError ? 'error' : 'ready',
      degraded,
      degradedUntil: degraded ? new Date(this.degradedUntil).toISOString() : null,
      kind: this.slot.kind,
      model: this.slot.model,
      endpoint: this.slot.endpoint,
      authRef: this.slot.authRef,
      keyConfigured: this.keyConfigured,
      keySource: this.keySource,
      dim: this.dim,
      timeoutMs: this.timeoutMs,
      batchSize: this.batchSize,
      error: this.lastError,
      errorCode: this.lastCode,
      hint: this.lastHint,
      topic: 'disabled',
      topicModel: '',
    }
  }

  async #key() {
    let value = null
    try {
      value = await this.resolveKey(this.slot.authRef)
    } catch (error) {
      throw this.#fail('MEMPALACE_EMBEDDING_AUTH',
        `读取凭据 ${this.slot.authRef} 失败：${errorMessage(error)}`,
        '在世界网关面板重新填写该 key')
    }
    if (typeof value === 'object' && value) value = value.value
    const key = typeof value === 'string' ? value.trim() : ''
    if (!key) {
      this.keyConfigured = false
      throw this.#fail('MEMPALACE_EMBEDDING_AUTH',
        `没有可用的 ${this.slot.authRef}`,
        `在世界网关面板为 ${this.slot.kind} 填入 API Key（写入 ${this.slot.authRef}），或设置同名环境变量`)
    }
    this.keyConfigured = true
    return key
  }

  #fail(code, message, hint) {
    this.lastError = message
    this.lastHint = hint
    this.lastCode = code
    this.degradedUntil = this.now() + this.degradeMs
    const error = new CloudEmbeddingError(code, message, hint)
    this.logger.warn?.(`dsh-mempalace: ${message}${hint ? `（${hint}）` : ''}`)
    return error
  }

  async #requestOnce(batch, key, withDimensions) {
    const body = {
      model: this.slot.model,
      input: batch,
      encoding_format: 'float',
      ...withDimensions ? { dimensions: this.dim } : {},
    }
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), this.timeoutMs)
    let response
    try {
      response = await this.fetch(this.slot.endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
        body: JSON.stringify(body),
        signal: controller.signal,
      })
    } catch (error) {
      if (error?.name === 'AbortError') {
        throw Object.assign(
          new CloudEmbeddingError('MEMPALACE_EMBEDDING_TIMEOUT', `向量请求超过 ${this.timeoutMs}ms`, '检查网络或调大 cloudEmbeddingTimeoutMs'),
          { retryable: true },
        )
      }
      throw Object.assign(
        new CloudEmbeddingError('MEMPALACE_EMBEDDING_NETWORK', `无法连接 ${this.slot.endpoint}：${errorMessage(error)}`, '检查网络与 baseURL'),
        { retryable: true },
      )
    } finally {
      clearTimeout(timer)
    }
    if (!response.ok) {
      const detail = await response.text().catch(() => '')
      const summary = detail.slice(0, 300)
      if (response.status === 401 || response.status === 403) {
        throw this.#fail('MEMPALACE_EMBEDDING_AUTH',
          `向量接口拒绝凭据（HTTP ${response.status}）：${summary}`,
          `确认 ${this.slot.authRef} 是有效的 ${this.slot.kind} key，且已开通该模型`)
      }
      if (response.status === 429) {
        throw Object.assign(new CloudEmbeddingError('MEMPALACE_EMBEDDING_RATE_LIMIT', `向量接口限流（HTTP 429）：${summary}`, '稍后重试或降低重建频率'), { retryable: true })
      }
      if (response.status === 400 && /dimensions/i.test(detail)) {
        throw Object.assign(new CloudEmbeddingError('MEMPALACE_EMBEDDING_DIMENSIONS_UNSUPPORTED', `接口不接受 dimensions=该项目：${summary}`, '改用支持自定义维度的模型，或接受默认维度并在配置里对齐', ), { retryWithoutDimensions: true })
      }
      throw Object.assign(
        new CloudEmbeddingError('MEMPALACE_EMBEDDING_HTTP', `向量接口返回 HTTP ${response.status}：${summary}`, '查看世界网关的接入点与模型名'),
        { retryable: RETRYABLE_STATUS.has(response.status) },
      )
    }
    let payload
    try {
      payload = await response.json()
    } catch (error) {
      throw this.#fail('MEMPALACE_EMBEDDING_RESPONSE', `向量接口返回的不是 JSON：${errorMessage(error)}`, '确认 baseURL 指向 OpenAI 兼容端点')
    }
    const items = Array.isArray(payload?.data) ? [...payload.data].sort((a, b) => (a?.index ?? 0) - (b?.index ?? 0)) : null
    if (!items || items.length !== batch.length) {
      throw this.#fail('MEMPALACE_EMBEDDING_RESPONSE',
        `向量接口返回 ${items?.length ?? 0} 条，期望 ${batch.length} 条`, '确认模型一次能处理整批输入；可调小 cloudEmbeddingBatch')
    }
    return items.map(item => {
      const vector = Float32Array.from(Array.isArray(item?.embedding) ? item.embedding : [])
      if (vector.length !== this.dim) {
        throw this.#fail('MEMPALACE_SPACE_MISMATCH',
          `云端返回 ${vector.length} 维，当前空间是 ${this.dim} 维`,
          `把 cloudEmbeddingDim 改成 ${vector.length} 后重建索引（会新建一个空间，旧空间保留）`)
      }
      return vector
    })
  }

  async #embedBatch(batch, key) {
    let withDimensions = true
    for (let attempt = 0; ; attempt += 1) {
      try {
        return await this.#requestOnce(batch, key, withDimensions)
      } catch (error) {
        if (error?.retryWithoutDimensions && withDimensions) {
          withDimensions = false
          continue
        }
        if (error?.retryable && attempt === 0) {
          await this.sleep(400)
          continue
        }
        throw error
      }
    }
  }

  /** Embeds one text; throws a typed error and never returns a placeholder vector. */
  async embed(text) {
    const [vector] = await this.embedMany([String(text ?? '')])
    return vector
  }

  /** Embeds texts in batches; one rejected batch fails the whole call (no partial index). */
  async embedMany(texts) {
    if (this.now() < this.degradedUntil) {
      const error = new CloudEmbeddingError(this.lastCode ?? 'MEMPALACE_EMBEDDING_UNAVAILABLE',
        this.lastError ?? '云端向量服务暂不可用', this.lastHint ?? null)
      throw error
    }
    if (!Array.isArray(texts) || texts.length === 0) return []
    const key = await this.#key()
    const vectors = []
    for (let index = 0; index < texts.length; index += this.batchSize) {
      vectors.push(...await this.#embedBatch(texts.slice(index, index + this.batchSize), key))
    }
    this.lastError = null
    this.lastHint = null
    this.lastCode = null
    this.degradedUntil = 0
    return vectors
  }

  /** One real round trip that also reports the measured width; never writes to the store. */
  async probe() {
    const started = this.now()
    this.degradedUntil = 0
    try {
      const key = await this.#key()
      const vectors = await this.#embedBatch([PROBE_TEXT], key)
      this.lastError = null
      this.lastHint = null
      this.lastCode = null
      return {
        ok: true,
        source: 'cloud',
        kind: this.slot.kind,
        model: this.slot.model,
        endpoint: this.slot.endpoint,
        authRef: this.slot.authRef,
        expectedDim: this.dim,
        measuredDim: vectors[0].length,
        latencyMs: Math.max(0, this.now() - started),
        error: null,
        hint: null,
      }
    } catch (error) {
      return {
        ok: false,
        source: 'cloud',
        kind: this.slot.kind,
        model: this.slot.model,
        endpoint: this.slot.endpoint,
        authRef: this.slot.authRef,
        expectedDim: this.dim,
        measuredDim: null,
        latencyMs: Math.max(0, this.now() - started),
        error: errorMessage(error),
        code: error?.code ?? null,
        hint: error?.hint ?? null,
      }
    }
  }

  async dispose() {
    this.degradedUntil = 0
    this.lastError = null
  }
}
