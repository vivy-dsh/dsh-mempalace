/**
 * Read-only view of the world gateway's `embedding` slot.
 *
 * The gateway (`plugins/capability-hub`) owns the registry file and the UI that
 * writes it; this module only parses the same file with the same rules and turns
 * a bad slot into an actionable error instead of a silent fallback. It never
 * writes, and it never reads a credential value.
 */

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

/** Providers whose embedding endpoint speaks the OpenAI-compatible shape. */
export const EMBEDDING_KIND_ENDPOINTS = Object.freeze({
  dashscope: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
  siliconflow: 'https://api.siliconflow.cn/v1',
})

/** Kinds the gateway knows but which expose no embedding endpoint. */
export const UNSUPPORTED_KINDS = Object.freeze(['qwen-token-plan', 'minimax'])

const AUTH_REF_RE = /^[A-Z][A-Z0-9_]{1,127}$/
const PLACEHOLDER_RE = /\{[^}]*\}/

export function capabilityRegistryPath(home) {
  return join(home, 'capability-hub', 'registry.json')
}

/** Same rule as the gateway and the harness: `dashscope` → `DASHSCOPE_API_KEY`. */
export function deriveAuthRef(kind) {
  return `${String(kind ?? '').toUpperCase().replace(/[^A-Z0-9]+/g, '_')}_API_KEY`
}

export function endpointHint(kind) {
  const known = EMBEDDING_KIND_ENDPOINTS[kind]
  return known ? `把 baseURL 改成 ${known}` : `可用接入点：${Object.keys(EMBEDDING_KIND_ENDPOINTS).join(' / ')}`
}

/**
 * Reads the gateway's embedding slot.
 *
 * @param options.home - absolute `DSH_HOME`; the registry lives under it.
 * @returns `{ok, slot, partial, error}`. `partial` is always filled from the file
 *   (when parseable) so the caller can still name a stable vector space while the
 *   slot is rejected; `error` carries `{code, message, hint}` in Chinese.
 */
export function readEmbeddingSlot({ home } = {}) {
  const empty = { enabled: false, kind: '', baseURL: '', model: '', authRef: '' }
  const fail = (partial, code, message, hint) => ({
    ok: false,
    slot: null,
    partial,
    error: { code, message, hint },
  })
  if (!home) {
    return fail(empty, 'MEMPALACE_SLOT_MISSING', '无法定位 DSH_HOME，云端向量来源不可用', '确认 DSH_HOME 指向本安装的状态目录后重启')
  }
  const file = capabilityRegistryPath(home)
  if (!existsSync(file)) {
    return fail(empty, 'MEMPALACE_SLOT_MISSING',
      `世界网关尚未写入 ${file}`,
      '在世界网关面板启用「向量化」插槽并保存后重试')
  }
  let parsed
  try {
    parsed = JSON.parse(readFileSync(file, 'utf-8'))
  } catch (error) {
    return fail(empty, 'MEMPALACE_SLOT_INVALID',
      `世界网关的 registry.json 无法解析：${error?.message ?? error}`,
      '在世界网关面板重新保存「向量化」插槽（损坏文件会被网关改名备份）')
  }
  const raw = parsed?.slots?.embedding
  const partial = {
    enabled: raw?.enabled === true,
    kind: typeof raw?.kind === 'string' ? raw.kind.trim() : '',
    baseURL: typeof raw?.baseURL === 'string' ? raw.baseURL.trim() : '',
    model: typeof raw?.model === 'string' ? raw.model.trim() : '',
    authRef: typeof raw?.authRef === 'string' ? raw.authRef.trim() : '',
  }
  if (!raw) {
    return fail(partial, 'MEMPALACE_SLOT_MISSING',
      '世界网关里没有 embedding 插槽',
      '在世界网关面板启用「向量化」插槽并保存后重试')
  }
  if (!partial.enabled) {
    return fail(partial, 'MEMPALACE_SLOT_DISABLED',
      '世界网关的「向量化」插槽未启用',
      '在世界网关面板打开「向量化」的启用开关并保存')
  }
  if (!EMBEDDING_KIND_ENDPOINTS[partial.kind]) {
    const known = UNSUPPORTED_KINDS.includes(partial.kind) ? `（${partial.kind} 没有向量化接口）` : ''
    return fail(partial, 'MEMPALACE_SLOT_KIND_UNSUPPORTED',
      `接入点类型 ${partial.kind || '(空)'} 不支持向量化${known}`,
      endpointHint(partial.kind))
  }
  if (PLACEHOLDER_RE.test(partial.baseURL)) {
    return fail(partial, 'MEMPALACE_SLOT_PLACEHOLDER',
      `baseURL 仍是占位符 ${partial.baseURL}`,
      `填真实工作区地址；个人 API Key 可直接用 ${EMBEDDING_KIND_ENDPOINTS[partial.kind]}`)
  }
  if (!/^https:\/\//.test(partial.baseURL) || /\s/.test(partial.baseURL)) {
    return fail(partial, 'MEMPALACE_SLOT_INVALID', 'baseURL 必须以 https:// 开头且不含空白字符', endpointHint(partial.kind))
  }
  if (!partial.model) {
    return fail(partial, 'MEMPALACE_SLOT_INVALID', '插槽缺少模型名', '在世界网关面板填写模型名（例如 text-embedding-v4）')
  }
  if (partial.authRef && !AUTH_REF_RE.test(partial.authRef)) {
    return fail(partial, 'MEMPALACE_SLOT_INVALID',
      `凭据引用名 ${partial.authRef} 不合规`,
      '凭据引用名只能是大写字母、数字与下划线，且以字母开头')
  }
  const baseURL = partial.baseURL.replace(/\/+$/, '')
  const kind = partial.kind
  return {
    ok: true,
    partial,
    error: null,
    slot: {
      kind,
      baseURL,
      endpoint: `${baseURL}/embeddings`,
      model: partial.model,
      authRef: partial.authRef || deriveAuthRef(kind),
    },
  }
}
