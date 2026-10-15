/**
 * 機密情報の不用意な送信を防ぐためのマスキング (純粋関数)。
 * AI へ返すテキスト (クリップボード・ファイル内容・UI 要素の値など) に適用する。
 */

interface Rule {
  name: string;
  pattern: RegExp;
  validate?: (m: string) => boolean;
}

function luhn(num: string): boolean {
  const digits = num.replace(/\D/g, '');
  if (digits.length < 13 || digits.length > 19) return false;
  let sum = 0;
  let dbl = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let d = digits.charCodeAt(i) - 48;
    if (dbl) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    dbl = !dbl;
  }
  return sum % 10 === 0;
}

const RULES: Rule[] = [
  { name: 'Anthropic API キー', pattern: /\bsk-ant-[A-Za-z0-9_-]{20,}\b/g },
  { name: 'OpenAI API キー', pattern: /\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}\b/g },
  { name: 'OpenRouter API キー', pattern: /\bsk-or-[A-Za-z0-9_-]{20,}\b/g },
  { name: 'Google API キー', pattern: /\bAIza[0-9A-Za-z_-]{35}\b/g },
  { name: 'GitHub トークン', pattern: /\b(?:ghp|gho|ghu|ghs|ghr|github_pat)_[A-Za-z0-9_]{20,}\b/g },
  { name: 'AWS アクセスキー', pattern: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g },
  { name: 'Slack トークン', pattern: /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/g },
  { name: '秘密鍵', pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g },
  { name: 'JWT', pattern: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g },
  {
    name: 'クレジットカード番号',
    pattern: /\b(?:\d[ -]?){12,18}\d\b/g,
    validate: luhn,
  },
  {
    name: 'パスワード',
    pattern: /((?:password|passwd|pwd|パスワード|暗証番号)\s*[:=：]\s*)(\S+)/gi,
  },
];

export interface RedactResult {
  text: string;
  redactions: string[];
}

export function redactSecrets(text: string): RedactResult {
  let out = text;
  const found = new Set<string>();
  for (const rule of RULES) {
    out = out.replace(rule.pattern, (match: string, ...groups: unknown[]) => {
      if (rule.validate && !rule.validate(match)) return match;
      found.add(rule.name);
      if (rule.name === 'パスワード' && typeof groups[0] === 'string') return `${groups[0]}[マスク済み]`;
      return `[マスク済み: ${rule.name}]`;
    });
  }
  return { text: out, redactions: [...found] };
}

/** ウィンドウタイトルがブロック対象キーワードを含むか */
export function matchBlockedKeyword(title: string, keywords: string[]): string | null {
  const t = title.toLowerCase();
  for (const k of keywords) {
    const kw = k.trim().toLowerCase();
    if (kw && t.includes(kw)) return k;
  }
  return null;
}
