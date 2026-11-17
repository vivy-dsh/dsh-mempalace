/**
 * Renders recalled memories as one labelled context block.
 *
 * The footer is part of the block, not a convention: the model must treat these as
 * possibly-relevant old notes instead of current facts, and the whole block is
 * dropped (never emitted empty) when nothing clears the threshold.
 */

export const RECALL_HEADER = '【想起的旧事】（可能相关的旧记忆，仅供参考）'
export const RECALL_FOOTER = '（以上是可能相关的旧事，不是当前事实；记不清就说记不清，不要编。）'

const MAX_LINE_CHARS = 180

function lineFor(item) {
  const date = String(item.timestamp ?? '').slice(0, 10)
  const room = [item.project, item.topic].filter(Boolean).join('/')
  const score = Number(item.score)
  const badge = Number.isFinite(score) ? ` (${score.toFixed(2)})` : ''
  const content = String(item.text ?? '').replace(/\s+/g, ' ').trim()
  const body = content.length > MAX_LINE_CHARS ? `${content.slice(0, MAX_LINE_CHARS)}…` : content
  const head = [room && `[${room}]`, date].filter(Boolean).join(' ')
  return head ? `- ${head}${badge} ${body}` : `- ${body}`
}

/**
 * @param items - recalled memories, best first.
 * @param options.maxChars - budget for the whole block, footer included.
 * @returns the block, or `''` when no line fits.
 */
export function renderRecallBlock(items, { maxChars = 600 } = {}) {
  const list = Array.isArray(items) ? items : []
  if (list.length === 0) return ''
  const budget = Math.max(200, Number(maxChars) || 600)
  const lines = []
  let used = RECALL_HEADER.length + RECALL_FOOTER.length + 2
  for (const item of list) {
    const line = lineFor(item)
    if (!line.trim()) continue
    if (used + line.length + 1 > budget) break
    lines.push(line)
    used += line.length + 1
  }
  if (lines.length === 0) return ''
  return [RECALL_HEADER, ...lines, RECALL_FOOTER].join('\n')
}
