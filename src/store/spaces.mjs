/**
 * Embedding-space naming for the memory store.
 *
 * One vector space = one model + one width. sqlite-vec keeps a fixed dimension per
 * table, so every space owns its own `vec0` table and the registry records which
 * table belongs to which space. Space ids are derived from the descriptor, which
 * makes "same model + same width" collapse onto the same space on every restart.
 */

export const MIN_EMBEDDING_DIM = 64
export const MAX_EMBEDDING_DIM = 4096

/** `local-xenova-all-minilm-l6-v2@384` / `cloud-dashscope-text-embedding-v4@512`. */
export const SPACE_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}@[0-9]{2,4}$/

/** The legacy table (`vec_memories`) plus one table per space. */
export const VEC_TABLE_PATTERN = /^vec_memories(?:_[a-z0-9_]{1,80})?$/

const SPACE_TABLE_PREFIX = 'vec_memories_'
const MAX_SLUG = 40

/** The single-table name used before spaces existed; adopted, never created again. */
export const LEGACY_VEC_TABLE = 'vec_memories'

/** Model behind `EMBEDDING_DIM`; the store's default local space. */
export const DEFAULT_LOCAL_MODEL = 'Xenova/all-MiniLM-L6-v2'

export function assertEmbeddingDim(dim, field = 'embeddingDim') {
  const value = Number(dim)
  if (!Number.isInteger(value) || value < MIN_EMBEDDING_DIM || value > MAX_EMBEDDING_DIM) {
    throw new Error(`dsh-mempalace: ${field} must be an integer between ${MIN_EMBEDDING_DIM} and ${MAX_EMBEDDING_DIM}`)
  }
  return value
}

/** Lowercase ASCII slug used in space ids and table names. */
export function slugifyModel(model) {
  const slug = String(model ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, MAX_SLUG)
    .replace(/-+$/g, '')
  return slug || 'unknown'
}

/**
 * Space id for one embedding descriptor.
 * Cloud spaces carry the provider kind so two providers serving a same-named model
 * never collide onto one table.
 */
export function spaceIdFor({ source = 'local', kind = '', model = '', dim } = {}) {
  const width = assertEmbeddingDim(dim)
  const provider = String(source).toLowerCase()
  if (provider !== 'local' && provider !== 'cloud') {
    throw new Error(`dsh-mempalace: embedding source must be local or cloud, got ${source}`)
  }
  const parts = [provider]
  if (provider === 'cloud' && kind) parts.push(slugifyModel(kind))
  parts.push(slugifyModel(model))
  const id = `${parts.join('-')}@${width}`
  if (!SPACE_ID_PATTERN.test(id)) throw new Error(`dsh-mempalace: derived space id is invalid: ${id}`)
  return id
}

export function isSpaceId(value) {
  return typeof value === 'string' && SPACE_ID_PATTERN.test(value)
}

export function isVecTableName(value) {
  return typeof value === 'string' && VEC_TABLE_PATTERN.test(value)
}

/**
 * Physical table for a space. Two distinct space ids can sanitize onto one name
 * (`.` vs `-`), so `taken` receives the already-registered names and a digest
 * suffix keeps them apart without ever renaming an existing table.
 */
export function vecTableFor(spaceId, taken = new Set()) {
  if (!isSpaceId(spaceId)) throw new Error(`dsh-mempalace: invalid space id: ${spaceId}`)
  const base = `${SPACE_TABLE_PREFIX}${spaceId.replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '')}`
  if (!taken.has(base)) return base
  const suffix = createSuffix(spaceId)
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const candidate = `${base}_${attempt === 0 ? suffix : `${suffix}${attempt}`}`
    if (!taken.has(candidate) && isVecTableName(candidate)) return candidate
  }
  throw new Error(`dsh-mempalace: cannot derive a free vector table name for ${spaceId}`)
}

function createSuffix(spaceId) {
  let hash = 0
  for (const char of spaceId) {
    hash = (hash * 31 + char.codePointAt(0)) % 0xfffffff
  }
  return hash.toString(16).padStart(6, '0').slice(-6)
}

/** Read the width out of a `vec0(embedding float[N])` DDL string. */
export function parseVecTableDim(sql) {
  if (typeof sql !== 'string') return null
  const match = /float\s*\[\s*(\d+)\s*\]/i.exec(sql)
  if (!match) return null
  const dim = Number(match[1])
  return Number.isInteger(dim) && dim > 0 ? dim : null
}

/** Descriptor for the pre-multi-space table, which always held the local model's output. */
export function legacySpaceDescriptor({ dim, model }) {
  return { source: 'local', kind: '', model, dim: assertEmbeddingDim(dim) }
}

/** Stable identity of a descriptor, used to match config against registry rows. */
export function sameSpace(left, right) {
  return Boolean(left && right)
    && left.source === right.source
    && (left.kind ?? '') === (right.kind ?? '')
    && left.model === right.model
    && Number(left.dim) === Number(right.dim)
}

export function normalizeSpaceDescriptor(input = {}) {
  const source = String(input.source ?? 'local').toLowerCase()
  if (source !== 'local' && source !== 'cloud') {
    throw new Error(`dsh-mempalace: embedding source must be local or cloud, got ${input.source}`)
  }
  const dim = assertEmbeddingDim(input.dim, source === 'cloud' ? 'cloudEmbeddingDim' : 'embeddingDim')
  return {
    source,
    kind: source === 'cloud' ? String(input.kind ?? '').trim().toLowerCase() : '',
    model: String(input.model ?? '').trim(),
    dim,
  }
}
