/**
 * Deterministic sensitivity gate for recall.
 *
 * Recall injects stored text into the model's context automatically, so a memory that
 * holds a key, an account number or a private-topic sentence must not be pulled in by
 * a lucky similarity match. The check is a fixed set of patterns — no service call, no
 * randomness — so the same memory is always classified the same way.
 */

const SECRET_PATTERNS = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /\b(?:sk|pk|rk)-[A-Za-z0-9_-]{16,}/,
  /\bghp_[A-Za-z0-9]{20,}/,
  /\bAKIA[0-9A-Z]{16}\b/,
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/,
  /(?:api[_-]?key|access[_-]?token|secret[_-]?key|password|passwd|密码|口令|密钥|验证码|私钥)\s*[:=：]\s*\S+/i,
]

const PII_PATTERNS = [
  /\b\d{17}[\dXx]\b/,
  /\b\d{16,19}\b/,
  /(?<!\d)1[3-9]\d{9}(?!\d)/,
]

const PRIVATE_TOPICS = [
  '裸照', '性行为', '自残', '自杀', '遗书', '病历', '诊断书', '艾滋病', '精神科',
  '工资条', '薪资明细', '银行存款', '身份证号', '银行卡号', '家庭住址', '开房记录',
]

/** @returns true when a memory must stay out of automatic recall. */
export function isSensitiveText(text) {
  const value = String(text ?? '')
  if (!value.trim()) return false
  if (SECRET_PATTERNS.some(pattern => pattern.test(value))) return true
  if (PII_PATTERNS.some(pattern => pattern.test(value))) return true
  return PRIVATE_TOPICS.some(topic => value.includes(topic))
}

/** Which class matched, for diagnostics; `null` when the text is not sensitive. */
export function classifySensitiveText(text) {
  const value = String(text ?? '')
  if (SECRET_PATTERNS.some(pattern => pattern.test(value))) return 'secret'
  if (PII_PATTERNS.some(pattern => pattern.test(value))) return 'pii'
  if (PRIVATE_TOPICS.some(topic => value.includes(topic))) return 'private-topic'
  return null
}
